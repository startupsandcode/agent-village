import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { main } from '../mission-cli.mjs';
import { MissionStore } from '../mission-runner.mjs';
import { MissionNotificationFeed, recordMissionWorkerError, workspaceStateRoot } from '../mission-background.mjs';

const execFileAsync = promisify(execFile);
const artifactId = 'local-preview-artifact-46';
const guide = { concept: 'An editorial volunteer invitation with a people-first service story.',
  sections: ['Hero and signup action', 'Volunteer roles', 'Form and confirmation'],
  typeScale: ['Display serif with responsive clamp', 'Section heading with clear contrast', 'Body sans with readable leading'],
  spacing: [4, 8, 16, 32],
  responsiveStates: ['Wide screens use a split hero and supporting image.', 'Narrow screens stack the hero and keep the form action visible.'],
  imagery: { direction: 'Use natural documentary photography with real volunteers.',
    sourceRequirements: 'Use assets already in the repository with verified rights.',
    altStrategy: 'Describe informative images; leave decorative images with empty alt.' },
  interactions: ['Every field has a persistent label and visible error state.', 'Keyboard focus remains visible and confirmation is announced.'],
  references: ['Editorial service design'] };

test('start runs mocked roles in order and accepts only a real rendered local preview', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-mission-cli-'));
  const priorBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = 'C:\\Users\\JMann\\AppData\\Local\\ms-playwright';
  t.after(() => { if (priorBrowserPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = priorBrowserPath; });
  const workspace = join(root, 'workspace');
  const evidence = join(root, 'evidence');
  const missions = join(root, 'missions');
  await (await import('node:fs/promises')).mkdir(workspace);
  await execFileAsync('git', ['init', '-b', 'mission-e2e'], { cwd: workspace });
  await execFileAsync('git', ['config', 'remote.origin.url', 'https://github.com/startupsandcode/agent-village.git'], { cwd: workspace });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta name="village-artifact-id" content="${artifactId}"><title>Volunteer preview</title><style>body{font:18px system-ui;max-width:50rem;margin:auto;padding:2rem}h1{font-size:clamp(2rem,8vw,4rem)}</style></head><body><main><h1>Join the volunteer community</h1><p>Choose a role and get started.</p><button>Sign up</button></main></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const destination = `http://127.0.0.1:${server.address().port}/preview`;
  const inputPath = join(root, 'input.json');
  await writeFile(inputPath, JSON.stringify({ id: 'mission-cli-e2e', goal: 'Build a polished volunteer signup preview.',
    destination, artifactId, constraints: ['Use no paid services.'], maxAttempts: 2, maxRevisions: 1 }));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const responses = [];
  const codex = { async runStructured(options) {
    responses.push(options);
    if (options.prompt.startsWith('You are Maya,')) return { status: 'agreed',
      summary: 'Build one responsive volunteer signup preview on the approved local destination.',
      acceptanceCriteria: ['Visitors can understand the volunteer opportunity quickly.',
        'The signup path works on desktop and narrow screens.', 'Keyboard users can complete the signup flow.'], questions: [] };
    if (options.prompt.startsWith('You are Susie, the product designer.')) return { stage: 'susie_design',
      status: 'done', artifactId, evidence: ['Design guide specifies hierarchy, type, spacing, imagery and responsive layout.'],
      designGuide: guide, previewUrl: null, functionalChecks: [], visualFindings: [] };
    if (options.prompt.startsWith('You are Sam,')) return { stage: 'sam_implementation',
      status: 'done', artifactId, evidence: ['Local preview returned for the approved destination.'],
      designGuide: null, previewUrl: destination, functionalChecks: [], visualFindings: [] };
    if (options.prompt.startsWith('You are Quinn,')) return { stage: 'quinn_functional',
      status: 'done', artifactId, evidence: ['Functional criteria checked in local workspace.'],
      designGuide: null, previewUrl: null, functionalChecks: ['Signup action is present', 'Keyboard flow checked'], visualFindings: [] };
    return { stage: 'susie_visual', status: 'done', artifactId,
      evidence: ['Real Chromium desktop and narrow screenshots match the design guide.'],
      designGuide: null, previewUrl: null, functionalChecks: [], visualFindings: [] };
  } };
  const result = await main(['start', inputPath], { env: { VILLAGE_MISSION_WORKSPACE: workspace,
    VILLAGE_MISSION_ROOT: missions, VILLAGE_MISSION_EVIDENCE_ROOT: evidence,
    PLAYWRIGHT_BROWSERS_PATH: 'C:\\Users\\JMann\\AppData\\Local\\ms-playwright' }, codex,
    background: false,
    confirm: async (_proposalId, summary, criteria) => {
      assert.match(summary, /approved local destination/);
      assert.equal(criteria.length, 3);
      return 'YES';
    } });
  assert.equal(result.status, 'accepted_preview');
  assert.deepEqual(responses.map(item => item.readOnly), [true, true, false, true, true]);
  assert.deepEqual(responses[4].images.map(path => path.split(/[\\/]/).at(-1)), ['desktop.png', 'narrow.png']);
  assert.equal(result.events.length, 4);
  assert.equal(result.events[0].output.kind, 'design_guide');
  assert.equal(result.events.at(-1).rendered.artifactId, artifactId);
  assert.equal(result.events.at(-1).renderVerification.verified, true);
  const unboundedInput = join(root, 'unbounded.json');
  await writeFile(unboundedInput, JSON.stringify({ id: 'mission-cli-over-limit', goal: 'Build a preview.',
    destination, artifactId, constraints: [], maxAttempts: 3 }));
  await assert.rejects(() => main(['start', unboundedInput], { env: { VILLAGE_MISSION_WORKSPACE: workspace,
    VILLAGE_MISSION_ROOT: missions, VILLAGE_MISSION_EVIDENCE_ROOT: evidence }, codex,
    confirm: async () => { throw new Error('should not request approval'); } }), /attempt limit must be 1-2/);
  assert.equal(responses.length, 5, 'a CLI request outside the hard execution bounds does not call Maya or a worker role');
});

