import test from 'node:test';
import assert from 'node:assert/strict';
import { createMayaHealthHandler } from '../api/maya-health.mjs';

const env = { OFFICE_ALLOWED_ORIGINS: 'https://office.example', OFFICE_RUN_ALLOWED_EMAILS: 'owner@example.com',
  VILLAGE_DATABASE_URL: 'postgres://test-only-placeholder' };
const auth = { authorize: cookie => cookie === 'owner' ? { status: 200, email: 'owner@example.com' }
  : cookie === 'viewer' ? { status: 200, email: 'viewer@example.com' } : { status: 401 } };
function response() { return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } }; }
async function call(handler, cookie, { method = 'GET', host = 'office.example', fetchSite = 'same-origin' } = {}) {
  const result = response();
  await handler({ method, headers: { cookie, host, 'sec-fetch-site': fetchSite } }, result);
  return { status: result.statusCode, value: JSON.parse(result.body) };
}

test('read-only database health checks all three tables after operator auth, even with hosted runs off', async () => {
  const queries = []; let opened = 0; let closed = 0;
  class Pool {
    constructor(options) { opened++; assert.equal(options.connectionString, env.VILLAGE_DATABASE_URL); }
    async query(sql) { queries.push(sql); return { rows: [] }; }
    async end() { closed++; }
  }
  const handler = createMayaHealthHandler({ env, auth, PoolClass: Pool });
  assert.equal((await call(handler)).status, 401);
  assert.equal((await call(handler, 'viewer')).status, 403);
  assert.equal((await call(handler, 'owner', { fetchSite: 'cross-site' })).status, 403);
  assert.equal((await call(handler, 'owner', { host: 'other.example' })).status, 503);
  assert.equal((await call(handler, 'owner', { method: 'POST' })).status, 405);
  assert.equal(opened, 0);
  const result = await call(handler, 'owner');
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.tables, ['village_projects', 'village_monthly_budget', 'village_budget_claims']);
  assert.equal(result.value.ready, true);
  assert.equal(result.value.usageReady, true);
  assert.equal(result.value.domainReady, true);
  assert.equal(queries.length, 5);
  assert.ok(queries.every(sql => /^SELECT 1 FROM village_[a-z_]+ LIMIT 0$/.test(sql)));
  assert.equal(opened, 1); assert.equal(closed, 1);
  assert.ok(!JSON.stringify(result).includes(env.VILLAGE_DATABASE_URL));
});

test('001 database remains readable while additive usage migration is pending', async () => {
  class Pool {
    async query(sql) { if (sql.includes('village_provider_usage')) throw new Error('missing 002'); return { rows: [] }; }
    async end() {}
  }
  const result = await call(createMayaHealthHandler({ env, auth, PoolClass: Pool }), 'owner');
  assert.equal(result.status, 200);
  assert.equal(result.value.ready, true);
  assert.equal(result.value.usageReady, false);
});

test('003 database readiness is reported separately from the running 001 schema', async () => {
  class Pool {
    async query(sql) { if (sql.includes('village_domain_profiles')) throw new Error('missing 003'); return { rows: [] }; }
    async end() {}
  }
  const result = await call(createMayaHealthHandler({ env, auth, PoolClass: Pool }), 'owner');
  assert.equal(result.status, 200);
  assert.equal(result.value.ready, true);
  assert.equal(result.value.usageReady, true);
  assert.equal(result.value.domainReady, false);
});

test('health reports a safe category for a missing usage table or denied app role', async () => {
  for (const [code, expected] of [['42P01', 'missing_table'], ['42501', 'permission_denied'], ['XX000', 'unavailable']]) {
    class Pool {
      async query(sql) { if (sql.includes('village_provider_usage')) throw Object.assign(new Error('private database detail'), { code }); return { rows: [] }; }
      async end() {}
    }
    const result = await call(createMayaHealthHandler({ env, auth, PoolClass: Pool }), 'owner');
    assert.equal(result.status, 200);
    assert.equal(result.value.ready, true);
    assert.equal(result.value.usageReady, false);
    assert.equal(result.value.usageIssue, expected);
    assert.equal(result.value.domainReady, true);
    assert.ok(!JSON.stringify(result.value).includes('private database detail'));
  }
});

test('database health does not leak connection errors and always closes the pool', async () => {
  let closed = 0;
  class Pool { async query() { throw new Error('database secret diagnostic'); } async end() { closed++; } }
  const result = await call(createMayaHealthHandler({ env, auth, PoolClass: Pool }), 'owner');
  assert.equal(result.status, 503);
  assert.equal(result.value.ready, false);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(closed, 1);
  assert.equal((await call(createMayaHealthHandler({ env: { ...env, VILLAGE_DATABASE_URL: '' }, auth, PoolClass: Pool }), 'owner')).status, 503);
});
