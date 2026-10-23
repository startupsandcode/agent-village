import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function validOfficeName(value) {
  return typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 60 &&
    !/[\x00-\x1f\x7f<>]/.test(value);
}

export async function readOfficeSetup(root) {
  try {
    const path = join(root, 'office-setup.json');
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('Invalid office setup file');
    const data = JSON.parse(await readFile(path, 'utf8'));
    return validOfficeName(data.name) ? { name: data.name.trim() } : { name: '' };
  } catch (error) {
    if (error.code === 'ENOENT') return { name: '' };
    throw error;
  }
}

export async function saveOfficeSetup(root, name) {
  if (!validOfficeName(name)) throw new Error('Office name must be 2–60 characters without markup or control characters');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'office-setup.json');
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Invalid office setup file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(root, `office-setup-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify({ name: name.trim() }), { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
  return { name: name.trim() };
}
