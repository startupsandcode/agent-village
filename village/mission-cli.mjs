#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { CodexRunner } from './codex-runner.mjs';
import { MayaMissionIntake } from './mission-intake.mjs';
import { MissionStore } from './mission-runner.mjs';
import { createMissionRuntime } from './mission-runtime.mjs';
import { configuredVercelPreviewTargets, validateVercelPreviewTarget,
  vercelPreviewDestination } from './vercel-preview-deployer.mjs';
import { reserveMissionIntakeCall } from './mission-budget.mjs';
import { verifyCodexSchemaRejection } from './mission-preexecution-recovery.mjs';
import { launchMissionWorker, MissionNotificationFeed, acquireLocalLock, readMissionBackgroundStatus,
  readWorkspaceLease, reserveWorkspaceMission, updateWorkspaceMission, workspaceStateRoot,
  recordMissionWorkerError } from './mission-background.mjs';

const execFileAsync = promisify(execFile);
const REPO = 'startupsandcode/agent-village';
const roles = { design: 'susie', build: 'sam', functional_review: 'quinn', visual_review: 'susie' };
const safetyConstraints = [
  'No production release, merge, or publishing action.',
  'No paid resource provisioning or paid third-party service.',
  'No new credentials, permissions, outreach, or access grants.',
  'Only modify work owned by startupsandcode in the configured clean feature branch.',
];

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

async function git(cwd, ...args) {
  const { stdout: output } = await execFileAsync('git', args, { cwd, timeout: 15000, windowsHide: true });
  return output.trim();
}

export async function inspectMissionWorkspace(workspacePath, { requireClean = false } = {}) {
  const root = await realpath(workspacePath);
  const actualRoot = await git(root, 'rev-parse', '--show-toplevel');
  requireValue((await realpath(actualRoot)).toLowerCase() === root.toLowerCase(), 'mission workspace must be its repository root');
  const remote = await git(root, 'config', '--get', 'remote.origin.url');
  requireValue(/^(?:git@github\.com:|https:\/\/github\.com\/)startupsandcode\/agent-village(?:\.git)?\/?$/i.test(remote),
    'mission workspace must belong to startupsandcode/agent-village');
  const branch = await git(root, 'branch', '--show-current');
  requireValue(branch && !['main', 'master'].includes(branch), 'mission workspace must use a named feature branch');
  if (requireClean) requireValue(!(await git(root, 'status', '--porcelain')), 'mission workspace must be clean before it starts or resumes work');
  return { root, branch, remote };
}

export function missionPaths(env = process.env) {
  const home = resolve(env.VILLAGE_MISSION_HOME || join(homedir(), '.agent-village'));
  const root = resolve(env.VILLAGE_MISSION_ROOT || join(home, 'missions'));
  return { home, root,
    evidence: resolve(env.VILLAGE_MISSION_EVIDENCE_ROOT || join(home, 'evidence')),
    notifications: resolve(env.VILLAGE_MISSION_NOTIFICATIONS_ROOT || join(root, '.notifications')),
    workspace: env.VILLAGE_MISSION_WORKSPACE };
}

