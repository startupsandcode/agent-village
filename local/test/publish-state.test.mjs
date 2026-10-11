import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginPreviewPublish, completePreviewPublish, readPreviewPublish } from '../publish-state.mjs';

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
