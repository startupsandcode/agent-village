import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginPreviewPublish, completePreviewPublish, readPreviewPublish, recordUnsafePreviewPublish } from '../publish-state.mjs';

test('Preview write-ahead receipt blocks duplicate or ambiguous submissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'village-preview-'));
  const engine = { checkedWorkspace: async () => root };
  const target = { team: 'team', project: 'site', projectId: 'prj_123456', artifactSha256: 'a'.repeat(64) };
  try {
    assert.equal(await readPreviewPublish(engine, 'id'), null);
    await beginPreviewPublish(engine, 'id', target);
    assert.equal((await readPreviewPublish(engine, 'id')).status, 'submitting');
    await assert.rejects(beginPreviewPublish(engine, 'id', target), /already exists/);
    await completePreviewPublish(engine, 'id', { ...target, deploymentId: 'dpl_123456', url: 'https://site.vercel.app', state: 'QUEUED' });
    assert.equal((await readPreviewPublish(engine, 'id')).status, 'submitted');
    await assert.rejects(beginPreviewPublish(engine, 'id', target), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsafe Preview receipt persists only bounded fields and keeps retries blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'village-preview-'));
  const engine = { checkedWorkspace: async () => root };
  const target = { team: 'team', project: 'site', projectId: 'prj_123456', artifactSha256: 'a'.repeat(64) };
  try {
    await beginPreviewPublish(engine, 'id', target);
    const saved = await recordUnsafePreviewPublish(engine, 'id', { ...target, deploymentId: 'dpl_unsafe123',
      target: 'production', state: 'READY', url: 'https://site-unsafe.vercel.app', secret: 'not-stored' });
    assert.equal(saved.status, 'needs_inspection');
    assert.equal((await readPreviewPublish(engine, 'id')).deploymentId, 'dpl_unsafe123');
    assert.ok(!(await readFile(join(root, 'preview-publish.json'), 'utf8')).includes('not-stored'));
    await assert.rejects(beginPreviewPublish(engine, 'id', target), /already exists/);
    await assert.rejects(completePreviewPublish(engine, 'id', { ...target, deploymentId: 'dpl_other123',
      url: 'https://site-other.vercel.app' }), /receipt changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
