import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedProjectAccess } from '../lib/hosted-project-access.mjs';
import { createHostedCoordinator } from '../lib/hosted-coordinator.mjs';
import { createHostedMayaHandler } from '../api/maya-projects.mjs';
import { createNeonHostedRuntime } from '../lib/neon-runtime.mjs';

const env = { OFFICE_ALLOWED_ORIGINS: 'https://office.example', OFFICE_RUN_ALLOWED_EMAILS: 'owner@example.com' };
const auth = { authorize: cookie => cookie === 'owner' ? { status: 200, sub: 'owner-sub', email: 'owner@example.com' }
  : cookie === 'other' ? { status: 200, sub: 'other-sub', email: 'owner@example.com' }
    : cookie === 'viewer' ? { status: 200, sub: 'viewer-sub', email: 'viewer@example.com' } : { status: 401 } };

function memory() {
  const rows = new Map(); const requests = new Map(); const claims = new Set();
  const store = {
    async create({ ownerSub, id, requestId, snapshot }) {
      const existing = requests.get(`${ownerSub}:${requestId}`);
      if (existing) return rows.get(`${ownerSub}:${existing}`);
      const row = { id, version: 0, snapshot: structuredClone(snapshot) };
      rows.set(`${ownerSub}:${id}`, row); requests.set(`${ownerSub}:${requestId}`, id);
      return structuredClone(row);
    },
    async read({ ownerSub, id }) { return structuredClone(rows.get(`${ownerSub}:${id}`) ?? null); },
    async update({ ownerSub, id, expectedVersion, snapshot }) {
      const row = rows.get(`${ownerSub}:${id}`);
      if (!row || row.version !== expectedVersion) return null;
      const changed = { id, version: row.version + 1, snapshot: structuredClone(snapshot) };
      rows.set(`${ownerSub}:${id}`, changed); return structuredClone(changed);
    },
  };
  const budget = { calls: 0, async reserve(cookie, claim) {
    const ownerSub = auth.authorize(cookie).sub;
    const key = `${ownerSub}:${claim.month}:${claim.kind}:${claim.id}`;
    if (claims.has(key)) return true;
    const mine = [...claims].filter(value => value.startsWith(`${ownerSub}:${claim.month}:`));
    if (claim.kind === 'project' && mine.filter(value => value.includes(':project:')).length >= claim.maxProjects) return false;
    if (claim.kind !== 'project' && mine.filter(value => !value.includes(':project:')).length >= claim.maxCalls) return false;
    claims.add(key); this.calls++; return true;
  } };
  return { store, budget, rows };
}
function response() { return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } }; }
async function call(handler, cookie, body, { method = 'POST', origin = 'https://office.example', url = '/api/maya-projects', fetchSite = 'same-origin' } = {}) {
  const result = response();
  await handler({ method, url, body, headers: { host: 'office.example', cookie, origin, 'sec-fetch-site': fetchSite, 'content-type': 'application/json' } }, result);
  return { status: result.statusCode, value: result.headers['Content-Type']?.startsWith('application/json') ? JSON.parse(result.body) : result.body, headers: result.headers };
}
const site = { title: 'Garden Club', theme: 'forest', sections: [
  { type: 'hero', heading: 'Grow together', body: 'A garden club for neighbors.', actionText: 'Explore' },
  { type: 'text', heading: 'Join us', body: 'Meet your neighbors and learn to grow vegetables.' },
] };

test('hosted route completes a scoped mock goal, plan, build, review and artifact flow', async () => {
  const { store, budget } = memory();
  const replies = [{ question: 'Who is it for?' }, { summary: 'Garden site', audience: 'Neighbors', acceptance: ['Explain club', 'Invite neighbors'], decision: 'Build static site' }, site,
    { approved: true, summary: 'Matches the plan', findings: [] }];
  const provider = { calls: 0, async generate() { return { result: replies[this.calls++], usage: { input: 10, output: 20 } }; } };
  const coordinator = createHostedCoordinator({ access: createHostedProjectAccess({ auth, store }), budget, provider });
  const handler = createHostedMayaHandler({ env, auth, coordinator, enabled: true });
  const created = await call(handler, 'owner', { action: 'create', goal: 'Neighborhood garden website', requestId: 'create-12345' });
  assert.equal(created.status, 200); assert.equal(created.value.status, 'needs_answer');
  assert.equal((await call(handler, 'owner', { action: 'create', goal: 'Neighborhood garden website', requestId: 'create-12345' })).value.id, created.value.id);
  assert.equal(provider.calls, 1);
  const id = created.value.id;
  assert.equal((await call(handler, 'other', null, { method: 'GET', url: `/api/maya-projects?id=${id}` })).status, 404);
  assert.equal((await call(handler, 'other', { action: 'cancel', id })).status, 404);
  const planned = await call(handler, 'owner', { action: 'answer', id, answer: 'Local neighbors', requestId: 'answer-12345' });
  assert.equal(planned.value.status, 'ready');
  const built = await call(handler, 'owner', { action: 'build', id, requestId: 'build-12345' });
  assert.equal(built.value.status, 'awaiting_review');
  const reviewed = await call(handler, 'owner', { action: 'review', id, requestId: 'review-12345' });
  assert.equal(reviewed.value.status, 'reviewed'); assert.equal(provider.calls, 4);
  assert.equal(reviewed.value.events.at(-1).reviewedSha256, reviewed.value.artifact.sha256);
  assert.ok(!JSON.stringify(reviewed.value).includes('"files"'));
  const artifact = await call(handler, 'owner', null, { method: 'GET', url: `/api/maya-projects?id=${id}&file=index.html` });
  assert.equal(artifact.status, 200); assert.match(artifact.value, /Grow together/);
  assert.equal((await call(handler, 'other', null, { method: 'GET', url: `/api/maya-projects?id=${id}&file=index.html` })).status, 404);
});

