import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchMissionWorker, MissionBackgroundWorker, MissionNotificationFeed,
  clearMissionWorkerError, missionCompletionEvent, readMissionBackgroundStatus, recordMissionWorkerError,
  reserveWorkspaceMission } from '../mission-background.mjs';

async function makeWorker({ root, id, store, feed, runner, handlers = {} }) {
  const storeRoot = join(root, 'store');
  const lease = await reserveWorkspaceMission({ root, missionId: id, storeRoot, branch: 'issue-46' });
  return new MissionBackgroundWorker({ root, storeRoot, leaseToken: lease.token, store, feed, runner, handlers });
}

function mission(id = 'background-job-46', status = 'ready') {
  return { id, status, goal: 'Build a reviewed local preview.', destination: 'https://preview.example.test',
    error: status === 'failed' ? 'bounded attempts used' : null, updatedAt: '2026-10-24T10:00:00.000Z',
    events: status === 'accepted_preview' ? [{ stage: 'susie_visual', status: 'done',
      rendered: { previewUrl: 'https://preview.example.test', screenshotRef: 'C:/evidence/desktop.png' } }] : [] };
}

test('background launch detaches, hides the process, pins workspace and removes provider/publish credentials', async () => {
  let launched;
  let spawned;
  const result = await launchMissionWorker({ missionId: 'background-job-46', storeRoot: 'C:/missions',
    evidenceRoot: 'C:/evidence', notificationsRoot: 'C:/notifications', workspacePath: 'C:/repo', expectedBranch: 'issue-46',
    workspaceStateRoot: 'C:/locks', leaseToken: 'lease-token',
    env: { OPENAI_API_KEY: 'do-not-inherit', ANTHROPIC_API_KEY: 'do-not-inherit',
      VERCEL_TOKEN: 'do-not-inherit', VILLAGE_PUBLISH_GITHUB_TOKEN: 'do-not-inherit',
      AWS_SECRET_ACCESS_KEY: 'do-not-inherit', GITHUB_APP_PRIVATE_KEY: 'do-not-inherit',
      DATABASE_URL: 'do-not-inherit', PGPASSWORD: 'do-not-inherit',
      GOOGLE_APPLICATION_CREDENTIALS: 'do-not-inherit', HTTP_PROXY: 'http://credential@proxy',
      PATH: 'C:\\Windows\\System32', CODEX_HOME: 'C:\\Users\\JMann\\.codex',
      PLAYWRIGHT_BROWSERS_PATH: 'C:\\Users\\JMann\\AppData\\Local\\ms-playwright',
      VILLAGE_VERCEL_PREVIEW_TARGETS: '[{"provider":"vercel","projectId":"prj_12345678","teamId":"team_12345678","environment":"preview","projectSlug":"astra-lab","teamSlug":"jmanns-projects"}]',
      SAFE_TEST_VALUE: 'do-not-inherit' },
    spawnProcess(command, args, options) {
      launched = { command, args, options };
      const listeners = {};
      spawned = { pid: 1234, once(name, fn) { listeners[name] = fn; if (name === 'spawn') queueMicrotask(fn); }, unref() { this.detached = true; } };
      return spawned;
    } });
  assert.equal(launched.options.detached, true);
  assert.equal(launched.options.windowsHide, true);
  assert.deepEqual(launched.options.stdio, 'ignore');
  assert.equal(launched.options.env.OPENAI_API_KEY, undefined);
  assert.equal(launched.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launched.options.env.VERCEL_TOKEN, undefined);
  assert.equal(launched.options.env.VILLAGE_PUBLISH_GITHUB_TOKEN, undefined);
  assert.equal(launched.options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(launched.options.env.GITHUB_APP_PRIVATE_KEY, undefined);
  assert.equal(launched.options.env.DATABASE_URL, undefined);
  assert.equal(launched.options.env.PGPASSWORD, undefined);
  assert.equal(launched.options.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(launched.options.env.HTTP_PROXY, undefined);
  assert.equal(launched.options.env.SAFE_TEST_VALUE, undefined);
  assert.equal(launched.options.env.PATH, 'C:\\Windows\\System32');
  assert.equal(launched.options.env.CODEX_HOME, 'C:\\Users\\JMann\\.codex');
  assert.equal(launched.options.env.PLAYWRIGHT_BROWSERS_PATH, 'C:\\Users\\JMann\\AppData\\Local\\ms-playwright');
  assert.equal(launched.options.env.VILLAGE_VERCEL_PREVIEW_TARGETS,
    '[{"provider":"vercel","projectId":"prj_12345678","teamId":"team_12345678","environment":"preview","projectSlug":"astra-lab","teamSlug":"jmanns-projects"}]');
  assert.equal(launched.options.env.VILLAGE_MISSION_EXPECTED_BRANCH, 'issue-46');
  assert.equal(launched.options.env.VILLAGE_MISSION_NOTIFICATIONS_ROOT, resolve('C:/notifications'));
  assert.equal(launched.options.env.VILLAGE_MISSION_WORKSPACE_STATE_ROOT, resolve('C:/locks'));
  assert.equal(launched.options.env.VILLAGE_MISSION_LEASE_TOKEN, 'lease-token');
  assert.equal(spawned.detached, true);
  assert.equal(result.pid, 1234);
});

test('one background worker at a time protects the shared checkout and stores idempotent completion events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-background-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let state = mission();
  let calls = 0;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const store = { async get() { return structuredClone(state); }, async list() { return [structuredClone(state)]; } };
  const feed = new MissionNotificationFeed(join(root, '.notifications'));
  const worker = await makeWorker({ root, id: state.id, store, feed, runner: { async run() {
    calls += 1;
    await gate;
    state = mission(state.id, 'accepted_preview');
    return structuredClone(state);
  } } });
  const first = worker.run(state.id);
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(() => worker.run(state.id), /another mission worker is active/);
  finish();
  assert.equal((await first).status, 'accepted_preview');
  assert.equal(calls, 1);
  const events = await feed.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].missionId, state.id);
  assert.equal(events[0].previewUrl, 'https://preview.example.test');
  assert.equal(events[0].screenshotRef, 'C:/evidence/desktop.png');
  await feed.record(state);
  assert.equal((await feed.list()).length, 1, 'replaying a final checkpoint does not duplicate the completion event');
});

