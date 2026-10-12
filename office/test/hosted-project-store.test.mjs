import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedProjectStore } from '../lib/hosted-project-store.mjs';
import { createHostedProjectAccess } from '../lib/hosted-project-access.mjs';

const id = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const otherId = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';

function fakeDatabase() {
  const rows = new Map();
  const calls = [];
  const query = async (sql, values) => {
    calls.push({ sql, values });
    const [sub, key] = values;
    if (sql.startsWith('INSERT')) {
      if ([...rows.values()].some(row => row.owner_sub === sub && row.create_request_id === values[2]) || rows.has(`${sub}:${key}`)) return { rows: [] };
      const row = { owner_sub: sub, id: key, create_request_id: values[2], version: 0, snapshot: JSON.parse(values[3]) };
      rows.set(`${sub}:${key}`, row);
      return { rows: [row] };
    }
    if (sql.includes('create_request_id = $2')) return { rows: [[...rows.values()].find(row => row.owner_sub === sub && row.create_request_id === key)].filter(Boolean) };
    if (sql.startsWith('UPDATE')) {
      const row = rows.get(`${sub}:${key}`);
      if (!row || row.version !== values[2]) return { rows: [] };
      row.version++; row.snapshot = JSON.parse(values[3]);
      return { rows: [row] };
    }
    return { rows: [rows.get(`${sub}:${key}`)].filter(Boolean) };
  };
  return { query, calls };
}

test('hosted store scopes reads and idempotency to verified subject', async () => {
  const db = fakeDatabase();
  const store = createHostedProjectStore(db);
  const project = { status: 'clarifying', events: [] };
  assert.deepEqual(await store.create({ ownerSub: 'vercel-user-a', id, requestId: 'request-123', snapshot: project }), { id, version: 0, snapshot: project });
  assert.equal(await store.read({ ownerSub: 'vercel-user-b', id }), null);
  assert.equal(await store.read({ ownerSub: 'vercel-user-a', id: otherId }), null);
  assert.equal((await store.create({ ownerSub: 'vercel-user-a', id: otherId, requestId: 'request-123', snapshot: { status: 'different' } })).id, id);
  assert.equal((await store.create({ ownerSub: 'vercel-user-b', id, requestId: 'request-123', snapshot: project })).id, id);
  assert.ok(db.calls.every(call => call.sql.includes('owner_sub') && !call.sql.includes('vercel-user-a')));
});

test('hosted store uses compare-and-swap so a stale job cannot overwrite cancellation', async () => {
  const store = createHostedProjectStore(fakeDatabase());
  await store.create({ ownerSub: 'owner', id, requestId: 'request-123', snapshot: { status: 'building' } });
  const cancelled = await store.update({ ownerSub: 'owner', id, expectedVersion: 0, snapshot: { status: 'cancelled' } });
  assert.equal(cancelled.version, 1);
  assert.equal(await store.update({ ownerSub: 'owner', id, expectedVersion: 0, snapshot: { status: 'reviewed' } }), null);
  assert.equal((await store.read({ ownerSub: 'owner', id })).snapshot.status, 'cancelled');
  assert.equal(await store.update({ ownerSub: 'another-owner', id, expectedVersion: 1, snapshot: { status: 'reviewed' } }), null);
});

test('hosted store rejects invalid identity, request and oversized state before querying', async () => {
  const db = fakeDatabase();
  const store = createHostedProjectStore(db);
  await assert.rejects(store.read({ ownerSub: '', id }), /Verified owner/);
  await assert.rejects(store.create({ ownerSub: 'owner', id: '../outside', requestId: 'request-123', snapshot: {} }), /project ID/);
  await assert.rejects(store.create({ ownerSub: 'owner', id, requestId: 'x', snapshot: {} }), /request ID/);
  await assert.rejects(store.create({ ownerSub: 'owner', id, requestId: ['request-123'], snapshot: {} }), /request ID/);
  await assert.rejects(store.create({ ownerSub: 'owner', id, requestId: [['request-123']], snapshot: {} }), /request ID/);
  await assert.rejects(store.create({ ownerSub: 'owner', id, requestId: 12345678, snapshot: {} }), /request ID/);
  await assert.rejects(store.create({ ownerSub: 'owner', id, requestId: 'request-123', snapshot: { data: 'x'.repeat(262_145) } }), /too large/);
  await assert.rejects(store.create({ ownerSub: 'owner', id, requestId: 'request-123', snapshot: { data: Array.from({ length: 50_000 }, () => '') } }), /too large/);
  assert.equal(db.calls.length, 0);
});

test('hosted access derives ownership from the authorized session, not request data', async () => {
  const store = createHostedProjectStore(fakeDatabase());
  const access = createHostedProjectAccess({ store, auth: { authorize: cookie => cookie === 'valid' ? { status: 200, sub: 'verified-sub' } : { status: 401 } } });
  assert.throws(() => access.create('invalid', { id, requestId: 'request-123', snapshot: {}, ownerSub: 'attacker' }), /access denied/);
  await access.create('valid', { id, requestId: 'request-123', snapshot: { status: 'clarifying' }, ownerSub: 'attacker' });
  assert.equal((await store.read({ ownerSub: 'verified-sub', id })).snapshot.status, 'clarifying');
  assert.equal(await store.read({ ownerSub: 'attacker', id }), null);
});

test('project dashboard lists bounded owner-scoped summaries with active work first', async () => {
  const calls = [];
  const rows = Array.from({ length: 26 }, (_, index) => ({ id: `project-${index}`, version: index,
    goal: `Goal ${index}`, status: index === 0 ? 'building' : 'reviewed',
    created_at: '2026-10-11T10:00:00Z', updated_at: '2026-10-11T11:00:00Z',
    plan_summary: 'A small site', latest_agent: 'Sam', latest_message: 'Creating the site', latest_at: '2026-10-11T11:00:00Z' }));
  const store = createHostedProjectStore({ query: async (sql, values) => { calls.push({ sql, values }); return { rows }; } });
  const access = createHostedProjectAccess({ store, auth: { authorize: () => ({ status: 200, sub: 'verified-owner' }) } });
  const page = await access.list('session', { offset: 0 });
  assert.equal(page.projects.length, 25);
  assert.equal(page.projects[0].status, 'building');
  assert.equal(page.projects[0].latestMessage, 'Creating the site');
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 25);
  assert.ok(!JSON.stringify(page).includes('files'));
  assert.deepEqual(calls[0].values, ['verified-owner', 26, 0]);
  assert.match(calls[0].sql, /WHERE owner_sub = \$1/);
  assert.match(calls[0].sql, /ORDER BY CASE/);
  assert.match(calls[0].sql, /'building'.*'needs_answer'/s);
  assert.match(calls[0].sql, /LIMIT \$2 OFFSET \$3/);
});
