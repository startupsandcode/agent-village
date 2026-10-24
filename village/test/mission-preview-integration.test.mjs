import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MayaMissionIntake } from '../mission-intake.mjs';
import { MissionCodexHandlers } from '../mission-codex.mjs';
import { MissionRunner, MissionStore } from '../mission-runner.mjs';
import { VercelPreviewDeployer, vercelPreviewDestination } from '../vercel-preview-deployer.mjs';
import { readMissionInput } from '../mission-cli.mjs';
import { BrowserPreviewVerifier } from '../browser-verifier.mjs';

const target = { provider: 'vercel', projectId: 'prj_WhRBN1KcJAXHBhqfespJ07sWkcOt',
  teamId: 'team_xJDjjY2EmFRQpfvzV9yGoNWI', environment: 'preview',
  projectSlug: 'astra-lab', teamSlug: 'jmanns-projects' };
const destination = vercelPreviewDestination(target);
const goal = 'Build a polished, responsive volunteer signup page';
const criteria = ['The volunteer opportunity is clear at a glance.',
  'The signup path works on desktop and mobile.', 'Keyboard users can complete the signup flow.'];
const roles = { design: 'susie', build: 'sam', functional_review: 'quinn', visual_review: 'susie' };
const team = { id: 'design-led-single-team', roles };
const artifactId = 'preview-mission-artifact';
const previewUrl = 'https://astra-lab-deployment-42-jmanns-projects.vercel.app';
const guide = { concept: 'A warm editorial volunteer invitation with a clear, confident signup path.',
  sections: ['Hero', 'Opportunity', 'Signup'], typeScale: ['display', 'heading', 'body'], spacing: [4, 8, 16, 24],
  responsiveStates: ['Use a split hero on wide screens.', 'Stack the signup action on narrow screens.'],
  imagery: { direction: 'Use warm documentary photography.', sourceRequirements: 'Use owned project assets only.',
    altStrategy: 'Give informative images concise alt text.' },
  interactions: ['Show a clear focus ring.', 'Provide inline field feedback.'], references: ['Editorial civic design'] };

async function fixture(t, { reviseVisualOnce = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'village-preview-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const artifactRoot = join(workspace, 'dist');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(join(artifactRoot, 'index.html'),
    `<!doctype html><html><head><meta name="village-artifact-id" content="${artifactId}"><title>Volunteer</title></head><body><h1>Volunteer with us</h1></body></html>`);
  const agreement = { proposalId: 'proposal-1', summary: 'One bounded static preview mission.', acceptedByUser: true,
    acceptedAt: '2026-10-24T12:00:00.000Z', repo: 'startupsandcode/agent-village', goal, acceptanceCriteria: criteria,
    destination, artifactId, constraints: ['No production release', 'No paid resources'], team,
    workspaceBranch: 'feature/preview-deploy-adapter', previewTarget: target };
  const store = new MissionStore(join(root, 'missions'));
  const mission = await store.create({ id: 'preview-runtime-mission', repo: agreement.repo,
    workspaceBranch: agreement.workspaceBranch, goal, acceptanceCriteria: criteria, destination,
    previewTarget: target, artifactId, constraints: agreement.constraints, team, mayaAgreement: agreement,
    maxAttempts: 2, maxRevisions: 1, mayaIntakeCalls: 1 });
  const deployCalls = [];
  let deploymentCount = 0;
  let implementationCount = 0;
  let visualReviewCount = 0;
  const deployer = new VercelPreviewDeployer({ workspaceRoot: workspace,
    stateRoot: join(root, 'preview-deployments'), targets: [target],
    cli: { async whoami() { deployCalls.push('whoami'); },
      async deploy(options) { deployCalls.push(options); deploymentCount++;
        return { id: `dpl_AbCdEf12345${deploymentCount}`, url: previewUrl }; },
      async inspect(id, options) { return { id, projectId: target.projectId, teamId: target.teamId, target: 'preview', readyState: 'READY',
        url: previewUrl, meta: deployCalls.findLast(call => call?.meta)?.meta }; } } });
  const calls = [];
  const codex = { async runStructured(options) {
    calls.push(options);
    if (options.prompt.startsWith('You are Susie, the product designer.')) return {
      stage: 'susie_design', status: 'done', artifactId, evidence: ['Design guide defines hierarchy and states.'],
      designGuide: guide, previewUrl: null, functionalChecks: [], visualFindings: [],
    };
    if (options.prompt.startsWith('You are Sam,')) {
      implementationCount++;
      if (implementationCount > 1) await writeFile(join(artifactRoot, 'index.html'),
        `<!doctype html><html><head><meta name="village-artifact-id" content="${artifactId}"><title>Volunteer revised</title></head><body><h1>Volunteer with us</h1></body></html>`);
      return {
        stage: 'sam_implementation', status: 'done', artifactId, evidence: ['Static output built in dist.'],
        designGuide: null, previewUrl: null, artifactPath: 'dist', functionalChecks: [], visualFindings: [],
      };
    }
    if (options.prompt.startsWith('You are Quinn,')) return {
      stage: 'quinn_functional', status: 'done', artifactId, evidence: ['Local functional checks passed.'],
      designGuide: null, previewUrl: null, functionalChecks: ['Signup controls exist', 'Keyboard labels exist'], visualFindings: [],
    };
    visualReviewCount++;
    const status = reviseVisualOnce && visualReviewCount === 1 ? 'needs_revision' : 'done';
    return { stage: 'susie_visual', status, artifactId, evidence: ['Rendered desktop and mobile align to the guide.'],
      designGuide: null, previewUrl: null, functionalChecks: [], visualFindings: status === 'needs_revision' ? ['Increase contrast on the signup action.'] : [] };
  } };
  const browserVerifier = { async capture({ mission: captured, previewUrl: actual }) {
    assert.equal(captured.previewTarget.projectId, target.projectId);
    assert.equal(actual, previewUrl);
    return { rendered: { artifactId, destination: previewUrl, previewUrl, desktop: { passed: true, evidenceRef: 'sha256:desktop' },
      narrow: { passed: true, evidenceRef: 'sha256:narrow' }, screenshotRef: join(root, 'desktop.png') },
    captures: { desktop: { screenshotPath: join(root, 'desktop.png'), evidenceRef: 'sha256:desktop', metrics: { width: 1280 } },
      narrow: { screenshotPath: join(root, 'narrow.png'), evidenceRef: 'sha256:narrow', metrics: { width: 390 } } } };
  }, async verifyRenderedEvidence({ mission: checked, rendered }) {
    return { verified: true, artifactId: checked.artifactId, destination: rendered.destination,
      previewUrl: rendered.previewUrl, screenshotRef: rendered.screenshotRef };
  } };
  const handlers = new MissionCodexHandlers({ codex, workspacePath: workspace, browserVerifier, previewDeployer: deployer }).handlers();
  const runner = new MissionRunner(store, { verifyRenderedEvidence: evidence => browserVerifier.verifyRenderedEvidence(evidence) });
  return { root, workspace, artifactRoot, store, mission, runner, handlers, calls, deployCalls };
}

