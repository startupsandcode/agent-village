#!/usr/bin/env node
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MissionStore } from './mission-runner.mjs';
import { createMissionRuntime } from './mission-runtime.mjs';
import { MissionBackgroundWorker, MissionNotificationFeed, recordMissionWorkerError } from './mission-background.mjs';
import { CodexRunner } from './codex-runner.mjs';

const [missionId, ...extra] = process.argv.slice(2);

async function main() {
  if (!missionId || extra.length) throw new Error('mission id required');
  const storeRoot = process.env.VILLAGE_MISSION_ROOT;
  const evidenceRoot = process.env.VILLAGE_MISSION_EVIDENCE_ROOT;
  const workspacePath = process.env.VILLAGE_MISSION_WORKSPACE;
  const workspaceStateRoot = process.env.VILLAGE_MISSION_WORKSPACE_STATE_ROOT;
  const leaseToken = process.env.VILLAGE_MISSION_LEASE_TOKEN;
  if (!storeRoot || !evidenceRoot || !workspacePath || !workspaceStateRoot || !leaseToken) throw new Error('mission worker paths and workspace reservation are not configured');
  const expectedBranch = process.env.VILLAGE_MISSION_EXPECTED_BRANCH;
  const { inspectMissionWorkspace } = await import('./mission-cli.mjs');
  const workspace = await inspectMissionWorkspace(workspacePath, { requireClean: true });
  if (!expectedBranch || workspace.branch !== expectedBranch) throw new Error('mission workspace branch changed before background execution');
  const store = new MissionStore(storeRoot);
  const mission = await store.get(missionId);
  if (mission.workspaceBranch !== workspace.branch) throw new Error('mission branch no longer matches its accepted checkpoint');
  const notificationsRoot = process.env.VILLAGE_MISSION_NOTIFICATIONS_ROOT || join(storeRoot, '.notifications');
  const feed = new MissionNotificationFeed(notificationsRoot);
  const runtime = createMissionRuntime({ storeRoot, evidenceRoot, workspacePath, codex: new CodexRunner() });
  const worker = new MissionBackgroundWorker({ store, runner: runtime.runner, handlers: runtime.handlers,
    feed, root: workspaceStateRoot, storeRoot, leaseToken });
  const result = await worker.run(missionId);
  await unlink(join(storeRoot, '.worker-errors', `${missionId}.json`)).catch(() => {});
  process.stdout.write(`${JSON.stringify({ id: result.id, status: result.status })}\n`);
}

main().catch(async error => {
  const storeRoot = process.env.VILLAGE_MISSION_ROOT;
  if (error?.code !== 'MISSION_LOCK_BUSY' && storeRoot && missionId && /^[a-z0-9][a-z0-9-]{2,79}$/.test(missionId)) {
    try {
      const message = String(error?.message ?? 'background worker failed').slice(0, 500);
      const notificationsRoot = process.env.VILLAGE_MISSION_NOTIFICATIONS_ROOT || join(storeRoot, '.notifications');
      const feed = new MissionNotificationFeed(notificationsRoot);
      await recordMissionWorkerError({ root: workspaceStateRoot || storeRoot, feed, missionId, message });
    } catch {}
  }
  process.stderr.write(`${error?.message ?? 'background worker failed'}\n`);
  process.exitCode = 1;
});

