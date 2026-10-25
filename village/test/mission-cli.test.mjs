import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { inspectMissionWorkerWorkspace, main, samePreviewUrl } from '../mission-cli.mjs';
import { MissionRunner, MissionStore } from '../mission-runner.mjs';
import { MissionNotificationFeed, recordMissionWorkerError, reserveWorkspaceMission, updateWorkspaceMission,
  isMissionProcessAlive, workspaceStateRoot } from '../mission-background.mjs';

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

test('uncertain functional retry requires the explicit approval flag before loading a mission', async () => {
  await assert.rejects(() => main(['retry-functional-uncertain', 'mission-46'], { env: {} }),
    /retry-functional-uncertain <mission-id> --operator-approved-uncertain-outcome/);
});

test('final review call increase requires the explicit user-approved 8-to-9 flag before loading a mission', async () => {
  await assert.rejects(() => main(['increase-final-review-cap', 'mission-46'], { env: {} }),
    /increase-final-review-cap <mission-id> --user-approved-8-to-9/);
});

test('second final review call increase requires the explicit user-approved 9-to-10 flag before loading a mission', async () => {
  await assert.rejects(() => main(['increase-final-review-cap-10', 'mission-46'], { env: {} }),
    /increase-final-review-cap-10 <mission-id> --user-approved-9-to-10/);
});

test('preview evidence URL comparison accepts only equivalent clean HTTP(S) locations', () => {
  assert.equal(samePreviewUrl('https://astra.example.test', 'https://astra.example.test/'), true);
  assert.equal(samePreviewUrl('https://astra.example.test/path/', 'https://astra.example.test/path'), true);
  assert.equal(samePreviewUrl('https://astra.example.test/path?x=1', 'https://astra.example.test/path'), false);
  assert.equal(samePreviewUrl('https://other.example.test', 'https://astra.example.test'), false);
});

test('mission worker permits only the reconciled mission output folder to remain untracked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-worker-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'validation', 'worker-preview-46'), { recursive: true });
  await writeFile(join(workspace, 'validation', 'worker-preview-46', 'index.html'), 'mission artifact');
  await execFileAsync('git', ['init', '-b', 'worker-preview-branch'], { cwd: workspace });
  await execFileAsync('git', ['config', 'remote.origin.url', 'https://github.com/startupsandcode/agent-village.git'], { cwd: workspace });
  const mission = { id: 'worker-preview-46', previewDeploymentRecovery: { status: 'consumed' } };
  const inspected = await inspectMissionWorkerWorkspace(workspace, mission);
  assert.equal(inspected.branch, 'worker-preview-branch');
  await writeFile(join(workspace, 'unrelated.txt'), 'preserve me');
  await assert.rejects(inspectMissionWorkerWorkspace(workspace, mission), /only untracked validation\/worker-preview-46/);
  await assert.rejects(inspectMissionWorkerWorkspace(workspace, { ...mission, previewDeploymentRecovery: null }), /clean before it starts or resumes/);
});

