import { artifactDigest, verifyStaticSite } from './static-site.mjs';
import { publishReviewedSite } from '../../local/publish-github.mjs';
import { deployReviewedPreview, inspectPreviewDeployment } from '../../local/publish-vercel.mjs';

const sha = /^[a-f0-9]{64}$/;
const name = /^[a-z0-9][a-z0-9-]{1,62}$/;
const gitOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const gitRepo = /^[A-Za-z0-9._-]{1,100}$/;
const gitBranch = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function target(env, service) {
  if (service === 'github') {
    const { VILLAGE_PUBLISH_GITHUB_OWNER: owner, VILLAGE_PUBLISH_GITHUB_REPO: repo,
      VILLAGE_PUBLISH_GITHUB_BRANCH: branch, VILLAGE_PUBLISH_GITHUB_TOKEN: token,
      VILLAGE_PUBLISH_GITHUB_DEDICATED_REPO_CONFIRMED: confirmed } = env;
    return { owner, repo, branch, available: Boolean(token && confirmed === 'true' && gitOwner.test(owner ?? '') && gitRepo.test(repo ?? '') && !repo.includes('..') &&
      gitBranch.test(branch ?? '') && !branch.includes('..')) };
  }
  const { VILLAGE_PUBLISH_VERCEL_TEAM: team, VILLAGE_PUBLISH_VERCEL_PROJECT: project,
    VILLAGE_PUBLISH_VERCEL_TOKEN: token } = env;
  return { team, project, available: Boolean(token && name.test(team ?? '') && name.test(project ?? '')) };
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
    artifactSha256: value.artifactSha256, ...(value.receipt ? { receipt: value.receipt } : {}) };
}

export function createHostedPublisher({ access, env, githubPublisher = publishReviewedSite,
  vercelPublisher = deployReviewedPreview, deploymentInspector = inspectPreviewDeployment } = {}) {
  if (!access || !env) throw new Error('Hosted publishing dependencies required');
  async function read(cookie, id) {
    const record = await access.read(cookie, id);
    if (!record) throw new Error('Project not found');
    return record;
  }
  return {
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
    async publish(cookie, id, service, expectedSha) {
      if (!['github', 'vercel'].includes(service)) throw new Error('Invalid publish action');
      const configured = target(env, service);
      if (!configured.available) throw new Error(`${service === 'github' ? 'GitHub' : 'Vercel'} publishing is not configured`);
      let claim, captured;
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(cookie, id);
        const project = reviewed(current, expectedSha);
        const existing = project.publishing?.[service];
        if (existing) {
          if (existing.artifactSha256 !== expectedSha || JSON.stringify(existing.target) !== JSON.stringify(configured)) throw new Error('Publish target or reviewed receipt changed');
          return publicReceipt(existing);
        }
        captured = { html: project.files.html, css: project.files.css, sha256: expectedSha };
        const next = structuredClone(project);
        next.publishing ??= {};
        claim = { status: 'submitting', service, target: configured, artifactSha256: expectedSha, startedAt: new Date().toISOString() };
        next.publishing[service] = claim;
        next.events.push({ at: claim.startedAt, agent: 'User', type: 'publish_start', message: `Requested ${service === 'github' ? 'GitHub branch' : 'Vercel Preview'} publication for reviewed SHA-256 ${expectedSha}` });
        const saved = await access.update(cookie, { id, expectedVersion: current.version, snapshot: next });
        if (saved) break;
        claim = null;
      }
      if (!claim) throw new Error('Publish claim changed; inspect status');
      // The durable submitting claim prevents a second write if the function dies
      // after the external API accepts a request but before a receipt is saved.
      const receipt = service === 'github'
        ? await githubPublisher({ snapshot: captured, owner: configured.owner, repo: configured.repo, branch: configured.branch, token: env.VILLAGE_PUBLISH_GITHUB_TOKEN })
        : await vercelPublisher({ engine: { get: async () => ({ status: 'reviewed', artifact: { sha256: expectedSha } }), artifact: async (_id, file) => file === 'index.html' ? captured.html : captured.css },
          id, team: configured.team, project: configured.project, token: env.VILLAGE_PUBLISH_VERCEL_TOKEN });
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(cookie, id);
        const previous = current.snapshot.publishing?.[service];
        if (previous?.status !== 'submitting' || previous.artifactSha256 !== expectedSha) throw new Error('Publish receipt changed; inspect target');
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