test('Maya intake agreement binds the exact Vercel project/team preview scope', async () => {
  let prompt;
  const intake = new MayaMissionIntake({ workspacePath: 'C:/workspace', codex: { async runStructured(options) {
    prompt = options.prompt;
    return { status: 'agreed', summary: 'Build a polished static volunteer preview.', acceptanceCriteria: criteria, questions: [] };
  } } });
  const input = { id: 'vercel-intake-mission', repo: 'startupsandcode/agent-village', goal,
    workspaceBranch: 'feature/preview-deploy-adapter', destination, previewTarget: target, artifactId,
    constraints: ['No production release'], team };
  const proposal = await intake.propose(input);
  assert.equal(proposal.status, 'agreed');
  assert.match(prompt, /projectId.*prj_WhRBN1KcJAXHBhqfespJ07sWkcOt/);
  const accepted = intake.accept(proposal.proposalId, `I agree to mission ${proposal.proposalId}`);
  assert.equal(accepted.mayaAgreement.destination, destination);
  assert.deepEqual(accepted.mayaAgreement.previewTarget, target);
});

test('mission CLI requires explicit allowlist and exact configured Vercel target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-preview-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'mission.json');
  await writeFile(path, JSON.stringify({ id: 'vercel-config-mission', goal, previewTarget: target, artifactId }));
  await assert.rejects(readMissionInput(path, 'feature/preview-deploy-adapter', {}), /VILLAGE_VERCEL_PREVIEW_TARGETS/);
  const env = { VILLAGE_VERCEL_PREVIEW_TARGETS: JSON.stringify([target]) };
  const accepted = await readMissionInput(path, 'feature/preview-deploy-adapter', env);
  assert.equal(accepted.destination, destination);
  assert.deepEqual(accepted.previewTarget, target);
  await assert.rejects(readMissionInput(path, 'feature/preview-deploy-adapter', {
    VILLAGE_VERCEL_PREVIEW_TARGETS: JSON.stringify([{ ...target, projectId: 'prj_otherproject12345' }]),
  }), /not allowlisted/);
});

