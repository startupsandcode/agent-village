import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const fields = ['audience', 'expertise', 'rules'];
const empty = { audience: '', expertise: '', rules: '' };

export function validDomainProfile(value) {
  return value && typeof value === 'object' && fields.every(field =>
    typeof value[field] === 'string' && value[field].length <= 500 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value[field]));
}

export async function readDomainProfile(root) {
  const path = join(root, 'domain-profile.json');
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 8192) throw new Error('Invalid domain profile file');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!validDomainProfile(value)) throw new Error('Invalid domain profile file');
    return Object.fromEntries(fields.map(field => [field, value[field].trim()]));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...empty };
    throw error;
  }
}

export async function saveDomainProfile(root, value) {
  if (!validDomainProfile(value)) throw new Error('Domain answers must be text under 500 characters each');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'domain-profile.json');
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('Invalid domain profile file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const profile = Object.fromEntries(fields.map(field => [field, value[field].trim()]));
  const temp = join(root, `domain-profile-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
  return profile;
}
