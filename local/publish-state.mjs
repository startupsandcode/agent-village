import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const name = 'preview-publish.json';

export async function readPreviewPublish(engine, id) {
  const dir = await engine.checkedWorkspace(id);
  const path = join(dir, name);
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 4096) throw new Error('Invalid preview receipt');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!['submitting', 'submitted', 'needs_inspection'].includes(value.status) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(value.team ?? '') ||
        !/^[a-z0-9][a-z0-9-]{1,62}$/.test(value.project ?? '') || !/^[a-f0-9]{64}$/.test(value.artifactSha256 ?? '') ||
        (value.status === 'submitted' && (!/^dpl_[A-Za-z0-9_-]{4,80}$/.test(value.deploymentId ?? '') ||
          !/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(value.url ?? ''))) ||
        (value.status === 'needs_inspection' && (!/^dpl_[A-Za-z0-9_-]{4,80}$/.test(value.deploymentId ?? '') ||
          !/^[a-z0-9_-]{1,80}$/.test(value.target ?? '') || !/^[A-Z_]{1,32}$/.test(value.state ?? '') ||
          (value.url != null && !/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(value.url))))) throw new Error('Invalid preview receipt');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function beginPreviewPublish(engine, id, target) {
  const dir = await engine.checkedWorkspace(id);
  const value = { status: 'submitting', ...target, startedAt: new Date().toISOString() };
  try { await writeFile(join(dir, name), JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('A Preview publish already exists; inspect its status before retrying');
    throw error;
  }
}

export async function completePreviewPublish(engine, id, receipt) {
  const dir = await engine.checkedWorkspace(id);
  const existing = await readPreviewPublish(engine, id);
  if (existing?.status !== 'submitting' || existing.team !== receipt.team || existing.project !== receipt.project || existing.artifactSha256 !== receipt.artifactSha256) throw new Error('Preview publish receipt changed');
  const temp = join(dir, `preview-publish-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify({ status: 'submitted', ...receipt }), { flag: 'wx', mode: 0o600 });
  await rename(temp, join(dir, name));
}

export async function recordUnsafePreviewPublish(engine, id, receipt) {
  const dir = await engine.checkedWorkspace(id);
  const existing = await readPreviewPublish(engine, id);
  if (existing?.status !== 'submitting' || existing.team !== receipt.team || existing.project !== receipt.project ||
      existing.projectId !== receipt.projectId || existing.artifactSha256 !== receipt.artifactSha256 ||
      !/^dpl_[A-Za-z0-9_-]{4,80}$/.test(receipt.deploymentId ?? '') ||
      !/^[a-z0-9_-]{1,80}$/.test(receipt.target ?? '') || !/^[A-Z_]{1,32}$/.test(receipt.state ?? '') ||
      (receipt.url != null && !/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(receipt.url))) throw new Error('Unsafe preview receipt changed');
  const value = { status: 'needs_inspection', team: existing.team, project: existing.project, projectId: existing.projectId,
    artifactSha256: existing.artifactSha256, startedAt: existing.startedAt, deploymentId: receipt.deploymentId,
    target: receipt.target, state: receipt.state, ...(receipt.url ? { url: receipt.url } : {}) };
  const temp = join(dir, `preview-publish-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temp, join(dir, name));
  return value;
}