test('retry-preflight requires exact local provider evidence and resumes the same accepted mission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-mission-preflight-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await execFileAsync('git', ['init', '-b', 'mission-preflight-retry'], { cwd: workspace });
  await execFileAsync('git', ['config', 'remote.origin.url', 'https://github.com/startupsandcode/agent-village.git'], { cwd: workspace });
  const home = join(root, 'mission-home');
  const storeRoot = join(home, 'missions');
  const missionId = 'retry-preflight-cli';
  const missionGoal = 'Build a bounded, local-first mission demo.';
  const criteria = ['Keep the artifact local to the mission folder.', 'Show the agreed role sequence clearly.', 'Render accessibly on narrow screens.'];
  const roleTeam = { id: 'design-led-single-team', roles: { design: 'susie', build: 'sam', functional_review: 'quinn', visual_review: 'susie' } };
  const constraints = ['No paid services'];
  const store = new MissionStore(storeRoot);
  await store.create({ id: missionId, repo: 'startupsandcode/agent-village', workspaceBranch: 'mission-preflight-retry',
    goal: missionGoal, acceptanceCriteria: criteria, destination: 'https://preview.example.test', artifactId,
    constraints, team: roleTeam, maxAttempts: 1, maxRevisions: 0,
    mayaAgreement: { proposalId: 'maya-preflight', summary: 'One bounded test preview.', acceptedByUser: true,
      acceptedAt: '2026-10-24T10:00:00.000Z', repo: 'startupsandcode/agent-village', workspaceBranch: 'mission-preflight-retry',
      goal: missionGoal, acceptanceCriteria: criteria, destination: 'https://preview.example.test', artifactId, constraints, team: roleTeam } });
  const failed = await new MissionRunner(store).run(missionId, { susie_design: async () => { throw new Error('Codex stage failed'); } });
  assert.equal(failed.status, 'blocked');

  const codexHome = join(root, '.codex');
  const sessionId = '01a16ed9-f8cb-73f2-836b-61c8445aa29e';
  const sessionDirectory = join(codexHome, 'sessions', '2026', '10', '24');
  await mkdir(sessionDirectory, { recursive: true });
  const sessionPath = join(sessionDirectory, `rollout-2026-10-24T12-59-01-${sessionId}.jsonl`);
  const providerError = { error: { code: 'invalid_json_schema', param: 'text.format.schema',
    message: "Invalid schema for response_format 'codex_output_schema': 'schema.required' is required to include every key in properties. Missing 'artifactPath'." }, status: 400 };
  const session = [
    { type: 'session_meta', payload: { session_id: sessionId, cwd: workspace } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
      text: `You are Susie, the product designer. Mission ${missionId}; artifact ${artifactId}.` }] } },
    { type: 'event_msg', payload: { type: 'task_complete', error: { message: JSON.stringify(providerError) } } },
  ];
  await writeFile(sessionPath, `${session.map(record => JSON.stringify(record)).join('\n')}\n`);
  const lockRoot = workspaceStateRoot(home, await realpath(workspace));
  const lease = await reserveWorkspaceMission({ root: lockRoot, missionId, storeRoot, branch: 'mission-preflight-retry' });
  const deadWorker = await import('node:child_process').then(({ spawn }) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }));
  await new Promise((resolve, reject) => {
    deadWorker.once('error', reject);
    deadWorker.once('spawn', resolve);
  });
  const deadPid = deadWorker.pid;
  deadWorker.kill();
  await new Promise(resolve => deadWorker.once('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 250));
  await updateWorkspaceMission({ root: lockRoot, missionId, storeRoot, token: lease.token, pid: deadPid });
  const env = { VILLAGE_MISSION_HOME: home, VILLAGE_MISSION_WORKSPACE: workspace, CODEX_HOME: codexHome };
  const inspectStoppedWorkspace = async () => ({ worker: null, notifications: [],
    reservation: { missionId, storeRoot, branch: 'mission-preflight-retry', pid: deadPid, processAlive: false } });
  const recovered = await main(['retry-preflight', missionId, sessionPath], { env,
    processCheck: async () => false, inspectBackgroundStatus: inspectStoppedWorkspace });
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.priorFailureRetained, true);
  assert.equal(recovered.roleCallsReserved, 2);
  const resumed = await main(['resume', missionId], { env, processCheck: async () => false,
    inspectBackgroundStatus: inspectStoppedWorkspace,
    spawnWorker: async () => ({ pid: process.pid }) });
  assert.equal(resumed.status, 'queued');
  const checkpoint = await store.get(missionId);
  assert.equal(checkpoint.events.length, 1);
  assert.equal(checkpoint.events[0].retryable, false);
  assert.equal(checkpoint.preExecutionRecovery.status, 'authorized');
});

