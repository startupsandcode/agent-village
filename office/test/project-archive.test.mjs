import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedCoordinator } from '../lib/hosted-coordinator.mjs';
import { createHostedProjectStore } from '../lib/hosted-project-store.mjs';
import { createHostedProjectAccess } from '../lib/hosted-project-access.mjs';
import { createHostedPublisher } from '../lib/hosted-publish.mjs';
import { createHostedMayaHandler } from '../api/maya-projects.mjs';
import { artifactDigest } from '../lib/static-site.mjs';

const id = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const auth = { authorize: cookie => ({ status: 200, sub: cookie, email: 'owner@example.com' }) };
function fixture(snapshot = {}) {
  const rows = new Map(); const queries = []; let race = false; let providers = 0; let reserves = 0;
  const base = { id, goal: 'Garden site', status: 'needs_answer', events: [], ...snapshot };
  rows.set(`owner:${id}`, { id, owner_sub: 'owner', version: 0, snapshot: structuredClone(base) });
  const query = async (sql, values) => {
    queries.push({ sql, values });
    const [owner, key] = values;
    if (sql.startsWith('UPDATE')) {
      const row = rows.get(`${owner}:${key}`);
      if (race) { race = false; row.version++; row.snapshot.status = 'building'; }
      if (!row || row.version !== values[2]) return { rows: [] };
      row.version++; row.snapshot = JSON.parse(values[3]); return { rows: [structuredClone(row)] };
    }
    if (sql.includes("snapshot->>'goal' AS goal")) {
      const result = [...rows.values()].filter(row => row.owner_sub === owner && (row.snapshot.archivedAt != null) === values[3]);
      return { rows: result.slice(values[2], values[2] + values[1]).map(row => ({ ...row, goal: row.snapshot.goal, status: row.snapshot.status, archived_at: row.snapshot.archivedAt })) };
    }
    return { rows: [rows.get(`${owner}:${key}`)].filter(Boolean).map(row => structuredClone(row)) };
  };
  const store = createHostedProjectStore({ query });
  const access = createHostedProjectAccess({ store, auth });
  const coordinator = createHostedCoordinator({ access, budget: { reserve: async () => { reserves++; return true; } },
    provider: { name: 'mock', model: 'fixture', generate: async () => { providers++; throw new Error('unexpected provider'); } } });
  return { rows, queries, access, coordinator, store, race: () => { race = true; }, counters: () => ({ providers, reserves }) };
}

test('archive/restore persists through store reads, preserves stage history, usage and budgets', async () => {
  const f = fixture({ events: [{ agent: 'Maya', type: 'question', message: 'Who?' }], plan: { summary: 'Keep this' } });
  const archived = await f.coordinator.archive('owner', id, 0);
  assert.ok(archived.archivedAt); assert.equal(archived.status, 'needs_answer'); assert.equal(archived.version, 1);
  assert.equal((await f.store.read({ ownerSub: 'owner', id })).snapshot.archivedAt, archived.archivedAt);
  assert.equal((await f.coordinator.list('owner')).projects.length, 0);
  assert.equal((await f.coordinator.list('owner', 0, true)).projects.length, 1);
  const restored = await f.coordinator.restore('owner', id, archived.version);
  assert.equal(restored.archivedAt, undefined); assert.equal(restored.status, 'needs_answer');
  assert.equal(restored.events.length, 1); assert.equal(restored.plan.summary, 'Keep this');
  assert.equal((await f.coordinator.list('owner')).projects.length, 1);
  assert.deepEqual(f.counters(), { providers: 0, reserves: 0 });
  assert.ok(f.queries.every(q => !/DELETE|village_monthly_budget|village_budget_claims|village_provider_usage/.test(q.sql)));
});

test('archived filtering happens in owner-scoped query before pagination, including legacy projects', async () => {
  const f = fixture();
  for (let n = 1; n < 60; n++) f.rows.set(`owner:${n}`, { id: String(n), owner_sub: 'owner', version: 0, snapshot: { goal: String(n), status: 'blocked', ...(n % 2 ? { archivedAt: '2026-10-23T00:00:00Z' } : {}) } });
  f.rows.set('other:1', { id: 'hidden', owner_sub: 'other', version: 0, snapshot: { archivedAt: '2026-10-23T00:00:00Z' } });
  const first = await f.coordinator.list('owner', 0, true);
  const second = await f.coordinator.list('owner', first.nextOffset, true);
  assert.equal(first.projects.length, 25); assert.equal(first.nextOffset, 25); assert.equal(first.hasMore, true);
  assert.equal(second.projects.length, 5); assert.equal(second.hasMore, false);
  assert.ok([...first.projects, ...second.projects].every(p => p.archivedAt && p.id !== 'hidden'));
  assert.match(f.queries.at(-1).sql, /owner_sub = \$1[\s\S]*archivedAt[\s\S]*LIMIT \$2 OFFSET \$3/);
  await assert.rejects(f.store.list({ ownerSub: 'owner', archived: 'false' }), /Invalid project view/);
});

