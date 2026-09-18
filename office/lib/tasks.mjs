import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ARGS = ['issue', 'list', '-R', 'startupsandcode/agent-village', '--state', 'open', '--limit', '100', '--json', 'number,title,url,updatedAt'];

async function runGh(args) {
  const { stdout } = await execFileAsync('gh', args, { cwd: repoDir, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
  return stdout;
}

function parseItems(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error('Invalid GitHub issue list.');
  return parsed.map(item => {
    if (!item || !Number.isSafeInteger(item.number) || item.number <= 0 || typeof item.title !== 'string' || !item.title.trim() || typeof item.url !== 'string' || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) {
      throw new Error('Invalid GitHub issue list.');
    }
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+\/issues\/[1-9]\d*$/.test(url.pathname)) throw new Error('Invalid issue URL.');
    return { number: item.number, title: item.title, url: item.url, updatedAt: item.updatedAt };
  });
}

export function createTaskLoader({ now = Date.now, runGh: command = runGh } = {}) {
  let cached;
  let loadedAt = -Infinity;
  let pending;
  return async function getTasks() {
    const current = now();
    if (cached?.status === 'ok' && current - loadedAt < 30_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const output = await command([...ARGS]);
        cached = { status: 'ok', updatedAt: new Date(now()).toISOString(), items: parseItems(output) };
      } catch {
        cached = { status: 'error', updatedAt: null, items: [] };
      }
      loadedAt = now();
      pending = undefined;
      return cached;
    })();
    return pending;
  };
}