test('runner deploys Sam static output before Quinn and accepts only the rendered deployment', async t => {
  const f = await fixture(t);
  const accepted = await f.runner.run(f.mission.id, f.handlers);
  assert.equal(accepted.status, 'accepted_preview', accepted.error ?? 'mission did not complete');
  assert.deepEqual(accepted.events.filter(event => event.status === 'done').map(event => event.stage),
    ['susie_design', 'sam_implementation', 'quinn_functional', 'susie_visual']);
  const sam = accepted.events.find(event => event.stage === 'sam_implementation');
  assert.equal(sam.output.previewUrl, previewUrl);
  assert.match(sam.output.deploymentId, /^dpl_/);
  assert.match(sam.output.artifactFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(f.deployCalls[0], 'whoami');
  assert.equal(f.deployCalls.filter(call => typeof call === 'object').length, 1);
  assert.equal(f.calls.findIndex(call => call.prompt.startsWith('You are Sam,')) <
    f.calls.findIndex(call => call.prompt.startsWith('You are Quinn,')), true);
  assert.match(f.calls.find(call => call.prompt.startsWith('You are Sam,')).prompt, /artifactPath with previewUrl null/);
  const restored = await new MissionStore(f.store.root).get(f.mission.id);
  assert.equal(restored.status, 'accepted_preview');
});

test('unapproved static artifact paths stop before any deployment', async t => {
  const f = await fixture(t);
  const missing = new MissionCodexHandlers({ workspacePath: f.workspace,
    codex: { async runStructured() { return { stage: 'sam_implementation', status: 'done', artifactId,
      evidence: ['Bad path'], previewUrl: null, artifactPath: '../outside', designGuide: null,
      functionalChecks: [], visualFindings: [] }; } },
    previewDeployer: { async deploy() { throw new Error('must not deploy'); } } }).handlers().sam_implementation;
  const design = f.mission.events;
  assert.deepEqual(design, []);
  await assert.rejects(missing({ mission: { ...f.mission, events: [{ stage: 'susie_design', status: 'done',
    revision: 0, output: { kind: 'design_guide', guide } }] }, stage: 'sam_implementation', revision: 0,
  attempt: 1 }), /inside the approved workspace/);
});

test('one bounded visual revision creates a separate idempotent preview before final acceptance', async t => {
  const f = await fixture(t, { reviseVisualOnce: true });
  const accepted = await f.runner.run(f.mission.id, f.handlers);
  assert.equal(accepted.status, 'accepted_preview', accepted.error ?? 'mission did not complete');
  const deployments = f.deployCalls.filter(call => typeof call === 'object');
  assert.equal(deployments.length, 2);
  assert.equal(deployments[0].meta.villageArtifactSha256 === deployments[1].meta.villageArtifactSha256, false);
  assert.equal(accepted.revisions, 1);
  assert.equal(accepted.events.filter(event => event.stage === 'susie_visual' && event.status === 'needs_revision').length, 1);
});

test('protected Vercel browser uses the short-lived OIDC header only for its approved preview origin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-preview-oidc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = 'short.lived.oidc-token-value';
  let routeHandler;
  let allowedHeaders;
  let externalRequestAborted = false;
  const browser = { async newContext() {
    let viewport = { width: 1280, height: 800 };
    return { async route(_pattern, handler) { routeHandler = handler; },
      async newPage() { return {
        async goto() {
          const headers = {};
          const sameOrigin = await routeHandler({ request: () => ({ url: () => previewUrl, headers: () => headers }),
            async continue(options) { allowedHeaders = options.headers; }, async abort() { throw new Error('approved origin blocked'); } });
          const externalUrl = 'https://assets.example.invalid/photo.webp';
          await routeHandler({ request: () => ({ url: () => externalUrl, headers: () => ({}) }),
            async continue() { throw new Error('external origin must remain blocked'); }, async abort() { externalRequestAborted = true; } });
          return { status: () => 200 };
        },
        url: () => previewUrl,
        locator: () => ({ async getAttribute() { return artifactId; } }),
        async evaluate(callback) {
          if (String(callback).includes('document.fonts?.ready')) return undefined;
          return { width: viewport.width, documentWidth: viewport.width, documentHeight: 700, heading: true,
            title: 'Volunteer', imagesMissingAlt: 0, fontStatus: 'loaded' };
        },
        async setViewportSize(value) { viewport = value; },
        async screenshot({ path }) { const bytes = Buffer.from(`screenshot-${viewport.width}`); await writeFile(path, bytes); return bytes; },
      }; }, async close() {} };
  }, async close() {} };
  const verifier = new BrowserPreviewVerifier({ evidenceRoot: root, chromium: { async launch() { return browser; } },
    oidcTokenProvider: async ({ target: accepted }) => { assert.deepEqual(accepted, target); return token; } });
  const mission = { id: 'vercel-browser-mission', artifactId, revisions: 0,
    destination, previewTarget: target, goal };
  const result = await verifier.capture({ mission, previewUrl });
  assert.equal(allowedHeaders['x-vercel-trusted-oidc-idp-token'], token);
  assert.equal(externalRequestAborted, true);
  assert.equal(result.rendered.sameOriginRequestCount, 1);
  assert.equal(result.rendered.destination, previewUrl);
  assert.equal((await verifier.verifyRenderedEvidence({ mission, rendered: result.rendered })).verified, true);
});