test('archive rejects cross-owner, stale version, and a concurrent provider-stage claim', async () => {
  const f = fixture({ status: 'ready' });
  await assert.rejects(f.coordinator.archive('other', id, 0), /Project not found/);
  await assert.rejects(f.coordinator.archive('owner', id, 1), /Project changed/);
  f.race();
  await assert.rejects(f.coordinator.archive('owner', id, 0), /Project changed/);
  assert.equal((await f.store.read({ ownerSub: 'owner', id })).snapshot.status, 'building');
  assert.equal((await f.store.read({ ownerSub: 'owner', id })).snapshot.archivedAt, undefined);
});

test('running stages and uncertain publishing cannot be archived', async () => {
  for (const status of ['clarifying', 'planning', 'building', 'revising', 'reviewing']) {
    const f = fixture({ status }); await assert.rejects(f.coordinator.archive('owner', id, 0), /Project is busy/);
  }
  for (const status of ['submitting', 'needs_inspection']) {
    const f = fixture({ status: 'reviewed', publishing: { vercel: { status } } });
    await assert.rejects(f.coordinator.archive('owner', id, 0), /Project is busy/);
  }
});

test('archived projects cannot advance, reserve provider quota or publish', async () => {
  const f = fixture({ status: 'ready' });
  await f.coordinator.archive('owner', id, 0);
  await assert.rejects(f.coordinator.build('owner', id, 'build-123456'), /archived/);
  await assert.rejects(f.coordinator.answer('owner', id, 'Neighbors', 'answer-123456'), /archived/);
  await assert.rejects(f.coordinator.clarify('owner', id), /archived/);
  await assert.rejects(f.coordinator.retryQuestion('owner', id, 'retry-123456'), /archived/);
  assert.deepEqual(f.counters(), { providers: 0, reserves: 0 });
  const publisher = createHostedPublisher({ access: f.access, env: { VILLAGE_PUBLISH_GITHUB_OWNER: 'owner', VILLAGE_PUBLISH_GITHUB_REPO: 'private-site', VILLAGE_PUBLISH_GITHUB_BRANCH: 'preview', VILLAGE_PUBLISH_GITHUB_TOKEN: 'fake', VILLAGE_PUBLISH_GITHUB_DEDICATED_REPO_CONFIRMED: 'true' } });
  const status = await publisher.status('owner', id);
  assert.equal(status.reviewed, false);
  await assert.rejects(publisher.publish('owner', id, 'github', 'a'.repeat(64), status.targets.github.fingerprint), /archived/);
});

test('restoring keeps Quinn retry, rejected-artifact revision and Maya retry eligibility', async () => {
  const files = { html: '<h1>Garden</h1>', css: 'h1 {color:green}' };
  const artifact = { sha256: artifactDigest(files.html, files.css) };
  for (const item of [
    { status: 'blocked', events: [{ agent: 'Quinn', type: 'error', message: 'Provider failed' }], flag: 'retryReviewAvailable', files, artifact },
    { status: 'changes_requested', events: [{ agent: 'Quinn', type: 'blocked', message: 'Fix it' }], flag: 'revisionAvailable', files, artifact },
    { status: 'question_error', events: [{ agent: 'Maya', type: 'error', message: 'Provider failed' }], flag: 'retryQuestionAvailable' },
  ]) {
    const f = fixture(item);
    assert.ok((await f.coordinator.read('owner', id))[item.flag]);
    const archived = await f.coordinator.archive('owner', id, 0);
    assert.equal(archived[item.flag], false);
    assert.equal((await f.coordinator.restore('owner', id, archived.version))[item.flag], true);
  }
});

test('hosted archive route validates shape, origin, expected version and archived query', async () => {
  const f = fixture();
  const handler = createHostedMayaHandler({ env: { OFFICE_ALLOWED_ORIGINS: 'https://office.example', OFFICE_RUN_ALLOWED_EMAILS: 'owner@example.com' }, auth, coordinator: f.coordinator, enabled: true });
  const call = async (body, url = '/api/maya-projects', method = 'POST', origin = 'https://office.example') => {
    const res = { setHeader() {}, end(text) { this.value = JSON.parse(text); } };
    await handler({ method, url, body, headers: { cookie: 'owner', host: 'office.example', origin, 'content-type': 'application/json' } }, res);
    return res;
  };
  assert.equal((await call({ action: 'archive', id })).statusCode, 400);
  assert.equal((await call({ action: 'archive', id, expectedVersion: '0' })).statusCode, 400);
  assert.equal((await call({ action: 'archive', id, expectedVersion: 0 }, undefined, 'POST', 'https://evil.example')).statusCode, 403);
  assert.equal((await call({ action: 'archive', id, expectedVersion: 0 })).statusCode, 200);
  assert.equal((await call({ action: 'restore', id, expectedVersion: 0 })).statusCode, 409);
  assert.equal((await call(null, '/api/maya-projects?archived=maybe', 'GET')).statusCode, 400);
  assert.equal((await call(null, '/api/maya-projects?archived=true', 'GET')).value.projects.length, 1);
});
