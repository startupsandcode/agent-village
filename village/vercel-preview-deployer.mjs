import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';

const REPO = 'startupsandcode/agent-village';
const MAX_ARTIFACT_FILES = 1000;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_WAIT_MS = 15 * 60 * 1000;
const CLI_TIMEOUT_MS = 5 * 60 * 1000;
const idPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function sameVercelPreviewTarget(left, right) {
  return left?.provider === right?.provider && left?.projectId === right?.projectId &&
    left?.teamId === right?.teamId && left?.environment === right?.environment &&
    left?.projectSlug === right?.projectSlug && left?.teamSlug === right?.teamSlug;
}

export function validateVercelPreviewTarget(target, configuredTargets) {
  requireValue(target && target.provider === 'vercel' && target.environment === 'preview',
    'preview deployment adapter is preview-only');
  requireValue(Object.keys(target).length === 6 && ['provider', 'projectId', 'teamId', 'environment', 'projectSlug', 'teamSlug']
    .every(key => Object.hasOwn(target, key)), 'approved Vercel target must contain only project and team identity fields');
  requireValue(typeof target.projectId === 'string' && /^prj_[A-Za-z0-9]{8,}$/.test(target.projectId) &&
    typeof target.teamId === 'string' && /^team_[A-Za-z0-9]{8,}$/.test(target.teamId) &&
    typeof target.projectSlug === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(target.projectSlug) &&
    typeof target.teamSlug === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(target.teamSlug),
  'invalid approved Vercel preview target');
  const configured = configuredTargets.find(item => sameVercelPreviewTarget(item, target));
  requireValue(configured, 'Vercel preview target is not allowlisted');
  return configured;
}

export function vercelPreviewDestination(target) {
  validateVercelPreviewTarget(target, [target]);
  return `vercel-preview://${target.teamSlug}/${target.projectSlug}`;
}

export function configuredVercelPreviewTargets(env = process.env) {
  if (!env.VILLAGE_VERCEL_PREVIEW_TARGETS) return [];
  let targets;
  try { targets = JSON.parse(env.VILLAGE_VERCEL_PREVIEW_TARGETS); }
  catch { throw new Error('VILLAGE_VERCEL_PREVIEW_TARGETS must be valid JSON'); }
  requireValue(Array.isArray(targets) && targets.length > 0 && targets.length <= 8,
    'VILLAGE_VERCEL_PREVIEW_TARGETS must be a nonempty list of at most 8 targets');
  const seen = new Set();
  for (const target of targets) {
    validateVercelPreviewTarget(target, targets);
    const key = `${target.teamId}:${target.projectId}`;
    requireValue(!seen.has(key), 'VILLAGE_VERCEL_PREVIEW_TARGETS contains a duplicate project');
    seen.add(key);
  }
  return structuredClone(targets);
}

function metadataFor(mission, fingerprint) {
  return { villageMissionId: mission.id, villageArtifactId: mission.artifactId,
    villageArtifactSha256: fingerprint };
}

export function vercelPreviewOrigin(value, target) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Vercel did not return a valid preview URL'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
    (url.pathname === '' || url.pathname === '/'),
    'Vercel preview URL must be an HTTPS origin without credentials, port, query, or fragment');
  const host = url.hostname.toLowerCase();
  const projectPrefix = `${target.projectSlug.toLowerCase()}-`;
  const teamSuffix = `-${target.teamSlug.toLowerCase()}.vercel.app`;
  const deploymentName = host.startsWith(projectPrefix) && host.endsWith(teamSuffix) ?
    host.slice(projectPrefix.length, -teamSuffix.length) : '';
  requireValue(/^[a-z0-9][a-z0-9-]*$/i.test(deploymentName),
    'Vercel preview URL host is not allowlisted');
  return url.origin;
}