test('recover-preview deploys only the accepted mission output after the exact preflight checkpoint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-mission-preview-recovery-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await execFileAsync('git', ['init', '-b', 'mission-preview-recovery'], { cwd: workspace });
  await execFileAsync('git', ['config', 'remote.origin.url', 'https://github.com/startupsandcode/agent-village.git'], { cwd: workspace });
  const missionId = 'preview-recovery-cli';
  const artifactDir = join(workspace, 'validation', missionId, 'dist');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'index.html'), `<meta name="village-artifact-id" content="${artifactId}">`);
  const home = join(root, 'mission-home');
  const storeRoot = join(home, 'missions');
  const target = { provider: 'vercel', projectId: 'prj_1234567890', teamId: 'team_1234567890',
    environment: 'preview', projectSlug: 'astra-lab', teamSlug: 'jmanns-projects' };
  const destination = 'vercel-preview://jmanns-projects/astra-lab';
  const missionGoal = 'Build a bounded design-led preview demo.';
  const criteria = ['Keep output inside the mission folder.', 'Use a clear responsive hierarchy.', 'Verify the rendered preview.'];
  const roleTeam = { id: 'design-led-single-team', roles: { design: 'susie', build: 'sam', functional_review: 'quinn', visual_review: 'susie' } };
  const constraints = ['No paid services'];
  const store = new MissionStore(storeRoot);
  const state = await store.create({ id: missionId, repo: 'startupsandcode/agent-village', workspaceBranch: 'mission-preview-recovery',
    goal: missionGoal, acceptanceCriteria: criteria, destination, previewTarget: target, artifactId,
    constraints, team: roleTeam, mayaIntakeCalls: 1, maxAttempts: 1, maxRevisions: 1,
    mayaAgreement: { proposalId: 'maya-preview-recovery', summary: 'One bounded preview.', acceptedByUser: true,
      acceptedAt: '2026-10-24T10:00:00.000Z', repo: 'startupsandcode/agent-village', workspaceBranch: 'mission-preview-recovery',
      goal: missionGoal, acceptanceCriteria: criteria, destination, previewTarget: target, artifactId, constraints, team: roleTeam } });
  const guideOutput = { kind: 'design_guide', guide: guide };
  let running = { ...state, status: 'running', attempts: { '0:susie_design': 1 }, inFlight: { stage: 'susie_design', attempt: 1 } };
  await store.save(running);
  running = { ...running, status: 'ready', currentStage: 'sam_implementation', inFlight: null, error: null,
    events: [{ stage: 'susie_design', revision: 0, attempt: 1, status: 'done', evidence: ['Susie supplied a structured guide.'],
      artifactId, output: guideOutput }] };
  await store.save(running);
  running = { ...running, status: 'running', attempts: { ...running.attempts, '0:sam_implementation': 1 },
    inFlight: { stage: 'sam_implementation', attempt: 1 } };
  await store.save(running);
  running = { ...running, status: 'blocked', inFlight: { stage: 'sam_implementation', attempt: 1 }, error: 'Codex stage failed',
    events: [...running.events, { stage: 'sam_implementation', revision: 0, attempt: 1, status: 'failed', evidence: [],
      error: 'Codex stage failed', retryable: false }] };
  await store.save(running);
  const journalRoot = join(storeRoot, '.preview-deployments');
  await mkdir(journalRoot, { recursive: true });
  await writeFile(join(journalRoot, `${missionId}.json`), JSON.stringify({ version: 2, revision: 0, missionId,
    artifactId, artifactFingerprint: 'a'.repeat(64), projectId: target.projectId, teamId: target.teamId,
    projectSlug: target.projectSlug, teamSlug: target.teamSlug, target: 'preview', status: 'uncertain',
    createdAt: new Date().toISOString(), deploymentId: null, url: null, attempts: 1,
    error: 'Vercel CLI failed: Retrieving project.\nError: The provided path "C:\\Temp\\stage\\app" does not exist.' }));
  const canonicalWorkspace = await realpath(workspace);
  const lockRoot = workspaceStateRoot(home, canonicalWorkspace);
  const lease = await reserveWorkspaceMission({ root: lockRoot, missionId, storeRoot, branch: 'mission-preview-recovery' });
  const deadWorker = await import('node:child_process').then(({ spawn }) => spawn(process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }));
  await new Promise((resolve, reject) => { deadWorker.once('error', reject); deadWorker.once('spawn', resolve); });
  const deadPid = deadWorker.pid;
  deadWorker.kill();
  await new Promise(resolve => deadWorker.once('exit', resolve));
  await updateWorkspaceMission({ root: lockRoot, missionId, storeRoot, token: lease.token, pid: deadPid });
  const inspectStoppedWorkspace = async () => ({ worker: null,
    reservation: { missionId, storeRoot, branch: 'mission-preview-recovery', pid: deadPid, processAlive: false } });
  const previewUrl = 'https://astra-lab-a1b2-jmanns-projects.vercel.app';
  const env = { VILLAGE_MISSION_HOME: home, VILLAGE_MISSION_WORKSPACE: workspace };
  let deployments = 0;
  const result = await main(['recover-preview', missionId], { env, processCheck: async () => false,
    inspectBackgroundStatus: inspectStoppedWorkspace,
    previewDeployer: { async deploy({ mission, artifactRoot }) {
      deployments++;
      assert.equal(mission.id, missionId);
      assert.equal(artifactRoot, await realpath(join(workspace, 'validation', missionId, 'dist')));
      return { status: 'ready', missionId, artifactId, projectId: target.projectId, teamId: target.teamId,
        target: 'preview', deploymentId: 'dpl_1234567890', url: previewUrl, artifactFingerprint: 'a'.repeat(64),
        reconciliation: { method: 'vercel-list-mission-metadata', matchingDeployments: 0 } };
    } },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.nextStage, 'quinn_functional');
  assert.equal(result.roleCallsUsed, 3);
  assert.equal(deployments, 1);
  const recovered = await store.get(missionId);
  assert.deepEqual(recovered.events.filter(event => event.stage === 'sam_implementation').map(event => event.status), ['failed', 'done']);
  assert.equal(recovered.events.at(-1).output.previewUrl, previewUrl);
});

