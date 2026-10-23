import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export async function loadLocalEnv(path = join(repoRoot, '.env.local')) {
  let file;
  try { file = await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!file.isFile() || file.size > 16_384) throw new Error('.env.local must be a regular file under 16 KiB');
  if (process.platform !== 'win32' && (file.mode & 0o077)) throw new Error('.env.local is readable by others; run chmod 600 .env.local');
  if (typeof process.loadEnvFile !== 'function') throw new Error('Node.js 20.12 or newer is required to load .env.local');
  process.loadEnvFile(path);
  return true;
}
