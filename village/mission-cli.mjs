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
  if (requireClean) requireValue(!(await git(root, 'status', '--porcelain')), 'mission workspace must be clean before mission start');
  return { root, branch, remote };
}

export function missionPaths(env = process.env) {
  const base = env.VILLAGE_MISSION_HOME || join(homedir(), '.agent-village');
  return { root: resolve(env.VILLAGE_MISSION_ROOT || join(base, 'missions')),
    evidence: resolve(env.VILLAGE_MISSION_EVIDENCE_ROOT || join(base, 'evidence')),
    workspace: env.VILLAGE_MISSION_WORKSPACE };
}

async function readMissionInput(path) {
  const source = await readFile(path, 'utf8');
  requireValue(Buffer.byteLength(source, 'utf8') <= 64000, 'mission input exceeds 64 KiB');
  const input = JSON.parse(source);
  const allowed = new Set(['id', 'goal', 'destination', 'artifactId', 'constraints', 'maxAttempts', 'maxRevisions']);
  requireValue(Object.keys(input).every(key => allowed.has(key)), 'mission input contains unsupported fields');
  requireValue(input.constraints === undefined || Array.isArray(input.constraints) &&
    input.constraints.every(item => typeof item === 'string'), 'mission constraints must be a list of text');
  const maxAttempts = input.maxAttempts ?? 2;
  const maxRevisions = input.maxRevisions ?? 1;
  requireValue(Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 2,
    'CLI attempt limit must be 1-2');
  requireValue(Number.isSafeInteger(maxRevisions) && maxRevisions >= 0 && maxRevisions <= 1,
    'CLI revision limit must be 0-1');
  const destination = new URL(input.destination);
  requireValue(['http:', 'https:'].includes(destination.protocol) && !destination.username && !destination.password,
    'mission destination must be an HTTP(S) URL without credentials');
  return { ...input, repo: REPO, destination: destination.href.replace(/\/$/, ''),
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
  confirm = askForAgreement } = {}) {
  const [command, ...args] = argv;
  const paths = missionPaths(env);
  requireValue(paths.workspace, 'set VILLAGE_MISSION_WORKSPACE to a clean startupsandcode/agent-village feature branch');
  const workspace = await inspectMissionWorkspace(paths.workspace, { requireClean: command === 'start' });
  const store = new MissionStore(paths.root);
  if (command === 'start') {
    requireValue(args.length === 1, 'start <mission-input.json> required');
    const input = await readMissionInput(resolve(args[0]));
    const intake = new MayaMissionIntake({ codex, workspacePath: workspace.root });
    const proposal = await intake.propose(input);
    if (proposal.status !== 'agreed') {
      return { status: proposal.status, summary: proposal.summary, questions: proposal.questions };
    }
    const response = await confirm(proposal.proposalId, proposal.summary, proposal.acceptanceCriteria);
    if (response !== 'YES') return { status: 'not_started', reason: 'Maya proposal was not accepted' };
    const missionInput = intake.accept(proposal.proposalId, `I agree to mission ${proposal.proposalId}`);
    const mission = await store.create(missionInput);
    const runtime = createMissionRuntime({ storeRoot: paths.root, evidenceRoot: paths.evidence,
      workspacePath: workspace.root, codex });
    return await runtime.runner.run(mission.id, runtime.handlers);
  }
  requireValue(args.length === 1, `${command} <mission-id> required`);
  const [id] = args;
  if (command === 'cancel') {
    await store.cancel(id);
    return { id, status: 'cancellation_requested' };
  }
  if (command === 'show') return await store.get(id);
  if (command === 'resume') {
    const state = await store.get(id);
    requireValue(['ready', 'failed'].includes(state.status), 'mission is not at a resumable stage; uncertain in-flight work needs manual reconciliation');
    const runtime = createMissionRuntime({ storeRoot: paths.root, evidenceRoot: paths.evidence,
      workspacePath: workspace.root, codex });
    return await runtime.runner.run(id, runtime.handlers);
  }
  throw new Error('start, resume, show, or cancel required');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
