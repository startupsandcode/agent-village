import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const terminalStatuses = new Set(['accepted_preview', 'blocked', 'cancelled']);
const finalStatuses = new Set([...terminalStatuses, 'failed']);
const safeEnvironmentNames = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP',
  'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'CODEX_HOME', 'PLAYWRIGHT_BROWSERS_PATH',
]);

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export function workspaceStateRoot(base, workspacePath) {
  assert(typeof base === 'string' && base.trim() && typeof workspacePath === 'string' && workspacePath.trim(),
    'mission home and workspace path required');
  const canonicalPath = resolve(workspacePath);
  const identity = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  return join(resolve(base), 'workspace-locks', hash(identity));
}

export async function readWorkspaceLease(root) {
  const path = join(resolve(root), '.active-mission.json');
  let lease;
  try { lease = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('workspace mission reservation is unreadable; reconcile it before starting another mission');
  }
  assert(typeof lease.token === 'string' && lease.token && typeof lease.missionId === 'string' &&
    /^[a-z0-9][a-z0-9-]{2,79}$/.test(lease.missionId) && typeof lease.storeRoot === 'string' &&
    lease.storeRoot && typeof lease.branch === 'string' && typeof lease.createdAt === 'string' &&
    (lease.pid === null || Number.isSafeInteger(lease.pid) && lease.pid > 0) &&
    Number.isFinite(Date.parse(lease.createdAt)), 'workspace mission reservation is invalid');
  return lease;
}

export async function reserveWorkspaceMission({ root, missionId, storeRoot, branch }) {
  assert(root && typeof missionId === 'string' && /^[a-z0-9][a-z0-9-]{2,79}$/.test(missionId) &&
    storeRoot && typeof branch === 'string' && branch, 'workspace mission reservation is invalid');
  await mkdir(resolve(root), { recursive: true });
  const lease = { token: randomUUID(), missionId, storeRoot: resolve(storeRoot), branch,
    pid: null, createdAt: new Date().toISOString() };
  const path = join(resolve(root), '.active-mission.json');
  try {
    const handle = await open(path, 'wx');
    try { await handle.writeFile(`${JSON.stringify(lease)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    return lease;
  } catch (error) {
    if (error.code === 'EEXIST') {
      const active = await readWorkspaceLease(root);
      throw new Error(`workspace already has active mission ${active?.missionId ?? 'unknown'}`);
    }
    throw error;
  }
}

export async function updateWorkspaceMission({ root, missionId, storeRoot, token, pid }) {
  const lease = await readWorkspaceLease(root);
  assert(lease && lease.missionId === missionId && lease.storeRoot === resolve(storeRoot) && lease.token === token,
    'workspace reservation does not match this mission');
  const next = { ...lease, ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
  await writeJsonAtomic(join(resolve(root), '.active-mission.json'), next);
  return next;
}

export async function releaseWorkspaceMission({ root, missionId, storeRoot, token }) {
  const path = join(resolve(root), '.active-mission.json');
  const lease = await readWorkspaceLease(root);
  if (!lease) return false;
  assert(lease.missionId === missionId && lease.storeRoot === resolve(storeRoot) && lease.token === token,
    'workspace reservation changed; refusing to release another mission');
  await unlink(path);
  return true;
}

function lockBusy(message) {
  const error = new Error(message);
  error.code = 'MISSION_LOCK_BUSY';
  return error;
}

export function missionIsTerminal(state) {
  return terminalStatuses.has(state.status);
}

export function missionIsFinal(state) {
  return finalStatuses.has(state.status);
}

export async function acquireLocalLock(path, { waitMs = 0, pollMs = 250,
  busyMessage = 'another mission action is active; queue remains durable for a later worker', owner = {} } = {}) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  let handle;
  for (;;) {
    try {
      handle = await open(path, 'wx');
      await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString(), ...owner })}\n`);
      await handle.sync();
      return {
        async release() {
          await handle.close();
          try {
            const owner = JSON.parse(await readFile(path, 'utf8'));
            if (owner.token === token) await unlink(path);
          } catch {}
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw lockBusy(busyMessage);
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
}

export function missionCompletionEvent(state) {
  assert(state && typeof state.id === 'string' && missionIsFinal(state), 'final mission state required');
  const visual = state.events.findLast(event => event.stage === 'susie_visual' && event.status === 'done');
  const status = state.status;
  const identity = `${state.id}:${status}:${state.updatedAt}:${state.events.length}`;
  return {
    kind: 'mission_terminal',
    id: hash(identity),
    missionId: state.id,
    status,
    goal: state.goal,
    destination: state.destination,
    ...(visual?.rendered?.previewUrl ? { previewUrl: visual.rendered.previewUrl } : {}),
    ...(visual?.rendered?.screenshotRef ? { screenshotRef: visual.rendered.screenshotRef } : {}),
    error: state.error,
    createdAt: state.updatedAt,
    checkpointEventCount: state.events.length,
  };
}

export class MissionNotificationFeed {
  constructor(root) {
    if (!root) throw new Error('notification feed path required');
    this.root = resolve(root);
  }

  async record(state) {
    const event = missionCompletionEvent(state);
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, `${event.missionId}-${event.id}.json`);
    await writeJsonAtomic(path, event);
    return { recorded: true, event };
  }

  async recordWorkerError({ missionId, message, createdAt = new Date().toISOString() }) {
    assert(typeof missionId === 'string' && /^[a-z0-9][a-z0-9-]{2,79}$/.test(missionId) &&
      typeof message === 'string' && message.trim() && message.length <= 500 &&
      Number.isFinite(Date.parse(createdAt)), 'invalid background worker error event');
    message = message.trim();
    const event = { kind: 'worker_error', id: hash(`worker_error:${missionId}:${createdAt}:${message}`),
      missionId, status: 'worker_error', message, createdAt };
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, `${event.missionId}-${event.id}.json`);
    await writeJsonAtomic(path, event);
    return { recorded: true, event };
  }

  async sync(states) {
    const events = [];
    for (const state of states) if (missionIsFinal(state)) events.push((await this.record(state)).event);
    return events;
  }

  async list() {
    let names;
    try { names = await readdir(this.root); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const events = [];
    for (const name of names.filter(name => /^[a-z0-9][a-z0-9-]{2,79}-[a-f0-9]{64}\.json$/.test(name)).sort()) {
      const event = JSON.parse(await readFile(join(this.root, name), 'utf8'));
      if (event.kind === 'worker_error') {
        assert(event.status === 'worker_error' && typeof event.missionId === 'string' &&
          typeof event.message === 'string' && event.message.trim() && event.message.length <= 500 &&
          typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt)) &&
          hash(`worker_error:${event.missionId}:${event.createdAt}:${event.message}`) === event.id,
        'invalid background worker error notification');
      } else {
        assert(event.kind === 'mission_terminal' && typeof event.id === 'string' && /^[a-f0-9]{64}$/.test(event.id) &&
          typeof event.missionId === 'string' && typeof event.status === 'string' &&
          typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt)) &&
          Number.isSafeInteger(event.checkpointEventCount) &&
          hash(`${event.missionId}:${event.status}:${event.createdAt}:${event.checkpointEventCount}`) === event.id,
        'invalid mission notification event');
      }
      events.push(event);
    }
    return events.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
}

