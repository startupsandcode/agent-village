import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResult } from './contract.mjs';

const execFileAsync = promisify(execFile);
const schema = fileURLToPath(new URL('./role-result.schema.json', import.meta.url));

export function roleCommand(codex, cwd, schemaPath, output, readOnly) {
  const mode = readOnly ? ['--sandbox', 'read-only'] : ['--approve-for-me'];
  return [codex, 'exec', '--ignore-user-config', ...mode, '-C', cwd,
    '--output-schema', schemaPath, '-o', output, '-'];
}

async function defaultLogin() {
  try {
    const { stdout, stderr } = await execFileAsync('codex', ['login', 'status'], { timeout: 20000 });
    return `${stdout}${stderr}`.includes('Logged in using ChatGPT');
  } catch { return false; }
}

async function defaultLaunch(args, { cwd, env, prompt, timeoutSeconds }) {
  const [executable, ...rest] = args;
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, rest, { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { if (errors.length < 1024 * 1024) errors += String(chunk); });
    child.on('error', () => reject(new Error('Codex stage failed')));
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex stage timed out')); }, timeoutSeconds * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Codex stage failed'));
      else resolve(null);
    });
    child.stdin.end(prompt);
  });
}

export class CodexRunner {
  constructor({ launch = defaultLaunch, login = defaultLogin } = {}) {
    this.launch = launch;
    this.login = login;
  }

  async runRole({ role, cwd, prompt, timeoutSeconds, env = process.env }) {
    if (!['maya', 'sam', 'quinn'].includes(role)) throw new Error('invalid role');
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 2700) {
      throw new Error('invalid role timeout');
    }
    if (!await this.login()) throw new Error('Existing ChatGPT login required');
    const cleanEnv = { ...env };
    delete cleanEnv.OPENAI_API_KEY;
    delete cleanEnv.CODEX_API_KEY;
    const directory = await mkdtemp(join(tmpdir(), 'village-codex-'));
    const output = join(directory, 'result.json');
    try {
      const command = roleCommand('codex', cwd, schema, output, role === 'quinn');
      const launched = await this.launch(command, { cwd, env: cleanEnv, prompt, timeoutSeconds });
      const raw = typeof launched === 'string' ? launched : await readFile(output, 'utf-8');
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('Codex returned invalid JSON'); }
      return validateResult(data);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
