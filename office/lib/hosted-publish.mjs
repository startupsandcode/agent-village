import { artifactDigest, verifyStaticSite } from './static-site.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { publishReviewedSite } from './publish-github.mjs';
import { deployReviewedPreview, inspectPreviewDeployment, verifyDeletedVercelAttempt, UnsafeVercelDeploymentError } from './publish-vercel.mjs';

const sha = /^[a-f0-9]{64}$/;
const name = /^[a-z0-9][a-z0-9-]{1,62}$/;
const gitOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const gitRepo = /^[A-Za-z0-9._-]{1,100}$/;
const gitBranch = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RECONCILE_MIN_AGE_MS = 15 * 60_000; // exceeds this pilot's five-minute Vercel Function limit

function sameAttempt(previous, claim) {
  return previous?.status === 'submitting' && previous.attemptId === claim.attemptId && previous.startedAt === claim.startedAt;
}

function target(env, service) {
  if (service === 'github') {
    const { VILLAGE_PUBLISH_GITHUB_OWNER: owner, VILLAGE_PUBLISH_GITHUB_REPO: repo,
      VILLAGE_PUBLISH_GITHUB_BRANCH: branch, VILLAGE_PUBLISH_GITHUB_TOKEN: token,
      VILLAGE_PUBLISH_GITHUB_DEDICATED_REPO_CONFIRMED: confirmed } = env;
    const destination = { owner, repo, branch };
    return { ...destination, fingerprint: createHash('sha256').update(JSON.stringify({ service, destination })).digest('hex'),
      available: Boolean(token && confirmed === 'true' && gitOwner.test(owner ?? '') && gitRepo.test(repo ?? '') && !repo.includes('..') &&
      gitBranch.test(branch ?? '') && !branch.includes('..')) };
  }
  const { VILLAGE_PUBLISH_VERCEL_TEAM: team, VILLAGE_PUBLISH_VERCEL_PROJECT: project,
    VILLAGE_PUBLISH_VERCEL_TOKEN: token } = env;
  const destination = { team, project };
  return { ...destination, fingerprint: createHash('sha256').update(JSON.stringify({ service, destination })).digest('hex'),
    available: Boolean(token && name.test(team ?? '') && name.test(project ?? '')) };
}
function reviewed(record, expectedSha) {
  const project = record?.snapshot;
  if (!project || project.status !== 'reviewed' || !project.files || !sha.test(project.artifact?.sha256 ?? '') ||
      project.artifact.sha256 !== expectedSha || artifactDigest(project.files.html, project.files.css) !== expectedSha ||
      !project.events?.some(entry => entry.agent === 'Quinn' && entry.type === 'review' && entry.reviewedSha256 === expectedSha)) {
    throw new Error('Reviewed artifact receipt required');
  }
  verifyStaticSite(project.files.html, project.files.css);
  return project;
}
function publicReceipt(value) {
  if (!value) return null;
  return { status: value.status, service: value.service, target: value.target,
    artifactSha256: value.artifactSha256, startedAt: value.startedAt, attemptId: value.attemptId ?? null,
    ...(value.receipt ? { receipt: value.receipt } : {}) };
}