test('start persists a queued mission, detaches one worker and refuses a duplicate shared-workspace mission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-mission-queue-'));
  const workspace = join(root, 'workspace');
  const missions = join(root, 'missions');
  await (await import('node:fs/promises')).mkdir(workspace);
  await execFileAsync('git', ['init', '-b', 'mission-queue-46'], { cwd: workspace });
  await execFileAsync('git', ['config', 'remote.origin.url', 'https://github.com/startupsandcode/agent-village.git'], { cwd: workspace });
  await writeFile(join(workspace, 'seed.txt'), 'fixture workspace');
  await execFileAsync('git', ['add', 'seed.txt'], { cwd: workspace });
  await execFileAsync('git', ['-c', 'user.name=Mission Test', '-c', 'user.email=mission@example.test',
    'commit', '-m', 'Seed mission fixture'], { cwd: workspace });
  const firstInput = join(root, 'first.json');
  const secondInput = join(root, 'second.json');
  for (const [path, id] of [[firstInput, 'queued-first-46'], [secondInput, 'queued-second-46']]) {
    await writeFile(path, JSON.stringify({ id, goal: 'Build an approved local preview.',
      destination: 'http://127.0.0.1:3000/preview', artifactId: id, constraints: [] }));
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  let mayaReturned;
  const mayaReady = new Promise(resolve => { mayaReturned = resolve; });
  const codex = { async runStructured() {
    calls += 1;
    mayaReturned();
    return { status: 'agreed', summary: 'Build one preview at the already approved destination.',
      acceptanceCriteria: ['The page works on desktop.', 'The page works on mobile.', 'The page has readable hierarchy.'],
      questions: [] };
  } };
  let launched = 0;
  let acceptAgreement;
  const agreement = new Promise(resolve => { acceptAgreement = resolve; });
  const options = { env: { VILLAGE_MISSION_WORKSPACE: workspace, VILLAGE_MISSION_ROOT: missions,
    VILLAGE_MISSION_EVIDENCE_ROOT: join(root, 'evidence'), VILLAGE_MISSION_HOME: join(root, 'home') }, codex,
    confirm: async () => { await agreement; return 'YES'; }, spawnWorker: async ({ missionId, expectedBranch }) => {
      launched += 1;
      assert.equal(missionId, 'queued-first-46');
      assert.equal(expectedBranch, 'mission-queue-46');
      return { pid: 4321 };
    } };
  const firstStart = main(['start', firstInput], options);
  await mayaReady;
  await assert.rejects(() => main(['start', secondInput], options), /another mission is being accepted/);
  acceptAgreement();
  const queued = await firstStart;
  assert.deepEqual(queued, { id: 'queued-first-46', status: 'queued', workerPid: 4321,
    statusCommand: 'node village/mission-cli.mjs status queued-first-46',
    notificationsCommand: 'node village/mission-cli.mjs notifications' });
  assert.equal((await new MissionStore(missions).get('queued-first-46')).status, 'ready', 'accepted job is durable before worker execution');
  await execFileAsync('git', ['checkout', '-b', 'wrong-feature-branch'], { cwd: workspace });
  await assert.rejects(() => main(['resume', 'queued-first-46'], options), /mission branch changed/);
  await execFileAsync('git', ['checkout', 'mission-queue-46'], { cwd: workspace });
  const dirtyPath = join(workspace, 'unreviewed-change.txt');
  await writeFile(dirtyPath, 'preserve me');
  await assert.rejects(() => main(['resume', 'queued-first-46'], options), /clean before it starts or resumes/);
  await (await import('node:fs/promises')).unlink(dirtyPath);
  await recordMissionWorkerError({ root: workspaceStateRoot(join(root, 'home'), workspace),
    feed: new MissionNotificationFeed(join(missions, '.notifications')), missionId: 'queued-first-46',
    message: 'simulated worker exit before completing the mission' });
  const resumed = await main(['resume', 'queued-first-46'], options);
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.statusCommand, 'node village/mission-cli.mjs status queued-first-46');
  await assert.rejects(() => main(['start', secondInput], options), /workspace already has active mission queued-first-46/);
  assert.equal(calls, 1, 'a second start does not invoke Maya while a job is queued');
  assert.equal(launched, 2, 'no overlapping mission is created; explicit safe resume can relaunch one worker');
});

