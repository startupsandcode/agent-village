import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredUsage, usageReceipt, summarizeUsage } from '../lib/usage.mjs';
import { createHostedUsage } from '../lib/hosted-usage.mjs';
import { createMayaUsageHandler } from '../api/maya-usage.mjs';

test('measured tokens and dated model prices stay separate from missing usage and unknown models', () => {
  assert.deepEqual(measuredUsage('openai', 'gpt-4.1-mini', { input: 100, output: 20, cachedInput: 25 }), {
    inputTokens: 100, outputTokens: 20, cachedInputTokens: 25, cacheCreationInputTokens: 0, estimatedCostNanoUsd: 64_500,
  });
  assert.equal(measuredUsage('anthropic', 'claude-sonnet-5-5', { input: 100, output: 20, cachedInput: 30, cacheCreationInput: 10 }).estimatedCostNanoUsd, 428_000);
  assert.equal(usageReceipt('openai', 'gpt-4.1-mini', null).state, 'unreported');
  assert.equal(usageReceipt('openai', 'custom-model', { input: 0, output: 0 }).estimatedCostNanoUsd, null);
  assert.equal(measuredUsage('openai', 'gpt-4.1-mini', { input: 1, output: 0, cachedInput: 2 }), null);
  const totals = summarizeUsage([
    { agent: 'Maya', provider: 'openai', state: 'measured', inputTokens: 100, outputTokens: 20, estimatedCostNanoUsd: 64_500 },
    { agent: 'Sam', state: 'unreported' }, { agent: 'Quinn', state: 'pending' },
  ]);
  assert.equal(totals.total.calls, 3);
  assert.equal(totals.total.measuredCalls, 1);
  assert.equal(totals.total.unreportedCalls, 1);
  assert.equal(totals.total.pendingCalls, 1);
  assert.equal(totals.total.estimatedCostNanoUsd, 64_500);
});

test('per-agent usage totals do not inherit earlier agents or inflate across interleaved calls', () => {
  const records = [
    { agent: 'Maya', provider: 'openai', state: 'measured', inputTokens: 10, outputTokens: 1, estimatedCostNanoUsd: 100 },
    { agent: 'Sam', provider: 'openai', state: 'measured', inputTokens: 20, outputTokens: 2, estimatedCostNanoUsd: 200 },
    { agent: 'Maya', provider: 'openai', state: 'measured', inputTokens: 3, outputTokens: 4, estimatedCostNanoUsd: 300 },
    { agent: 'Quinn', state: 'unreported' },
  ];
  const result = summarizeUsage(records);
  assert.equal(result.total.calls, 4);
  assert.equal(result.total.estimatedCostNanoUsd, 600);
  assert.deepEqual({ calls: result.agents.Maya.calls, input: result.agents.Maya.inputTokens, cost: result.agents.Maya.estimatedCostNanoUsd },
    { calls: 2, input: 13, cost: 400 });
  assert.deepEqual({ calls: result.agents.Sam.calls, input: result.agents.Sam.inputTokens, cost: result.agents.Sam.estimatedCostNanoUsd },
    { calls: 1, input: 20, cost: 200 });
  assert.deepEqual({ calls: result.agents.Quinn.calls, unreported: result.agents.Quinn.unreportedCalls, cost: result.agents.Quinn.estimatedCostNanoUsd },
    { calls: 1, unreported: 1, cost: 0 });
});

test('hosted usage writes are owner scoped, idempotent and expose only that owner’s month and project', async () => {
  const rows = new Map();
  const query = async (sql, values) => {
    if (sql.startsWith('INSERT')) {
      const [owner, callId, projectId, agent, provider, model, month] = values;
      if (!rows.has(`${owner}:${callId}`)) rows.set(`${owner}:${callId}`, { owner, call_id: callId, project_id: projectId, agent, provider, model, month,
        state: 'pending', input_tokens: null, output_tokens: null, cached_input_tokens: null, cache_creation_input_tokens: null, estimated_cost_nano_usd: null, started_at: '2026-10-11T15:00:00Z' });
    } else if (sql.startsWith('UPDATE')) {
      const [owner, callId, state, input, output, cached, writes, estimate] = values;
      const row = rows.get(`${owner}:${callId}`);
      if (row?.state === 'pending') Object.assign(row, { state, input_tokens: input, output_tokens: output, cached_input_tokens: cached,
        cache_creation_input_tokens: writes, estimated_cost_nano_usd: estimate });
    } else if (sql.startsWith('SELECT')) {
      const [owner, value] = values;
      return { rows: [...rows.values()].filter(row => row.owner === owner &&
        (sql.includes('month = $2') ? row.month === value : row.project_id === value)) };
    }
    return { rows: [] };
  };
  const auth = { authorize: cookie => cookie === 'owner' ? { status: 200, sub: 'owner-1' } : cookie === 'other' ? { status: 200, sub: 'owner-2' } : { status: 401 } };
  const store = createHostedUsage({ query, auth });
  const projectId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const claim = { callId: 'clarify:call-1', projectId, agent: 'Maya', provider: 'openai', model: 'gpt-4.1-mini', month: '2026-10' };
  await store.begin('owner', claim); await store.begin('owner', claim);
  await store.complete('owner', claim.callId, claim.provider, claim.model, { input: 10, output: 20 });
  await store.complete('owner', claim.callId, claim.provider, claim.model, { input: 999, output: 999 });
  await store.begin('other', claim);
  await store.complete('other', claim.callId, claim.provider, claim.model, null);
  const own = await store.summary('owner', { projectId, month: '2026-10' });
  const other = await store.summary('other', { projectId, month: '2026-10' });
  assert.equal(own.monthly.total.calls, 1);
  assert.equal(own.project.total.inputTokens, 10);
  assert.equal(own.project.total.estimatedCostNanoUsd, 36_000);
  assert.equal(other.monthly.total.unreportedCalls, 1);
  assert.equal(other.project.total.inputTokens, 0);
  await assert.rejects(store.summary('anonymous', { projectId }), /denied/);
  assert.equal(rows.size, 2);
});

test('usage route enforces operator session, same site and owner-bound runtime', async () => {
  const env = { OFFICE_ALLOWED_ORIGINS: 'https://office.example', OFFICE_RUN_ALLOWED_EMAILS: 'owner@example.com' };
  const auth = { authorize: cookie => cookie === 'owner' ? { status: 200, sub: 'owner-sub', email: 'owner@example.com' }
    : cookie === 'viewer' ? { status: 200, sub: 'viewer-sub', email: 'viewer@example.com' } : { status: 401 } };
  let opened = 0; let closed = 0;
  const handler = createMayaUsageHandler({ env, auth, runtimeFactory: async () => { opened++; return { usage: { summary: async cookie => {
    assert.equal(cookie, 'owner'); return { monthly: summarizeUsage([]), project: summarizeUsage([]), calls: [] };
  } }, close: async () => { closed++; } }; } });
  async function call(cookie, fetchSite = 'same-origin') {
    const response = { statusCode: 0, body: '', setHeader() {}, end(value) { this.body = value; } };
    await handler({ method: 'GET', url: '/api/maya-usage', headers: { host: 'office.example', cookie, 'sec-fetch-site': fetchSite } }, response);
    return response;
  }
  assert.equal((await call()).statusCode, 401);
  assert.equal((await call('viewer')).statusCode, 403);
  assert.equal((await call('owner', 'cross-site')).statusCode, 403);
  assert.equal(opened, 0);
  const result = await call('owner');
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).monthly.total.calls, 0);
  assert.equal(opened, 1); assert.equal(closed, 1);
});