function isSecretPath(path) {
  return path.split(/[\\/]/).some(part => part === '.git' || part === '.vercel' || part === 'node_modules' ||
    part === '.aws' || part === '.ssh' || part === '.codex' || /^\.env(?:\.|$)/i.test(part) ||
    /^\.npmrc$/i.test(part) || /^\.pypirc$/i.test(part) || /^\.?(?:vercelignore|gitignore)$/i.test(part) ||
    /^(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(part) ||
    /(?:secret|credential|private[-_]?key)/i.test(part) ||
    /\.(?:pem|key|p12|pfx)$/i.test(part));
}

async function collectArtifact(root) {
  const rootPath = resolve(root);
  const rootInfo = await lstat(rootPath);
  requireValue(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'artifact root must be a real directory');
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(rootPath, path).split(sep).join('/');
      if (isSecretPath(relativePath)) continue;
      const info = await lstat(path);
      requireValue(!info.isSymbolicLink(), 'artifact cannot contain symbolic links');
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        requireValue(files.length < MAX_ARTIFACT_FILES, 'preview artifact exceeds the file count limit');
        const bytes = await readFile(path);
        files.push({ relativePath, bytes });
      } else throw new Error('preview artifact contains an unsupported file type');
    }
  }
  await visit(rootPath);
  requireValue(files.length > 0, 'preview artifact is empty');
  files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  requireValue(totalBytes <= MAX_ARTIFACT_BYTES, 'preview artifact exceeds the 50 MiB upload limit');
  return files;
}

async function stageArtifact(files, artifactId, target) {
  const html = files.find(file => file.relativePath === 'index.html');
  requireValue(html, 'preview artifact must have a root index.html');
  const marker = `<meta name="village-artifact-id" content="${artifactId}">`;
  requireValue(html.bytes.toString('utf8').includes(marker), 'preview artifact marker does not match the approved artifact');
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath, 'utf8');
    hash.update('\0');
    hash.update(String(file.bytes.byteLength), 'utf8');
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  const fingerprint = hash.digest('hex');
  const stageRoot = await mkdtemp(join(tmpdir(), 'village-preview-artifact-'));
  try {
    // The approved Astra Lab project has rootDirectory="app". Keep a root-level
    // prebuilt output for root-based projects and stage the exact same static
    // bytes under app/ so Vercel CLI honors this project's existing root setting.
    for (const projectRoot of [stageRoot, join(stageRoot, 'app')]) {
      const outputRoot = join(projectRoot, '.vercel', 'output');
      const staticRoot = join(outputRoot, 'static');
      await mkdir(staticRoot, { recursive: true });
      await writeFile(join(outputRoot, 'config.json'), '{"version":3}\n', { flag: 'wx' });
      await writeFile(join(projectRoot, '.vercel', 'project.json'), `${JSON.stringify({ projectId: target.projectId, orgId: target.teamId })}\n`,
        { flag: 'wx' });
      for (const file of files) {
        const targetPath = join(staticRoot, file.relativePath);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.bytes, { flag: 'wx' });
      }
    }
    return { stageRoot, fingerprint };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function inside(root, target) {
  const path = relative(root, target);
  const resolved = resolve(target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && resolved.startsWith(`${root}${sep}`);
}

async function readJournal(path) {
  const info = await lstat(path);
  requireValue(info.isFile() && !info.isSymbolicLink(), 'preview deployment journal must be a regular file');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('preview deployment journal is invalid; manual reconciliation required'); }
}

async function writeJournal(path, value, { create = false } = {}) {
  let handle;
  let truncate = false;
  if (create) handle = await open(path, 'wx');
  else {
    const info = await lstat(path);
    requireValue(info.isFile() && !info.isSymbolicLink(), 'preview deployment journal must be a regular file');
    handle = await open(path, 'r+');
    truncate = true;
  }
  try {
    if (truncate) await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  }
  finally { await handle.close(); }
}

function parseCliJson(output, description) {
  const text = String(output ?? '').trim();
  try { return JSON.parse(text); }
  catch { throw new Error(`Vercel CLI returned invalid ${description} JSON`); }
}

async function vercelCommand(args) {
  if (process.platform !== 'win32') return { executable: 'vercel', args };
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const shim = join(directory, 'vercel.cmd');
    const entry = join(directory, 'node_modules', 'vercel', 'dist', 'vc.js');
    try { await Promise.all([access(shim), access(entry)]); return { executable: process.execPath, args: [entry, ...args] }; }
    catch {}
  }
  const error = new Error('official Vercel CLI npm installation was not found on PATH');
  error.submitted = false;
  throw error;
}

