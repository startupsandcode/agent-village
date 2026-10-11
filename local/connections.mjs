import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const commands = {
  github: ['gh', ['api', 'user', '--jq', '.login']],
  vercel: ['vercel', ['whoami', '--non-interactive']],
};

export async function inspectConnections({ run = runFile, env = process.env } = {}) {
  const childEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}),
    VERCEL_TELEMETRY_DISABLED: '1',
    NO_UPDATE_NOTIFIER: '1',
  };
  const result = {};
  for (const [service, [file, args]] of Object.entries(commands)) {
    try {
      const { stdout } = await run(file, args, { env: childEnv, timeout: 5000, maxBuffer: 2048 });
      const account = String(stdout).trim();
      result[service] = /^[A-Za-z0-9_.-]{1,80}$/.test(account) ? { state: 'connected', account } : { state: 'unavailable' };
    } catch { result[service] = { state: 'unavailable' }; }
  }
  return result;
}