export async function recordMissionWorkerError({ root, feed, missionId, message, createdAt = new Date().toISOString() } = {}) {
  assert(root && feed instanceof MissionNotificationFeed && typeof missionId === 'string' &&
    /^[a-z0-9][a-z0-9-]{2,79}$/.test(missionId) && typeof message === 'string' && message.trim() &&
    message.length <= 500 && Number.isFinite(Date.parse(createdAt)), 'invalid background worker error record');
  message = message.trim();
  const errorRoot = join(resolve(root), '.worker-errors');
  await mkdir(errorRoot, { recursive: true });
  await writeJsonAtomic(join(errorRoot, `${missionId}.json`), { missionId, message, updatedAt: createdAt });
  await feed.recordWorkerError({ missionId, message, createdAt });
}

export async function launchMissionWorker({ missionId, storeRoot, evidenceRoot, workspacePath,
  notificationsRoot, workspaceStateRoot: lockRoot, leaseToken, expectedBranch, env = process.env, spawnProcess = spawn } = {}) {
  assert(typeof missionId === 'string' && /^[a-z0-9][a-z0-9-]{2,79}$/.test(missionId), 'valid mission id required');
  assert(storeRoot && evidenceRoot && workspacePath && lockRoot && typeof leaseToken === 'string' && leaseToken,
    'mission worker paths and workspace reservation required');
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    safeEnvironmentNames.has(key.toUpperCase()) && typeof value === 'string'));
  Object.assign(childEnv, { VILLAGE_MISSION_ROOT: resolve(storeRoot),
    VILLAGE_MISSION_EVIDENCE_ROOT: resolve(evidenceRoot), VILLAGE_MISSION_WORKSPACE: resolve(workspacePath),
    VILLAGE_MISSION_NOTIFICATIONS_ROOT: resolve(notificationsRoot || join(storeRoot, '.notifications')),
    VILLAGE_MISSION_WORKSPACE_STATE_ROOT: resolve(lockRoot), VILLAGE_MISSION_LEASE_TOKEN: leaseToken,
    VILLAGE_MISSION_EXPECTED_BRANCH: expectedBranch || '' });
  const workerPath = fileURLToPath(new URL('./mission-worker.mjs', import.meta.url));
  const child = spawnProcess(process.execPath, [workerPath, missionId], {
    cwd: resolve(workspacePath), env: childEnv, detached: true, windowsHide: true, stdio: 'ignore',
  });
  await new Promise((resolvePromise, rejectPromise) => {
    child.once('spawn', resolvePromise);
    child.once('error', rejectPromise);
  });
  child.unref();
  return { pid: child.pid };
}