export async function readMissionInput(path, workspaceBranch, env = process.env) {
  const source = await readFile(path, 'utf8');
  requireValue(Buffer.byteLength(source, 'utf8') <= 64000, 'mission input exceeds 64 KiB');
  const input = JSON.parse(source);
  const allowed = new Set(['id', 'goal', 'destination', 'previewTarget', 'artifactId', 'constraints', 'maxAttempts', 'maxRevisions']);
  requireValue(Object.keys(input).every(key => allowed.has(key)), 'mission input contains unsupported fields');
  requireValue(input.constraints === undefined || Array.isArray(input.constraints) &&
    input.constraints.every(item => typeof item === 'string'), 'mission constraints must be a list of text');
  const maxAttempts = input.maxAttempts ?? 2;
  const maxRevisions = input.maxRevisions ?? 1;
  requireValue(Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 2,
    'CLI attempt limit must be 1-2');
  requireValue(Number.isSafeInteger(maxRevisions) && maxRevisions >= 0 && maxRevisions <= 1,
    'CLI revision limit must be 0-1');
  let destination;
  let previewTarget;
  if (input.previewTarget !== undefined) {
    requireValue(typeof env.VILLAGE_VERCEL_PREVIEW_TARGETS === 'string' && env.VILLAGE_VERCEL_PREVIEW_TARGETS.trim(),
      'VILLAGE_VERCEL_PREVIEW_TARGETS must explicitly allow this Vercel project and team');
    const targets = configuredVercelPreviewTargets(env);
    previewTarget = validateVercelPreviewTarget(input.previewTarget, targets);
    destination = vercelPreviewDestination(previewTarget);
    requireValue(input.destination === undefined || input.destination === destination,
      'mission destination must match its configured Vercel preview project and team');
  } else {
    requireValue(typeof input.destination === 'string' && input.destination.trim(), 'mission preview destination required');
    const destinationUrl = new URL(input.destination);
    requireValue(['http:', 'https:'].includes(destinationUrl.protocol) && !destinationUrl.username && !destinationUrl.password &&
      !destinationUrl.search && !destinationUrl.hash,
    'mission destination must be an HTTP(S) URL without credentials, query, or fragment');
    destination = destinationUrl.href.replace(/\/$/, '');
  }
  return { ...input, repo: REPO, destination,
    ...(previewTarget ? { previewTarget: structuredClone(previewTarget) } : {}),
    workspaceBranch,
    constraints: [...new Set([...(input.constraints ?? []), ...safetyConstraints])],
    team: { id: 'design-led-single-team', roles }, maxAttempts, maxRevisions };
}

async function askForAgreement(proposalId, summary, criteria) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\nMaya's mission agreement\n${summary}\n\nAcceptance criteria:\n`);
    for (const item of criteria) stdout.write(`- ${item}\n`);
    const confirmation = await rl.question('\nType YES to start this bounded mission, or anything else to stop: ');
    return confirmation;
  } finally { rl.close(); }
}