async function runCli(args, { cwd, timeoutMs = CLI_TIMEOUT_MS }) {
  let command;
  try { command = await vercelCommand(args); }
  catch (error) { error.submitted = false; throw error; }
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  for (const key of Object.keys(env)) {
    if (/^VERCEL_.*(?:TOKEN|SECRET|PASSWORD|BYPASS)$/i.test(key)) delete env[key];
  }
  delete env.VERCEL_ORG_ID;
  delete env.VERCEL_PROJECT_ID;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.executable, command.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let started = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    child.once('spawn', () => { started = true; });
    child.stdout.on('data', chunk => { if (stdout.length < 1024 * 1024) stdout += String(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += String(chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); error.submitted = false; rejectRun(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolveRun(stdout.trim());
      else {
        const error = new Error(timedOut ? 'Vercel CLI timed out' : `Vercel CLI failed${stderr ? `: ${stderr.slice(0, 500)}` : ''}`);
        error.submitted = started && !isKnownRootDirectoryPreflightFailure(error.message);
        rejectRun(error);
      }
    });
  });
}

export function isKnownRootDirectoryPreflightFailure(message) {
  return typeof message === 'string' && /Vercel CLI failed:\s*Retrieving project\.\s*Error: The provided path ".+\\app" does not exist\./s.test(message);
}

export class VercelCliClient {
  async whoami({ cwd = process.cwd() } = {}) {
    return await runCli(['whoami', '--non-interactive', '--no-color'], { cwd, timeoutMs: 30000 });
  }

  async getDevelopmentOidcToken({ projectId, teamSlug, cwd = process.cwd() }) {
    requireValue(/^prj_[A-Za-z0-9]{8,}$/.test(projectId) && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(teamSlug),
      'approved Vercel project and team are required for browser authentication');
    const marker = 'VILLAGE_OIDC_TOKEN=';
    const script = `process.stdout.write('${marker}' + (process.env.VERCEL_OIDC_TOKEN || '') + '\\n')`;
    const output = await runCli(['env', 'run', '--environment', 'development', '--project', projectId,
      '--scope', teamSlug, '--', process.execPath, '-e', script], { cwd, timeoutMs: 30000 });
    const tokenLine = output.split(/\r?\n/).findLast(line => line.startsWith(marker));
    const token = tokenLine?.slice(marker.length) ?? '';
    requireValue(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),
      'Vercel CLI did not provide a short-lived development OIDC token');
    return token;
  }

  async deploy({ artifactPath, projectId, teamId, target, prebuilt, meta }) {
    requireValue(target === 'preview' && prebuilt === true, 'Vercel CLI adapter is preview-only and prebuilt-only');
    requireValue(/^prj_[A-Za-z0-9]{8,}$/.test(projectId) && /^team_[A-Za-z0-9]{8,}$/.test(teamId),
      'Vercel project and team identifiers are required');
    const args = ['deploy', artifactPath, '--prebuilt', '--target', target, '--project', projectId, '--scope', teamId,
      '--yes', '--no-wait', '--json', '--no-color', '--non-interactive'];
    for (const [key, value] of Object.entries(meta)) args.push('--meta', `${key}=${value}`);
    return parseCliJson(await runCli(args, { cwd: artifactPath }), 'deployment');
  }

  async inspect(deploymentId, { teamId }) {
    return parseCliJson(await runCli(['inspect', deploymentId, '--scope', teamId, '--json', '--no-color', '--non-interactive'],
      { cwd: process.cwd(), timeoutMs: 30000 }), 'deployment inspection');
  }

  async listMissionDeployments({ missionId, target, cwd = process.cwd() }) {
    requireValue(idPattern.test(missionId) && target?.provider === 'vercel' && target.environment === 'preview',
      'approved mission and preview target are required for deployment reconciliation');
    const output = await runCli(['list', target.projectSlug, '--scope', target.teamSlug,
      '--meta', `villageMissionId=${missionId}`, '--json', '--limit', '100'], { cwd, timeoutMs: 30000 });
    const response = parseCliJson(output, 'deployment list');
    requireValue(response && Array.isArray(response.deployments), 'Vercel CLI deployment list response is invalid');
    return response.deployments;
  }
}

export class VercelPreviewDeployer {
  constructor({ workspaceRoot, stateRoot, targets, cli = new VercelCliClient(), sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
    pollIntervalMs = 2000, maxWaitMs = MAX_WAIT_MS } = {}) {
    requireValue(workspaceRoot && stateRoot && Array.isArray(targets) && targets.length > 0 && cli &&
      typeof cli.whoami === 'function' && typeof cli.deploy === 'function' && typeof cli.inspect === 'function',
    'preview workspace, state path, allowlisted target, and Vercel CLI adapter are required');
    requireValue(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 250 && pollIntervalMs <= 10000 &&
      Number.isSafeInteger(maxWaitMs) && maxWaitMs >= 0 && maxWaitMs <= MAX_WAIT_MS,
    'preview deployment wait must be bounded to 15 minutes');
    this.workspaceRoot = resolve(workspaceRoot);
    this.stateRoot = resolve(stateRoot);
    this.targets = targets;
    this.cli = cli;
    this.sleep = sleep;
    this.pollIntervalMs = pollIntervalMs;
    this.maxWaitMs = maxWaitMs;
  }

