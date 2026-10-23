import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VillageEngine } from '../engine.mjs';
import { createLocalServer } from '../server.mjs';

const id = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const id2 = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'village-archive-'));
  const provider = { name: 'mock', async generate() { throw new Error('Unexpected provider call'); } };
  const engine = new VillageEngine({ root, provider });
  await mkdir(join(root, id));
  await writeFile(join(root, id, 'state.json'), JSON.stringify({ id, version: 0, goal: 'Garden site', status: 'needs_answer', events: [{ agent: 'Maya', type: 'question', message: 'Who?' }], createdAt: '2026-10-23T00:00:00Z', usageMarker: 'retained' }));
  try { await fn({ root, engine, provider }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('local archive survives restart, hides active work and restores its original workflow', async () => fixture(async ({ root, engine, provider }) => {
  const archived = await engine.archive(id, 0);
  assert.ok(archived.archivedAt); assert.equal(archived.status, 'needs_answer');
  assert.equal((await engine.list()).projects.length, 0);
  assert.equal((await engine.list({ archived: true })).projects.length, 1);
  await assert.rejects(engine.answer(id, 'Neighbors', 'answer-12345'), /archived/);
  const restarted = new VillageEngine({ root, provider });
  const saved = await restarted.get(id);
  assert.equal(saved.archivedAt, archived.archivedAt);
  await assert.rejects(restarted.restore(id, 0), /Project changed/);
  const restored = await restarted.restore(id, saved.version);
  assert.equal(restored.archivedAt, null); assert.equal(restored.events.length, 1);
  assert.equal((await restarted.list()).projects.length, 1);
  assert.equal(JSON.parse(await readFile(join(root, id, 'state.json'))).usageMarker, 'retained');
}));

test('local archiving rejects active provider work and uncertain Preview receipts', async () => fixture(async ({ root, engine }) => {
  const internal = await engine.getInternal(id);
  internal.status = 'reviewing';
  await assert.rejects(engine.archive(id, 0), /Project is busy/);
  internal.status = 'reviewed';
  await writeFile(join(root, id, 'preview-publish.json'), JSON.stringify({ status: 'submitting', team: 'my-team', project: 'my-site', artifactSha256: 'a'.repeat(64) }));
  await assert.rejects(engine.archive(id, 0), /Project is busy/);
  assert.equal((await engine.get(id)).archivedAt, null);
}));

test('local publication lock prevents archive racing external writes and archived publishing', async () => fixture(async ({ engine }) => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const publishing = engine.withPublishing(id, async () => { started(); await waiting; });
  await entered;
  await assert.rejects(engine.archive(id, 0), /Project is busy/);
  release(); await publishing;
  await engine.archive(id, 0);
  await assert.rejects(engine.withPublishing(id, async () => assert.fail('must not publish')), /archived/);
}));

test('local archive HTTP requires valid current version and lists the selected archive view', async () => fixture(async ({ engine, provider }) => {
  const server = createLocalServer({ engine, provider });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const action = data => fetch(`${origin}/api/projects/${id}/archive`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(data) });
    assert.equal((await action({})).status, 400);
    assert.equal((await action({ expectedVersion: 0 })).status, 200);
    assert.equal((await (await fetch(`${origin}/api/projects`)).json()).projects.length, 0);
    const archived = await (await fetch(`${origin}/api/projects?archived=true`)).json();
    assert.equal(archived.projects.length, 1); assert.ok(archived.projects[0].archivedAt);
    assert.equal((await fetch(`${origin}/api/projects?archived=maybe`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('concurrent integrity read cannot overwrite a queued archive snapshot', async () => fixture(async ({ root, engine, provider }) => {
  const original = await engine.getInternal(id);
  original.status = 'reviewed'; original.artifact = { sha256: 'a'.repeat(64) };
  // Queue the archive's real save before allowing the integrity GET to finish.
  // The missing artifact files would normally invalidate and save the old object.
  let release; const hold = new Promise(resolve => { release = resolve; });
  let entered; const saving = new Promise(resolve => { entered = resolve; });
  engine.saves.set(id, hold);
  const save = engine.save.bind(engine);
  engine.save = async project => { const pending = save(project); if (project.archivedAt) entered(); return pending; };
  const archiving = engine.archive(id, 0);
  await saving;
  await assert.rejects(engine.get(id), /Project is busy/);
  assert.equal(original.status, 'reviewed');
  assert.ok(original.artifact);
  release(); const archived = await archiving;
  await Promise.all([...engine.saves.values()]);
  const persisted = JSON.parse(await readFile(join(root, id, 'state.json')));
  assert.equal(persisted.archivedAt, archived.archivedAt);
  assert.equal(persisted.status, 'reviewed');
  const restarted = new VillageEngine({ root, provider });
  const reloaded = await restarted.get(id);
  // Integrity invalidation remains active after the lifecycle operation completes.
  assert.equal(reloaded.status, 'blocked');
  assert.equal(reloaded.artifact, null);
  assert.equal(reloaded.archivedAt, archived.archivedAt);
}));

test('integrity read started before archive is fenced after delayed filesystem access', async () => fixture(async ({ root, engine }) => {
  const original = await engine.getInternal(id);
  original.status = 'reviewed'; original.artifact = { sha256: 'a'.repeat(64) };
  const checkedWorkspace = engine.checkedWorkspace.bind(engine);
  let releaseRead; const readGate = new Promise(resolve => { releaseRead = resolve; });
  let enteredRead; const reading = new Promise(resolve => { enteredRead = resolve; });
  let first = true;
  engine.checkedWorkspace = async projectId => {
    if (first) { first = false; enteredRead(); await readGate; }
    return checkedWorkspace(projectId);
  };
  const oldRead = engine.get(id);
  await reading;
  let releaseSave; const saveGate = new Promise(resolve => { releaseSave = resolve; });
  engine.saves.set(id, saveGate);
  let enteredSave; const saving = new Promise(resolve => { enteredSave = resolve; });
  const save = engine.save.bind(engine);
  engine.save = async project => { const pending = save(project); if (project.archivedAt) enteredSave(); return pending; };
  const archiving = engine.archive(id, 0); await saving;
  releaseRead(); await assert.rejects(oldRead, /Project is busy/);
  releaseSave(); const archived = await archiving;
  assert.equal(JSON.parse(await readFile(join(root, id, 'state.json'))).archivedAt, archived.archivedAt);
}));
