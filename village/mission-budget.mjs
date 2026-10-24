import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLocalLock } from './mission-background.mjs';
import { MAX_MISSION_ROLE_CALLS } from './mission-runner.mjs';

export async function reserveMissionIntakeCall(root, missionId) {
  if (!root || typeof missionId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(missionId)) {
    throw new Error('mission intake budget identity is invalid');
  }
  const budgetRoot = resolve(root);
  const lock = await acquireLocalLock(join(budgetRoot, '.intake-call-locks', `${missionId}.lock`), {
    busyMessage: 'a Maya intake call is already being reserved for this mission id',
  });
  try {
    const path = join(budgetRoot, '.intake-calls', `${missionId}.json`);
    let current = { version: 1, missionId, calls: 0 };
    try {
      current = JSON.parse(await readFile(path, 'utf8'));
      if (current.version !== 1 || current.missionId !== missionId || !Number.isSafeInteger(current.calls) ||
          current.calls < 0 || current.calls > MAX_MISSION_ROLE_CALLS) {
        throw new Error('mission intake call ledger is invalid; reconcile before calling Maya again');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current.calls >= MAX_MISSION_ROLE_CALLS) throw new Error(`mission reached the ${MAX_MISSION_ROLE_CALLS}-call Codex CLI limit`);
    const next = { version: 1, missionId, calls: current.calls + 1 };
    await mkdir(budgetRoot, { recursive: true });
    await mkdir(join(budgetRoot, '.intake-calls'), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx');
      await handle.writeFile(`${JSON.stringify(next)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, path);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return next.calls;
  } finally {
    await lock.release();
  }
}