  journalPath(id, revision = 0) {
    if (!idPattern.test(id)) throw new Error('invalid mission id for preview deployment');
    requireValue(Number.isSafeInteger(revision) && revision >= 0 && revision <= 1, 'preview deployment revision limit exceeded');
    return join(this.stateRoot, revision === 0 ? `${id}.json` : `${id}-revision-${revision}.json`);
  }

  async deploy({ mission, artifactRoot, isCancelled = async () => false }) {
    requireValue(mission && mission.repo === REPO && idPattern.test(mission.id) &&
      typeof mission.artifactId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mission.artifactId) &&
      mission.mayaAgreement?.acceptedByUser === true && typeof isCancelled === 'function',
    'user-accepted Agent Village mission identity required');
    requireValue(!await isCancelled(), 'preview deployment cancelled before submission');
    requireValue(sameVercelPreviewTarget(mission.previewTarget, mission.mayaAgreement.previewTarget),
      'Vercel preview target must be included in Maya agreement');
    const target = validateVercelPreviewTarget(mission.previewTarget, this.targets);
    const [workspacePath, artifactPath] = await Promise.all([realpath(this.workspaceRoot), realpath(artifactRoot)]);
    requireValue(inside(workspacePath, artifactPath), 'artifact must be inside the approved workspace');
    const files = await collectArtifact(artifactPath);
    const staged = await stageArtifact(files, mission.artifactId, target);
    const fingerprint = staged.fingerprint;
    const revision = mission.revisions ?? 0;
    const journalPath = this.journalPath(mission.id, revision);
    await mkdir(this.stateRoot, { recursive: true });
    const lockPath = `${journalPath}.lock`;
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      await rm(staged.stageRoot, { recursive: true, force: true });
      if (error.code !== 'EEXIST') throw error;
      throw new Error('preview deployment is already running; reconcile the existing operation before retrying');
    }
    try {
      let previous = null;
      let retrying = false;
      try { previous = await readJournal(journalPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous) {
        requireValue(previous.missionId === mission.id && previous.artifactId === mission.artifactId &&
          previous.artifactFingerprint === fingerprint && previous.projectId === target.projectId &&
          previous.teamId === target.teamId && previous.projectSlug === target.projectSlug &&
          previous.teamSlug === target.teamSlug && previous.target === 'preview' && previous.version === 2 &&
          previous.revision === revision &&
          Number.isSafeInteger(previous.attempts) && previous.attempts >= 1 && previous.attempts <= 2 &&
          ['submitting', 'submitted', 'ready', 'failed', 'uncertain'].includes(previous.status),
        'mission preview deployment identity changed after submission or its journal is invalid');
        if (previous.status === 'ready') {
          const verifiedUrl = vercelPreviewOrigin(previous.url, target);
          const verified = previous.verified;
          requireValue(/^dpl_[A-Za-z0-9]{8,}$/.test(previous.deploymentId) && verified?.readyState === 'READY' &&
            verified.id === previous.deploymentId && verified.projectId === target.projectId &&
            verified.target !== 'production' && ['preview', null, undefined].includes(verified.target) &&
            verified.url === verifiedUrl && verified.artifactFingerprint === fingerprint &&
            typeof previous.readyAt === 'string', 'ready preview journal failed identity validation');
          return previous;
        }
        if (previous.status === 'uncertain') {
          requireValue(previous.deploymentId === null && previous.url === null &&
            isKnownRootDirectoryPreflightFailure(previous.error),
          'preview deployment outcome is uncertain; reconcile the existing operation before retrying');
          requireValue(typeof this.cli.listMissionDeployments === 'function',
            'read-only Vercel deployment reconciliation is unavailable');
          const matchingDeployments = await this.cli.listMissionDeployments({ missionId: mission.id, target, cwd: this.workspaceRoot });
          requireValue(Array.isArray(matchingDeployments) && matchingDeployments.length === 0,
            'matching Vercel deployment exists; inspect it before retrying');
          previous.reconciliation = { method: 'vercel-list-mission-metadata', checkedAt: new Date().toISOString(), matchingDeployments: 0 };
          previous.status = 'failed';
          await writeJournal(journalPath, previous);
        }
        if (previous.status === 'failed' && previous.attempts >= 2) {
          throw new Error('preview deployment retry limit reached; reconcile before starting another operation');
        }
        if (previous.status !== 'failed') {
          throw new Error('preview deployment outcome is uncertain; reconcile the existing operation before retrying');
        }
        retrying = true;
      }

      await this.cli.whoami({ teamId: target.teamId, cwd: this.workspaceRoot });
      requireValue(!await isCancelled(), 'preview deployment cancelled before submission');
      if (retrying) {
        previous.status = 'submitting';
        previous.attempts += 1;
        previous.error = null;
        await writeJournal(journalPath, previous);
      }
      const metadata = metadataFor(mission, fingerprint);
      const journal = previous ?? { version: 2, revision, missionId: mission.id, artifactId: mission.artifactId,
        artifactFingerprint: fingerprint, projectId: target.projectId, teamId: target.teamId,
        projectSlug: target.projectSlug, teamSlug: target.teamSlug,
        target: 'preview', status: 'submitting', createdAt: new Date().toISOString(), deploymentId: null, url: null, attempts: 1 };
      if (!previous) await writeJournal(journalPath, journal, { create: true });
      let submitted = false;
      try {
        if (await isCancelled()) { const error = new Error('preview deployment cancelled before submission'); error.submitted = false; throw error; }
        const result = await this.cli.deploy({ artifactPath: staged.stageRoot, projectId: target.projectId,
          teamId: target.teamId, target: 'preview', prebuilt: true, meta: metadata, artifactFingerprint: fingerprint });
        submitted = true;
        const deploymentId = result?.id ?? result?.deploymentId;
        requireValue(typeof deploymentId === 'string' && /^dpl_[A-Za-z0-9]{8,}$/.test(deploymentId),
          'Vercel response did not include a deployment ID');
        const url = vercelPreviewOrigin(result?.url, target);
        journal.deploymentId = deploymentId;
        journal.url = url;
        journal.status = 'submitted';
        await writeJournal(journalPath, journal);

        const deadline = Date.now() + this.maxWaitMs;
        let details;
        for (;;) {
          if (await isCancelled()) throw new Error('mission cancelled after preview submission; deployment outcome requires reconciliation');
          details = await this.cli.inspect(deploymentId, { teamId: target.teamId });
          const currentUrl = vercelPreviewOrigin(details?.url, target);
          const detailsMeta = details?.meta ?? details?.metadata ?? {};
          const matches = details?.id === deploymentId && details?.projectId === target.projectId &&
            details?.target !== 'production' && ['preview', null, undefined].includes(details?.target) &&
            currentUrl === url && detailsMeta.villageMissionId === mission.id &&
            detailsMeta.villageArtifactId === mission.artifactId && detailsMeta.villageArtifactSha256 === fingerprint;
          requireValue(matches, 'Vercel preview identity verification failed');
          if (details.readyState === 'READY') break;
          if (['ERROR', 'CANCELED', 'CANCELLED', 'BLOCKED'].includes(details.readyState)) {
            throw new Error(`Vercel preview ended in ${details.readyState}`);
          }
          if (Date.now() >= deadline) throw new Error('Vercel preview did not reach READY within the bounded wait');
          await this.sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())));
        }
        journal.status = 'ready';
        journal.readyAt = new Date().toISOString();
        journal.verified = { id: details.id, projectId: details.projectId, target: details.target,
          readyState: details.readyState, url, artifactFingerprint: fingerprint };
        await writeJournal(journalPath, journal);
        return journal;
      } catch (error) {
        journal.status = submitted || error?.submitted !== false ? 'uncertain' : 'failed';
        journal.error = String(error?.message ?? 'preview deployment failed').slice(0, 500);
        await writeJournal(journalPath, journal);
        if (journal.status === 'uncertain') {
          throw new Error('preview deployment outcome is uncertain; reconcile the existing operation before retrying');
        }
        throw error;
      }
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
      await rm(staged.stageRoot, { recursive: true, force: true });
    }
  }
}

export const previewDeploymentLimits = Object.freeze({ maxArtifactFiles: MAX_ARTIFACT_FILES,
  maxArtifactBytes: MAX_ARTIFACT_BYTES, maxWaitMs: MAX_WAIT_MS });