export async function main(argv = process.argv.slice(2), { env = process.env, codex = new CodexRunner(),
  confirm = askForAgreement, background = true, spawnWorker = launchMissionWorker, processCheck,
  inspectBackgroundStatus = readMissionBackgroundStatus } = {}) {
  const [command, ...args] = argv;
  const paths = missionPaths(env);
  const store = new MissionStore(paths.root);
  if (command === 'notifications') {
    requireValue(args.length <= 1, 'notifications [mission-id] required');
    const feed = new MissionNotificationFeed(paths.notifications);
    await feed.sync(await store.list());
    const events = await feed.list();
    return args.length === 0 ? events : events.filter(event => event.missionId === args[0]);
  }
  if (command === 'status') {
    requireValue(args.length === 1, 'status <mission-id> required');
    const feed = new MissionNotificationFeed(paths.notifications);
    await feed.sync(await store.list());
    const mission = await store.get(args[0]);
    const workspace = paths.workspace ? await inspectMissionWorkspace(paths.workspace) : null;
    const lockRoot = workspace ? workspaceStateRoot(paths.home, workspace.root) : paths.root;
    return { mission, ...await inspectBackgroundStatus({ root: lockRoot, missionId: args[0], feed, processCheck }) };
  }
  if (command === 'show') {
    requireValue(args.length === 1, 'show <mission-id> required');
    return await store.get(args[0]);
  }
  if (command === 'cancel') {
    requireValue(args.length === 1, 'cancel <mission-id> required');
    await store.cancel(args[0]);
    return { id: args[0], status: 'cancellation_requested' };
  }
  requireValue(paths.workspace, 'set VILLAGE_MISSION_WORKSPACE to a clean startupsandcode/agent-village feature branch');
  if (command === 'retry-preflight') {
    requireValue(args.length === 2, 'retry-preflight <mission-id> <Codex-session-log> required');
    const [id, sessionPath] = args;
    const workspace = await inspectMissionWorkspace(paths.workspace, { requireClean: true });
    const state = await store.get(id);
    requireValue(state.workspaceBranch === workspace.branch, 'mission branch changed; return to the original branch before recovery');
    const proof = await verifyCodexSchemaRejection({ sessionPath, mission: state, workspacePath: workspace.root, codexHome: env.CODEX_HOME });
    const lockRoot = workspaceStateRoot(paths.home, workspace.root);
    const feed = new MissionNotificationFeed(paths.notifications);
    const backgroundStatus = await inspectBackgroundStatus({ root: lockRoot, missionId: id, feed, processCheck });
    const lease = await readWorkspaceLease(lockRoot);
    requireValue(!backgroundStatus.worker &&
      lease && lease.missionId === id && lease.storeRoot === paths.root && lease.branch === workspace.branch &&
      Number.isSafeInteger(lease.pid) && lease.pid > 0 && lease.pid === backgroundStatus.reservation?.pid &&
      !backgroundStatus.reservation.processAlive,
    'mission worker or workspace reservation is not safely stopped for pre-execution recovery');
    const recovered = await store.authorizePreExecutionSchemaRetry(id, proof);
    return { id, status: recovered.status, retryStage: recovered.currentStage,
      priorFailureRetained: recovered.events.at(-1)?.status === 'failed',
      roleCallsReserved: recovered.mayaIntakeCalls + Object.values(recovered.attempts).reduce((total, attempt) => total + attempt, 0) };
  }
  const workspace = await inspectMissionWorkspace(paths.workspace, { requireClean: command === 'start' });
  if (command === 'start') {
    requireValue(args.length === 1, 'start <mission-input.json> required');
    const input = await readMissionInput(resolve(args[0]), workspace.branch, env);
    const lockRoot = workspaceStateRoot(paths.home, workspace.root);
    const dispatchLock = await acquireLocalLock(join(lockRoot, '.dispatch.lock'), {
      busyMessage: 'another mission is being accepted; this shared workspace permits only one mission at a time',
    });
    try {
      const reservation = await readWorkspaceLease(lockRoot);
      requireValue(!reservation, `workspace already has active mission ${reservation?.missionId ?? 'unknown'} from store ${reservation?.storeRoot ?? 'unknown'}; reconcile before starting another`);
      const storedMissions = await store.list();
      requireValue(!storedMissions.some(state => state.id === input.id), 'mission id already exists; use its existing checkpoint instead of asking Maya again');
      const active = storedMissions.find(state => !['accepted_preview', 'cancelled'].includes(state.status));
      requireValue(!active, `mission ${active?.id} is still active or needs reconciliation before this single workspace can accept another mission`);
      const mayaIntakeCalls = await reserveMissionIntakeCall(paths.root, input.id);
      const intake = new MayaMissionIntake({ codex, workspacePath: workspace.root });
      const proposal = await intake.propose(input);
      if (proposal.status !== 'agreed') {
        return { status: proposal.status, summary: proposal.summary, questions: proposal.questions };
      }
      const response = await confirm(proposal.proposalId, proposal.summary, proposal.acceptanceCriteria);
      if (response !== 'YES') return { status: 'not_started', reason: 'Maya proposal was not accepted' };
      const acceptedWorkspace = await inspectMissionWorkspace(paths.workspace, { requireClean: true });
      requireValue(acceptedWorkspace.branch === workspace.branch, 'mission workspace branch changed during Maya agreement');
      const missionInput = { ...intake.accept(proposal.proposalId, `I agree to mission ${proposal.proposalId}`), mayaIntakeCalls };
      const mission = await store.create(missionInput);
      if (!background) {
        const runtime = createMissionRuntime({ storeRoot: paths.root, evidenceRoot: paths.evidence,
          workspacePath: workspace.root, codex });
        return await runtime.runner.run(mission.id, runtime.handlers);
      }
      const lease = await reserveWorkspaceMission({ root: lockRoot, missionId: mission.id,
        storeRoot: paths.root, branch: workspace.branch });
      let launched;
      try {
        launched = await spawnWorker({ missionId: mission.id, storeRoot: paths.root,
          evidenceRoot: paths.evidence, notificationsRoot: paths.notifications,
          workspacePath: workspace.root, workspaceStateRoot: lockRoot, leaseToken: lease.token,
          expectedBranch: workspace.branch, env });
        await updateWorkspaceMission({ root: lockRoot, missionId: mission.id, storeRoot: paths.root,
          token: lease.token, pid: launched.pid });
      } catch (error) {
        await recordMissionWorkerError({ root: lockRoot, feed: new MissionNotificationFeed(paths.notifications),
          missionId: mission.id, message: `worker launch failed: ${String(error?.message ?? 'spawn error').slice(0, 460)}` });
        throw error;
      }
      return { id: mission.id, status: 'queued', workerPid: launched.pid,
        statusCommand: `node village/mission-cli.mjs status ${mission.id}`,
        notificationsCommand: 'node village/mission-cli.mjs notifications' };
    } finally {
      await dispatchLock.release();
    }
  }
  requireValue(args.length === 1, `${command} <mission-id> required`);
  const [id] = args;
  if (command === 'resume' || command === 'worker') {
    const state = await store.get(id);
    requireValue(['ready', 'failed'].includes(state.status), 'mission is not at a resumable stage; uncertain in-flight work needs manual reconciliation');
    const resumeWorkspace = await inspectMissionWorkspace(paths.workspace, { requireClean: true });
    requireValue(typeof state.workspaceBranch === 'string' && resumeWorkspace.branch === state.workspaceBranch,
      'mission branch changed; return to the original branch and reconcile before resuming');
    if (command === 'worker') {
      const runtime = createMissionRuntime({ storeRoot: paths.root, evidenceRoot: paths.evidence,
        workspacePath: workspace.root, codex });
      const { MissionBackgroundWorker, MissionNotificationFeed } = await import('./mission-background.mjs');
      const worker = new MissionBackgroundWorker({ store, runner: runtime.runner, handlers: runtime.handlers,
        feed: new MissionNotificationFeed(paths.notifications), root: workspaceStateRoot(paths.home, workspace.root),
        storeRoot: paths.root, leaseToken: process.env.VILLAGE_MISSION_LEASE_TOKEN });
      return await worker.run(id);
    }
    const lockRoot = workspaceStateRoot(paths.home, workspace.root);
    const backgroundStatus = await inspectBackgroundStatus({ root: lockRoot, missionId: id,
      feed: new MissionNotificationFeed(paths.notifications), processCheck });
    const activeReservation = await readWorkspaceLease(lockRoot);
    if (activeReservation && (activeReservation.missionId !== id || activeReservation.storeRoot !== paths.root)) {
      return { id, status: 'workspace_busy', activeMissionId: activeReservation.missionId };
    }
    if (backgroundStatus.worker?.processAlive) {
      if (backgroundStatus.worker.missionId === id) return { id, status: 'already_running', workerPid: backgroundStatus.worker.pid,
        statusCommand: `node village/mission-cli.mjs status ${id}` };
      return { id, status: 'workspace_busy', activeMissionId: backgroundStatus.worker.missionId,
        workerPid: backgroundStatus.worker.pid };
    }
    requireValue(!backgroundStatus.worker, 'a stale background worker lock remains; inspect and reconcile before resuming');
    const durableWorkerError = backgroundStatus.workerError || backgroundStatus.notifications.some(event => event.kind === 'worker_error');
    const provenPreExecutionRecovery = state.preExecutionRecovery?.status === 'authorized' &&
      state.preExecutionRecovery.stage === 'susie_design' && state.currentStage === 'susie_design';
    if (activeReservation && !backgroundStatus.reservation?.processAlive && state.status !== 'failed' &&
        !durableWorkerError && !provenPreExecutionRecovery) {
      throw new Error('a queued mission reservation has no live worker; inspect status and reconcile before relaunching');
    }
    const lease = activeReservation ?? await reserveWorkspaceMission({ root: lockRoot, missionId: id,
      storeRoot: paths.root, branch: state.workspaceBranch });
    const launched = await spawnWorker({ missionId: id, storeRoot: paths.root,
      evidenceRoot: paths.evidence, notificationsRoot: paths.notifications,
      workspacePath: workspace.root, workspaceStateRoot: lockRoot, leaseToken: lease.token,
      expectedBranch: workspace.branch, env });
    await updateWorkspaceMission({ root: lockRoot, missionId: id, storeRoot: paths.root,
      token: lease.token, pid: launched.pid });
    return { id, status: 'queued', workerPid: launched.pid,
      statusCommand: `node village/mission-cli.mjs status ${id}`,
      notificationsCommand: 'node village/mission-cli.mjs notifications' };
  }
  throw new Error('start, resume, worker, retry-preflight, status, show, cancel, or notifications required');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