export function createHostedPublisher({ access, env, githubPublisher = publishReviewedSite,
  vercelPublisher = deployReviewedPreview, deploymentInspector = inspectPreviewDeployment,
  deletionVerifier = verifyDeletedVercelAttempt, now = Date.now } = {}) {
  if (!access || !env) throw new Error('Hosted publishing dependencies required');
  async function read(cookie, id) {
    const record = await access.read(cookie, id);
    if (!record) throw new Error('Project not found');
    return record;
  }
  return {
    async reconcileVercel(cookie, id, expectedSha, displayedFingerprint, deletedDeploymentId, baselineDeploymentId,
      attemptStartedAt, attemptId) {
      const configured = target(env, 'vercel');
      if (!sha.test(displayedFingerprint ?? '') || displayedFingerprint !== configured.fingerprint) throw new Error('Publish target changed; refresh status');
      if (!configured.available) throw new Error('Vercel publishing is not configured');
      const current = await read(cookie, id);
      reviewed(current, expectedSha);
      const previous = current.snapshot.publishing?.vercel;
      if (previous?.artifactSha256 !== expectedSha || JSON.stringify(previous?.target) !== JSON.stringify(configured)) {
        throw new Error('Publish target or reviewed receipt changed');
      }
      if (previous.startedAt !== attemptStartedAt || (previous.attemptId ?? null) !== attemptId) {
        throw new Error('Vercel publish attempt changed; refresh status');
      }
      if (previous.status === 'reconciled' && previous.receipt?.deletedDeploymentId === deletedDeploymentId &&
          previous.receipt?.baselineDeploymentId === baselineDeploymentId) return publicReceipt(previous);
      if (previous.status !== 'submitting') throw new Error('Only an uncertain Vercel submission can be reconciled');
      const lastActivity = Date.parse(previous.submitAuthorizedAt ?? previous.startedAt);
      if (!Number.isFinite(lastActivity) || now() - lastActivity < RECONCILE_MIN_AGE_MS) {
        throw new Error('Vercel submission may still be active; wait before reconciling');
      }
      const receipt = await deletionVerifier({ team: configured.team, project: configured.project,
        token: env.VILLAGE_PUBLISH_VERCEL_TOKEN, deletedDeploymentId, baselineDeploymentId });
      if (receipt.deletedDeploymentId !== deletedDeploymentId || receipt.baselineDeploymentId !== baselineDeploymentId ||
          !/^prj_[A-Za-z0-9_-]{4,80}$/.test(receipt.projectId ?? '')) throw new Error('Vercel deletion evidence changed');
      const next = structuredClone(current.snapshot);
      next.publishing.vercel = { ...previous, status: 'reconciled', receipt };
      next.events.push({ at: new Date().toISOString(), agent: 'System', type: 'publish_reconciled',
        message: `Operator-supplied Vercel deployment ${deletedDeploymentId} is absent; protected inert baseline ${baselineDeploymentId} is the sole deployment. A new explicit Preview submission is permitted.`,
        receiptId: deletedDeploymentId, artifactSha256: expectedSha });
      const saved = await access.update(cookie, { id, expectedVersion: current.version, snapshot: next });
      if (!saved) throw new Error('Publish claim changed; inspect status');
      return publicReceipt(next.publishing.vercel);
    },
    async status(cookie, id) {
      const record = await read(cookie, id);
      const project = record.snapshot;
      const targets = { github: target(env, 'github'), vercel: target(env, 'vercel') };
      const receipts = { github: publicReceipt(project.publishing?.github), vercel: publicReceipt(project.publishing?.vercel) };
      if (receipts.vercel?.status === 'submitted' && env.VILLAGE_PUBLISH_VERCEL_TOKEN) {
        try { receipts.vercel.receipt = await deploymentInspector({ receipt: receipts.vercel.receipt, token: env.VILLAGE_PUBLISH_VERCEL_TOKEN }); }
        catch { receipts.vercel.receipt = { ...receipts.vercel.receipt, lastObservedState: receipts.vercel.receipt.state, state: 'STATUS_UNAVAILABLE' }; }
      }
      return { projectId: id, artifactSha256: project.artifact?.sha256 ?? null, reviewed: project.status === 'reviewed', targets, receipts };
    },
    async publish(cookie, id, service, expectedSha, displayedFingerprint) {
      if (!['github', 'vercel'].includes(service)) throw new Error('Invalid publish action');
      const configured = target(env, service);
      if (!sha.test(displayedFingerprint ?? '') || displayedFingerprint !== configured.fingerprint) throw new Error('Publish target changed; refresh status');
      if (!configured.available) throw new Error(`${service === 'github' ? 'GitHub' : 'Vercel'} publishing is not configured`);
      let claim, captured, expectedSoleBaselineId = null, priorReconciled = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(cookie, id);
        const project = reviewed(current, expectedSha);
        const existing = project.publishing?.[service];
        if (existing) {
          if (existing.artifactSha256 !== expectedSha || JSON.stringify(existing.target) !== JSON.stringify(configured)) throw new Error('Publish target or reviewed receipt changed');
          if (existing.status !== 'reconciled') return publicReceipt(existing);
          expectedSoleBaselineId = existing.receipt?.baselineDeploymentId;
          if (!/^dpl_[A-Za-z0-9_-]{4,80}$/.test(expectedSoleBaselineId ?? '')) throw new Error('Reconciliation baseline missing');
          priorReconciled = existing;
        }
        captured = { html: project.files.html, css: project.files.css, sha256: expectedSha };
        const next = structuredClone(project);
        next.publishing ??= {};
        claim = { status: 'submitting', service, target: configured, artifactSha256: expectedSha,
          startedAt: new Date(now()).toISOString(), attemptId: randomUUID() };
        next.publishing[service] = claim;
        next.events.push({ at: claim.startedAt, agent: 'User', type: 'publish_start', message: `Requested ${service === 'github' ? 'GitHub branch' : 'Vercel Preview'} publication for reviewed SHA-256 ${expectedSha}` });
        const saved = await access.update(cookie, { id, expectedVersion: current.version, snapshot: next });
        if (saved) break;
        claim = null;
      }
      if (!claim) throw new Error('Publish claim changed; inspect status');
      // The durable submitting claim prevents a second write if the function dies
      // after the external API accepts a request but before a receipt is saved.
      let externalUpdateAttempted = false;
      let receipt;
      const authorizeExternalAttempt = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await read(cookie, id);
          const previous = current.snapshot.publishing?.[service];
          if (!sameAttempt(previous, claim) || previous.submitAuthorizedAt) throw new Error('Publish claim changed; inspect status');
          const next = structuredClone(current.snapshot);
          next.publishing[service] = { ...previous, submitAuthorizedAt: new Date(now()).toISOString() };
          if (await access.update(cookie, { id, expectedVersion: current.version, snapshot: next })) {
            externalUpdateAttempted = true;
            return;
          }
        }
        throw new Error('Publish claim changed; inspect status');
      };
      try {
        receipt = service === 'github'
          ? await githubPublisher({ snapshot: captured, owner: configured.owner, repo: configured.repo, branch: configured.branch, token: env.VILLAGE_PUBLISH_GITHUB_TOKEN,
            onBeforeRefUpdate: authorizeExternalAttempt })
          : await vercelPublisher({ engine: { get: async () => ({ status: 'reviewed', artifact: { sha256: expectedSha } }), artifact: async (_id, file) => file === 'index.html' ? captured.html : captured.css },
            id, team: configured.team, project: configured.project, token: env.VILLAGE_PUBLISH_VERCEL_TOKEN,
            expectedSoleBaselineId,
            onBeforeSubmit: authorizeExternalAttempt });
      } catch (error) {
        if (service === 'vercel' && externalUpdateAttempted && error instanceof UnsafeVercelDeploymentError) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const current = await read(cookie, id);
            const previous = current.snapshot.publishing?.vercel;
            if (!sameAttempt(previous, claim)) break;
            const next = structuredClone(current.snapshot);
            next.publishing.vercel = { ...claim, status: 'needs_inspection', receipt: error.receipt };
            next.events.push({ at: new Date().toISOString(), agent: 'System', type: 'publish_unsafe',
              message: `Vercel returned ${error.receipt.target} deployment ${error.receipt.deploymentId}; inspect target and protection. Automatic retry is blocked.`,
              receiptId: error.receipt.deploymentId, artifactSha256: expectedSha });
            if (await access.update(cookie, { id, expectedVersion: current.version, snapshot: next })) throw error;
          }
          throw new Error('Unsafe Vercel deployment receipt could not be saved; inspect the configured target');
        }
        if (externalUpdateAttempted) throw error; // Outcome may be unknown; retain durable claim.
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await read(cookie, id);
          const previous = current.snapshot.publishing?.[service];
          if (!sameAttempt(previous, claim)) break;
          const next = structuredClone(current.snapshot);
          if (priorReconciled) next.publishing[service] = priorReconciled;
          else delete next.publishing[service];
          next.events.push({ at: new Date().toISOString(), agent: 'System', type: 'publish_error',
            message: service === 'github' ? 'GitHub publish stopped before a branch update was attempted; inspect the target and retry.'
              : 'Vercel publish stopped before a deployment request was attempted; inspect the target and retry.' });
          if (await access.update(cookie, { id, expectedVersion: current.version, snapshot: next })) {
            throw new Error('Publishing stopped before target update; setup can be corrected and retried');
          }
        }
        throw new Error('Publish claim changed; inspect status');
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(cookie, id);
        const previous = current.snapshot.publishing?.[service];
        if (!sameAttempt(previous, claim) || previous.artifactSha256 !== expectedSha) throw new Error('Publish receipt changed; inspect target');
        const next = structuredClone(current.snapshot);
        next.publishing[service] = { ...claim, status: 'submitted', receipt };
        next.events.push({ at: new Date().toISOString(), agent: 'System', type: 'publish',
          message: service === 'github' ? `GitHub branch ${configured.owner}/${configured.repo}:${configured.branch} now points to commit ${receipt.commitSha}`
            : `Vercel Preview ${configured.team}/${configured.project} accepted deployment ${receipt.deploymentId}; last observed ${receipt.state}`,
          artifactSha256: expectedSha, receiptId: service === 'github' ? receipt.commitSha : receipt.deploymentId, url: receipt.url });
        const saved = await access.update(cookie, { id, expectedVersion: current.version, snapshot: next });
        if (saved) return publicReceipt(next.publishing[service]);
      }
      throw new Error('Publish receipt could not be saved; inspect target');
    },
  };
}