test('mission process probe recognizes the current process', async () => {
  assert.equal(await isMissionProcessAlive(process.pid), true);
});

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

test('Maya clarification calls consume the same durable eight-call budget before mission acceptance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-mission-intake-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const fs = await import('node:fs/promises');
  await fs.mkdir(workspace);
  await execFileAsync('git', ['init', '-b', 'mission-intake-budget-46'], { cwd: workspace });
  await execFileAsync('git', ['config', 'remote.origin.url', 'https://github.com/startupsandcode/agent-village.git'], { cwd: workspace });
  await writeFile(join(workspace, 'seed.txt'), 'seed');
  await execFileAsync('git', ['add', 'seed.txt'], { cwd: workspace });
  await execFileAsync('git', ['-c', 'user.name=Mission Test', '-c', 'user.email=mission@example.test', 'commit', '-m', 'Seed'], { cwd: workspace });
  const missions = join(root, 'missions');
  const input = join(root, 'mission.json');
  await writeFile(input, JSON.stringify({ id: 'maya-budget-46', goal: 'Build a reviewed local preview.',
    destination: 'http://127.0.0.1:3000/preview', artifactId: 'maya-budget-46' }));
  let calls = 0;
  const options = { env: { VILLAGE_MISSION_WORKSPACE: workspace, VILLAGE_MISSION_ROOT: missions,
    VILLAGE_MISSION_HOME: join(root, 'home') },
    codex: { async runStructured() { calls++; return { status: 'needs_user', summary: 'Clarification is required.',
      acceptanceCriteria: [], questions: ['Which audience should this preview address?'] }; } } };
  for (let index = 0; index < 8; index++) {
    assert.equal((await main(['start', input], options)).status, 'needs_user');
  }
  await assert.rejects(() => main(['start', input], options), /8-call Codex CLI limit/);
  assert.equal(calls, 8, 'the ninth intake does not call Codex');
  const ledger = JSON.parse(await fs.readFile(join(missions, '.intake-calls', 'maya-budget-46.json'), 'utf8'));
  assert.equal(ledger.calls, 8);
});