export class MissionBackgroundWorker {
  constructor({ store, runner, handlers, feed, root, storeRoot, leaseToken } = {}) {
    if (!store || !runner || !handlers || !feed || !root || !storeRoot || !leaseToken) {
      throw new Error('background mission worker dependencies required');
    }
    this.store = store;
    this.runner = runner;
    this.handlers = handlers;
    this.feed = feed;
    this.root = resolve(root);
    this.storeRoot = resolve(storeRoot);
    this.leaseToken = leaseToken;
  }

  async run(missionId) {
    const lease = await readWorkspaceLease(this.root);
    assert(lease && lease.missionId === missionId && lease.storeRoot === this.storeRoot && lease.token === this.leaseToken,
      'workspace reservation does not match this mission');
    const lock = await acquireLocalLock(join(this.root, '.worker.lock'), {
      busyMessage: 'another mission worker is active; the shared workspace is serialized',
      owner: { missionId },
    });
    let releaseLease = false;
    try {
      await updateWorkspaceMission({ root: this.root, missionId, storeRoot: this.storeRoot,
        token: this.leaseToken, pid: process.pid });
      const state = await this.store.get(missionId);
      if (missionIsTerminal(state)) {
        await this.feed.record(state);
        releaseLease = ['accepted_preview', 'cancelled'].includes(state.status);
        return state;
      }
      const otherActive = (await this.store.list()).find(item => item.id !== missionId && !missionIsTerminal(item));
      if (otherActive) throw new Error(`mission ${otherActive.id} is still active; this single workspace cannot run overlapping missions`);
      const result = await this.runner.run(missionId, this.handlers);
      if (missionIsFinal(result)) await this.feed.record(result);
      releaseLease = ['accepted_preview', 'cancelled'].includes(result.status);
      return result;
    } finally {
      await lock.release();
      if (releaseLease) await releaseWorkspaceMission({ root: this.root, missionId,
        storeRoot: this.storeRoot, token: this.leaseToken });
    }
  }
}

export async function readMissionBackgroundStatus({ root, missionId, feed } = {}) {
  assert(root && typeof missionId === 'string' && /^[a-z0-9][a-z0-9-]{2,79}$/.test(missionId),
    'mission background status identity required');
  let lock = null;
  try {
    lock = JSON.parse(await readFile(join(root, '.worker.lock'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('background worker lock is unreadable; inspect before clearing it');
  }
  let workerError = null;
  try { workerError = JSON.parse(await readFile(join(root, '.worker-errors', `${missionId}.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('background worker error record is unreadable'); }
  const notifications = feed ? (await feed.list()).filter(event => event.missionId === missionId) : [];
  let processAlive = false;
  if (Number.isSafeInteger(lock?.pid) && lock.pid > 0) {
    try { process.kill(lock.pid, 0); processAlive = true; }
    catch (error) { if (error.code !== 'ESRCH') processAlive = true; }
  }
  const lease = await readWorkspaceLease(root);
  let leaseProcessAlive = false;
  if (Number.isSafeInteger(lease?.pid) && lease.pid > 0) {
    try { process.kill(lease.pid, 0); leaseProcessAlive = true; }
    catch (error) { if (error.code !== 'ESRCH') leaseProcessAlive = true; }
  }
  return { worker: lock ? { missionId: typeof lock.missionId === 'string' ? lock.missionId : null,
    pid: lock.pid, createdAt: lock.createdAt, processAlive } : null,
    reservation: lease ? { missionId: lease.missionId, storeRoot: lease.storeRoot,
      pid: lease.pid, createdAt: lease.createdAt, processAlive: leaseProcessAlive } : null,
    workerError, notifications };
}