test('atomic notification writes replace a partial event file and ignore interrupted temporary files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-background-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = mission('atomic-notify-46', 'accepted_preview');
  const feed = new MissionNotificationFeed(root);
  const event = missionCompletionEvent(state);
  const eventPath = join(root, `${event.missionId}-${event.id}.json`);
  await writeFile(eventPath, '{"partial":');
  await writeFile(`${eventPath}.abandoned.tmp`, '{"partial":');
  await feed.record(state);
  assert.deepEqual(await feed.list(), [event]);
});

test('worker refuses overlapping ready missions and reports cancellation or terminal failure in the feed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-background-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstState = mission();
  const secondState = mission('another-background-job');
  let state = firstState;
  let ran = false;
  const store = { async get() { return structuredClone(state); }, async list() { return [firstState, secondState]; } };
  const feed = new MissionNotificationFeed(join(root, '.notifications'));
  const worker = await makeWorker({ root, id: firstState.id, store, feed, runner: { async run() {
    ran = true;
    state = mission(firstState.id, 'failed');
    return structuredClone(state);
  } } });
  await assert.rejects(() => worker.run(firstState.id), /another-background-job is still active/);
  assert.equal(ran, false);

  store.list = async () => [firstState];
  state = mission(firstState.id, 'cancelled');
  await worker.run(firstState.id);
  assert.equal(ran, false, 'a cancellation checkpoint is reported without restarting the role');
  assert.equal((await feed.list())[0].status, 'cancelled');

  state = mission(firstState.id, 'ready');
  const failedRoot = join(root, 'failure');
  await mkdir(failedRoot);
  const failedWorker = await makeWorker({ root: failedRoot, id: firstState.id, store, feed,
    runner: { async run() { state = mission(firstState.id, 'failed'); return structuredClone(state); } } });
  await failedWorker.run(firstState.id);
  assert.deepEqual((await feed.list()).map(event => event.status).sort(), ['cancelled', 'failed']);
});