test('hosted route rejects viewer spend, cross-site requests and forged project state', async () => {
  const { store, budget } = memory(); let calls = 0;
  const provider = { async generate() { calls++; throw new Error('Should not run'); } };
  const handler = createHostedMayaHandler({ env, auth, coordinator: createHostedCoordinator({ access: createHostedProjectAccess({ auth, store }), budget, provider }), enabled: true });
  const body = { action: 'create', goal: 'A website', requestId: 'create-12345' };
  assert.equal((await call(handler, 'viewer', body)).status, 403);
  assert.equal((await call(handler, 'owner', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(handler, 'owner', body, { fetchSite: 'cross-site' })).status, 403);
  assert.equal((await call(handler, 'owner', { ...body, status: 'reviewed', snapshot: { files: 'forged' } })).status, 400);
  assert.equal((await call(handler, 'owner', { action: '__proto__' })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await call(createHostedMayaHandler({ env, auth }), 'owner', body)).status, 503);
});

test('hosted runtime opens only after operator and origin checks, then closes its pool', async () => {
  let opened = 0; let closed = 0;
  class Pool {
    constructor() { opened++; }
    query() { return { rows: [] }; }
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; }
    async end() { closed++; }
  }
  const settings = { ...env, VILLAGE_DATABASE_URL: 'postgres://placeholder', OPENAI_API_KEY: 'fake' };
  const runtimeFactory = options => createNeonHostedRuntime({ ...options, PoolClass: Pool });
  const handler = createHostedMayaHandler({ env: settings, auth, runtimeFactory, enabled: true });
  assert.equal((await call(handler, 'viewer', null, { method: 'GET', url: '/api/maya-projects?id=bad' })).status, 403);
  assert.equal((await call(handler, 'owner', null, { method: 'GET', url: '/api/maya-projects?id=bad', fetchSite: 'cross-site' })).status, 403);
  assert.equal((await call(handler, 'owner', { action: 'create', goal: 'Site', requestId: 'request-123', snapshot: { status: 'reviewed' } })).status, 400);
  assert.equal(opened, 0);
  assert.equal((await call(handler, 'owner', null, { method: 'GET', url: '/api/maya-projects?id=6ba7b810-9dad-41d1-80b4-00c04fd430c8' })).status, 404);
  assert.equal(opened, 1); assert.equal(closed, 1);
  await assert.rejects(createNeonHostedRuntime({ env: { ...settings, VILLAGE_OPENAI_MODEL: 'expensive-custom-model' }, auth, PoolClass: Pool }), /outside the pilot budget/);
  assert.equal(opened, 1);
});

test('hosted cancellation wins over an in-flight mock build', async () => {
  const { store, budget } = memory();
  let release; const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const provider = { async generate() { calls++; if (calls === 1) return { result: { question: 'For whom?' }, usage: {} };
    if (calls === 2) return { result: { summary: 'Site', audience: 'Neighbors', acceptance: ['Inform', 'Invite'], decision: 'Build site' }, usage: {} };
    await gate; return { result: site, usage: {} }; } };
  const coordinator = createHostedCoordinator({ access: createHostedProjectAccess({ auth, store }), budget, provider });
  const created = await coordinator.create('owner', 'Garden website', 'create-12345');
  await coordinator.answer('owner', created.id, 'Neighbors', 'answer-12345');
  const building = coordinator.build('owner', created.id, 'build-12345');
  for (let i = 0; i < 50 && calls < 3; i++) await new Promise(resolve => setTimeout(resolve, 1));
  const cancelled = await coordinator.cancel('owner', created.id);
  assert.equal(cancelled.status, 'cancelled');
  release();
  assert.equal((await building).status, 'cancelled');
  assert.equal((await coordinator.read('owner', created.id)).artifact, null);
});

test('hosted start exposes a cancellable clarification before the provider returns', async () => {
  const { store, budget } = memory();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const provider = { async generate() { calls++; await gate; return { result: { question: 'Who is it for?' }, usage: {} }; } };
  const coordinator = createHostedCoordinator({ access: createHostedProjectAccess({ auth, store }), budget, provider });
  const handler = createHostedMayaHandler({ env, auth, coordinator, enabled: true });
  const started = await call(handler, 'owner', { action: 'start', goal: 'Garden website', requestId: 'start-12345' });
  assert.equal(started.status, 200);
  assert.equal(started.value.status, 'clarifying');
  assert.equal(calls, 0);
  assert.equal((await call(handler, 'owner', { action: 'start', goal: 'Garden website', requestId: 'start-12345' })).value.id, started.value.id);
  const clarifying = call(handler, 'owner', { action: 'clarify', id: started.value.id });
  for (let i = 0; i < 50 && calls < 1; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(calls, 1);
  assert.equal((await call(handler, 'owner', null, { method: 'GET', url: `/api/maya-projects?id=${started.value.id}` })).value.status, 'clarifying');
  assert.equal((await call(handler, 'owner', { action: 'clarify', id: started.value.id })).value.status, 'clarifying');
  assert.equal(calls, 1);
  assert.equal((await call(handler, 'owner', { action: 'cancel', id: started.value.id })).value.status, 'cancelled');
  release();
  assert.equal((await clarifying).value.status, 'cancelled');
  assert.equal((await call(handler, 'owner', null, { method: 'GET', url: `/api/maya-projects?id=${started.value.id}` })).value.status, 'cancelled');
});