test('a worker launch failure is durably recorded and permits a safe resume retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-mission-launch-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const missions = join(root, 'missions');
  const fs = await import('node:fs/promises');
  await fs.mkdir(workspace);
  await execFileAsync('git', ['init', '-b', 'mission-launch-retry-46'], { cwd: workspace });
  await execFileAsync('git', ['config', 'remote.origin.url', 'https://github.com/startupsandcode/agent-village.git'], { cwd: workspace });
  await writeFile(join(workspace, 'seed.txt'), 'seed');
  await execFileAsync('git', ['add', 'seed.txt'], { cwd: workspace });
  await execFileAsync('git', ['-c', 'user.name=Mission Test', '-c', 'user.email=mission@example.test', 'commit', '-m', 'Seed'], { cwd: workspace });
  const input = join(root, 'mission.json');
  await writeFile(input, JSON.stringify({ id: 'launch-retry-46', goal: 'Build a verified preview.',
    destination: 'http://127.0.0.1:3000/preview', artifactId: 'launch-retry-46' }));
  const codex = { async runStructured() { return { status: 'agreed', summary: 'Build one preview.',
    acceptanceCriteria: ['Render the page cleanly.', 'Check the preview on desktop.', 'Check the preview on mobile.'], questions: [] }; } };
  const base = { env: { VILLAGE_MISSION_WORKSPACE: workspace, VILLAGE_MISSION_ROOT: missions }, codex,
    confirm: async () => 'YES' };
  await assert.rejects(() => main(['start', input], { ...base, spawnWorker: async () => { throw new Error('spawn denied'); } }), /spawn denied/);
  const feed = await main(['notifications'], base);
  assert.equal(feed[0].status, 'worker_error');
  assert.match(feed[0].message, /worker launch failed: spawn denied/);
  const status = await main(['status', 'launch-retry-46'], base);
  assert.match(status.workerError.message, /spawn denied/);
  const resumed = await main(['resume', 'launch-retry-46'], { ...base, spawnWorker: async () => ({ pid: 9876 }) });
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.workerPid, 9876);
});