test('workspace reservation blocks a second mission store and canonicalizes worker error identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-background-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceLock = join(root, 'workspace-lock');
  const storeA = join(root, 'store-a');
  const storeB = join(root, 'store-b');
  const first = await reserveWorkspaceMission({ root: workspaceLock, missionId: 'first-mission-46', storeRoot: storeA, branch: 'issue-46' });
  await assert.rejects(() => reserveWorkspaceMission({ root: workspaceLock, missionId: 'second-mission-46', storeRoot: storeB, branch: 'issue-46' }),
    /workspace already has active mission first-mission-46/);
  const feed = new MissionNotificationFeed(join(root, 'feed'));
  await feed.recordWorkerError({ missionId: 'first-mission-46', message: '  launch failed  ', createdAt: '2026-10-24T10:30:00.000Z' });
  await feed.recordWorkerError({ missionId: 'first-mission-46', message: 'launch failed', createdAt: '2026-10-24T10:30:00.000Z' });
  assert.equal((await feed.list()).length, 1);
  assert.equal((await feed.list())[0].message, 'launch failed');
  assert.equal(first.missionId, 'first-mission-46');
});

test('worker startup failures appear in the durable notification feed and mission status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-background-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const feed = new MissionNotificationFeed(join(root, '.notifications'));
  const createdAt = '2026-10-24T10:30:00.000Z';
  await feed.recordWorkerError({ missionId: 'background-error-46', message: 'workspace branch changed', createdAt });
  await feed.recordWorkerError({ missionId: 'background-error-46', message: 'workspace branch changed', createdAt });
  await mkdir(join(root, '.worker-errors'));
  await writeFile(join(root, '.worker-errors', 'background-error-46.json'), JSON.stringify({
    missionId: 'background-error-46', message: 'workspace branch changed', updatedAt: createdAt,
  }));
  await writeFile(join(root, '.worker.lock'), JSON.stringify({ missionId: 'background-error-46', pid: process.pid, createdAt }));
  const status = await readMissionBackgroundStatus({ root, missionId: 'background-error-46', feed });
  assert.equal(status.worker.processAlive, true);
  assert.equal(status.worker.missionId, 'background-error-46');
  assert.equal(status.workerError.message, 'workspace branch changed');
  assert.equal(status.notifications.length, 1);
  assert.equal(status.notifications[0].status, 'worker_error');
  const otherMission = await readMissionBackgroundStatus({ root, missionId: 'another-job-46', feed });
  assert.equal(otherMission.worker.missionId, 'background-error-46', 'the shared worker lock identifies which mission owns it');
});

test('successful recovery clears the current worker error record', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-worker-error-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const feed = new MissionNotificationFeed(join(root, 'notifications'));
  await recordMissionWorkerError({ root, feed, missionId: 'recovered-mission-46', message: 'transient launch error' });
  assert.equal((await readMissionBackgroundStatus({ root, missionId: 'recovered-mission-46', feed })).workerError.message,
    'transient launch error');
  await clearMissionWorkerError({ root, missionId: 'recovered-mission-46' });
  assert.equal((await readMissionBackgroundStatus({ root, missionId: 'recovered-mission-46', feed })).workerError, null);
});

test('detached worker bootstrap failures are recorded under the shared workspace lock root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'village-background-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, 'store');
  const lockRoot = join(root, 'workspace-lock');
  const notificationsRoot = join(root, 'notifications');
  const workerPath = fileURLToPath(new URL('../mission-worker.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [workerPath, 'bootstrap-failure-46'], { encoding: 'utf8', env: {
    ...process.env, VILLAGE_MISSION_ROOT: storeRoot, VILLAGE_MISSION_WORKSPACE_STATE_ROOT: lockRoot,
    VILLAGE_MISSION_NOTIFICATIONS_ROOT: notificationsRoot,
  } });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /mission worker paths and workspace reservation are not configured/);
  const feed = new MissionNotificationFeed(notificationsRoot);
  const status = await readMissionBackgroundStatus({ root: lockRoot, missionId: 'bootstrap-failure-46', feed });
  assert.match(status.workerError.message, /mission worker paths/);
  assert.equal(status.notifications[0].status, 'worker_error');
});
