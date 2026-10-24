import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserPreviewVerifier } from '../browser-verifier.mjs';

const artifactId = 'mission-46-preview-a';
const mission = id => ({ id: 'mission-46', artifactId, revisions: 0,
  destination: id, goal: 'Render a usable local preview' });

async function fixture(t) {
  let wrongArtifact = false;
  const server = createServer((request, response) => {
    if (request.url === '/styles.css') {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end('body{margin:0;font:16px system-ui;color:#223}main{max-width:48rem;margin:3rem auto;padding:1rem}h1{font-size:clamp(2rem,7vw,4rem)}');
      return;
    }
    const pageId = wrongArtifact ? 'another-artifact' : artifactId;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="village-artifact-id" content="${pageId}"><title>Mission preview</title><link rel="stylesheet" href="/styles.css"></head><body><main><h1>Designed locally</h1><p>Responsive browser evidence.</p><img src="https://assets.invalid/pixel.png" alt="Decorative external pixel"></main></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const destination = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), 'village-browser-evidence-'));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { destination, root, verifier: new BrowserPreviewVerifier({ evidenceRoot: root }),
    setWrongArtifact(value) { wrongArtifact = value; } };
}

test('real Chromium verifies exact local artifact and captures desktop and narrow screenshots', async t => {
  const f = await fixture(t);
  const expectedMission = mission(f.destination);
  const { rendered, captures } = await f.verifier.capture({ mission: expectedMission,
    previewUrl: `${f.destination}/` });
  assert.equal(captures.desktop.metrics.width, 1280);
  assert.equal(captures.narrow.metrics.width, 390);
  assert.ok(captures.desktop.metrics.documentWidth <= 1280);
  assert.ok(captures.narrow.metrics.documentWidth <= 390);
  assert.ok(captures.desktop.evidenceRef.startsWith('sha256:'));
  assert.ok(captures.narrow.evidenceRef.startsWith('sha256:'));
  assert.deepEqual(rendered.blockedExternalOrigins, ['https://assets.invalid']);
  assert.equal((await f.verifier.verifyRenderedEvidence({ mission: expectedMission, rendered })).verified, true);
});

test('browser refuses an artifact marker mismatch and unapproved preview origin', async t => {
  const f = await fixture(t);
  const expectedMission = mission(f.destination);
  f.setWrongArtifact(true);
  await assert.rejects(() => f.verifier.capture({ mission: expectedMission,
    previewUrl: `${f.destination}/` }), /artifact identity/);
  await assert.rejects(() => f.verifier.capture({ mission: expectedMission,
    previewUrl: 'https://example.com/' }), /approved destination/);
});

test('evidence verifier detects a changed screenshot and destination mismatch', async t => {
  const f = await fixture(t);
  const expectedMission = mission(f.destination);
  const { rendered } = await f.verifier.capture({ mission: expectedMission,
    previewUrl: `${f.destination}/` });
  assert.equal((await f.verifier.verifyRenderedEvidence({ mission: expectedMission,
    rendered: { ...rendered, destination: 'https://example.com' } })).verified, false);
  assert.equal((await f.verifier.verifyRenderedEvidence({ mission: expectedMission,
    rendered: { ...rendered, screenshotSha256: '0'.repeat(64) } })).verified, false);
  assert.equal((await f.verifier.verifyRenderedEvidence({ mission: expectedMission,
    rendered: { ...rendered, screenshotRef: 'C:/Users/JMann/.codex/config.toml' } })).verified, false);
  await writeFile(join(f.root, expectedMission.id, 'revision-0', 'narrow.png'), Buffer.from('tampered'));
  assert.equal((await f.verifier.verifyRenderedEvidence({ mission: expectedMission, rendered })).verified, false);
});
