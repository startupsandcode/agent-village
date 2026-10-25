import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResult } from './contract.mjs';

const execFileAsync = promisify(execFile);
const schema = fileURLToPath(new URL('./role-result.schema.json', import.meta.url));
const MAX_CODEX_STDERR_CHARS = 8192;
const CODEX_STDERR_HEAD_CHARS = MAX_CODEX_STDERR_CHARS / 2;
const CODEX_STDERR_TAIL_CHARS = MAX_CODEX_STDERR_CHARS - CODEX_STDERR_HEAD_CHARS;
const MAX_CODEX_DIAGNOSTIC_CHARS = 240;

export function sanitizeCodexDiagnostic(value) {
  const redacted = String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gi, '[redacted-token]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/g, '[redacted-token]')
    .replace(/\b(authorization|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\b[A-Za-z]:\\[^\s"']+/g, '[local-path]')
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (redacted.length <= MAX_CODEX_DIAGNOSTIC_CHARS) return redacted;
  const marker = ' …[diagnostic truncated]… ';
  const contentLength = MAX_CODEX_DIAGNOSTIC_CHARS - marker.length;
  const headLength = Math.ceil(contentLength / 2);
  const tailLength = contentLength - headLength;
  return `${redacted.slice(0, headLength)}${marker}${redacted.slice(-tailLength)}`;
}

export function roleCommand(codex, cwd, schemaPath, output, readOnly, images = []) {
  const mode = readOnly ? ['--sandbox', 'read-only'] : ['--approve-for-me'];
  return [codex, 'exec', '--ignore-user-config', ...mode, '-C', cwd,
    ...images.flatMap(image => ['--image', image]), '--output-schema', schemaPath, '-o', output, '-'];
}

export async function resolveCodexCommand(args, { platform = process.platform, pathValue = process.env.PATH,
  nodeExecutable = process.execPath, canAccess = access } = {}) {
  if (platform !== 'win32') return args;
  for (const directory of String(pathValue ?? '').split(';').filter(Boolean)) {
    const entry = win32.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
      await canAccess(entry);
      return [nodeExecutable, entry, ...args.slice(1)];
    } catch {}
  }
  throw new Error('official Codex CLI npm installation was not found on PATH');
}

async function defaultLogin() {
  try {
    const [executable, ...args] = await resolveCodexCommand(['codex', 'login', 'status']);
    const { stdout, stderr } = await execFileAsync(executable, args, { timeout: 20000 });
    return `${stdout}${stderr}`.includes('Logged in using ChatGPT');
  } catch { return false; }
}

async function defaultLaunch(args, { cwd, env, prompt, timeoutSeconds }, { spawnProcess = spawn,
  resolveCommand = resolveCodexCommand } = {}) {
  const [executable, ...rest] = await resolveCommand(args);
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(executable, rest, { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderrBuffer = '';
    let stderrHead = '';
    let stderrTail = '';
    let stderrTruncated = false;
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      if (!stderrTruncated && stderrBuffer.length + text.length <= MAX_CODEX_STDERR_CHARS) {
        stderrBuffer += text;
        return;
      }
      if (!stderrTruncated) {
        const prefix = stderrBuffer.slice(0, CODEX_STDERR_HEAD_CHARS);
        stderrHead = prefix + text.slice(0, CODEX_STDERR_HEAD_CHARS - prefix.length);
        stderrTail = (stderrBuffer.slice(-CODEX_STDERR_TAIL_CHARS) + text.slice(-CODEX_STDERR_TAIL_CHARS))
          .slice(-CODEX_STDERR_TAIL_CHARS);
        stderrBuffer = '';
        stderrTruncated = true;
        return;
      }
      stderrTail = (stderrTail + text.slice(-CODEX_STDERR_TAIL_CHARS)).slice(-CODEX_STDERR_TAIL_CHARS);
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex stage timed out')); }, timeoutSeconds * 1000);
    child.on('error', error => {
      clearTimeout(timer);
      const diagnostic = sanitizeCodexDiagnostic(`${error.code ?? ''} ${error.message}`);
      reject(new Error(`Codex stage failed (process launch${error.code ? ` ${error.code}` : ''})${diagnostic ? `: ${diagnostic}` : ''}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const captured = stderrTruncated ? `${stderrHead} [stderr middle omitted] ${stderrTail}` : stderrBuffer;
        const diagnostic = sanitizeCodexDiagnostic(captured);
        reject(new Error(`Codex stage failed (exit ${code})${diagnostic ? `: ${diagnostic}` : ''}`));
      }
      else resolve(null);
    });
    child.stdin.end(prompt);
  });
}

export class CodexRunner {
  constructor({ launch, login = defaultLogin, spawnProcess = spawn, resolveCommand = resolveCodexCommand } = {}) {
    this.launch = launch ?? ((args, options) => defaultLaunch(args, options, { spawnProcess, resolveCommand }));
    this.login = login;
  }

  async runRole({ role, cwd, prompt, timeoutSeconds, env = process.env }) {
    if (!['maya', 'sam', 'quinn'].includes(role)) throw new Error('invalid role');
    const data = await this.runStructured({ cwd, prompt, timeoutSeconds, schemaPath: schema,
      readOnly: role === 'quinn', env });
    return validateResult(data);
  }

  async runStructured({ cwd, prompt, timeoutSeconds, schemaPath, readOnly = true, images = [], env = process.env }) {
    if (typeof cwd !== 'string' || !cwd.trim() || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('role workspace and prompt are required');
    }
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 2700) {
      throw new Error('invalid role timeout');
    }
    if (typeof schemaPath !== 'string' || !schemaPath.trim() || !Array.isArray(images) || images.length > 4 ||
        images.some(image => typeof image !== 'string' || !image.trim() || image.length > 4096)) {
      throw new Error('structured role schema and images are invalid');
    }
    if (!await this.login()) throw new Error('Existing ChatGPT login required');
    const cleanEnv = { ...env };
    delete cleanEnv.OPENAI_API_KEY;
    delete cleanEnv.CODEX_API_KEY;
    const directory = await mkdtemp(join(tmpdir(), 'village-codex-'));
    const output = join(directory, 'result.json');
    try {
      const command = roleCommand('codex', cwd, schemaPath, output, readOnly, images);
      const launched = await this.launch(command, { cwd, env: cleanEnv, prompt, timeoutSeconds });
      const raw = typeof launched === 'string' ? launched : await readFile(output, 'utf-8');
      if (Buffer.byteLength(raw, 'utf8') > 65536) throw new Error('Codex structured result exceeded the output limit');
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('Codex returned invalid JSON'); }
      return data;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
