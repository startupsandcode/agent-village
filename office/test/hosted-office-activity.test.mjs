import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficeHandler } from '../api/office.mjs';
import { createHostedProjectStore } from '../lib/hosted-project-store.mjs';
import { createHostedProjectAccess } from '../lib/hosted-project-access.mjs';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const auth = { authorize: cookie => cookie === 'valid-a' ? { status: 200, sub: 'owner-a' }
  : cookie === 'valid-b' ? { status: 200, sub: 'owner-b' } : { status: 401 } };

function response() {
  return { statusCode: 200, headers: {}, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; } };
}
function request(cookie = 'valid-a', method = 'GET') {
  return { method, headers: { cookie } };
}
function poolWith(rows, tracker = {}) {
  return class {
    constructor(options) { tracker.opens = (tracker.opens || 0) + 1; tracker.options = options; }
    async query(sql, values) {
      tracker.query = { sql, values };
      if (tracker.fail) throw new Error('private database failure');
      return { rows: rows.filter(row => row.owner === values[0]).map(({ owner, ...row }) => row) };
    }
    async end() { tracker.closes = (tracker.closes || 0) + 1; }
  };
}
async function run({ rows = [], tracker = {}, cookie = 'valid-a', method = 'GET', env = { VILLAGE_DATABASE_URL: 'test-url' }, token = '', fetchImpl = async () => { throw new Error('Issue loader should not fetch without token'); } } = {}) {
  const handler = createOfficeHandler({ env, auth, now: () => NOW, PoolClass: poolWith(rows, tracker), token, fetchImpl });
  const result = response();
  await handler(request(cookie, method), result);
  return result;
}
const stage = (owner, id, status, ageMs) => ({
  owner, id, goal: `Project ${id}`, status, stage_started_at: new Date(NOW - ageMs).toISOString(),
});

test('hosted activity reads only authenticated owners and closes its pool', async () => {
  const tracker = {};
  const result = await run({ tracker, rows: [
    stage('owner-a', 'a', 'building', 1_000),
    stage('owner-b', 'b', 'reviewing', 1_000),
  ] });
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(body.checkinsConfigured, false);
  assert.equal(body.activity.status, 'ok');
  assert.deepEqual(body.activity.agents.filter(agent => agent.status === 'recent').map(agent => [agent.name, agent.projectId]), [['Sam', 'a']]);
  assert.deepEqual(body.activity.agents.filter(agent => agent.status === 'idle').map(agent => agent.name), ['Maya', 'Quinn', 'Theo', 'Susie']);
  assert.equal(result.body.includes('Project b'), false);
  assert.equal(tracker.opens, 1);
  assert.equal(tracker.closes, 1);
  assert.deepEqual(tracker.query.values, ['owner-a', new Date(NOW - 90_000).toISOString()]);
  assert.match(tracker.query.sql, /WHERE owner_sub = \$1/);
  assert.match(tracker.query.sql, /stageStartedAt/);
  assert.equal(body.tasks.status, 'error');
});

test('clarifying and planning map to Maya; building and reviewing map to their own desks', async () => {
  const result = await run({ rows: [
    stage('owner-a', 'clarify', 'clarifying', 8_000),
    stage('owner-a', 'plan', 'planning', 5_000),
    stage('owner-a', 'build', 'building', 6_000),
    stage('owner-a', 'review', 'reviewing', 7_000),
  ] });
  const recent = JSON.parse(result.body).activity.agents.filter(agent => agent.status === 'recent');
  assert.deepEqual(recent.map(agent => [agent.name, agent.stage, agent.projectId]), [
    ['Maya', 'planning', 'plan'], ['Sam', 'building', 'build'], ['Quinn', 'reviewing', 'review'],
  ]);
});

test('finished, stale, and future stages do not report recent activity', async () => {
  const result = await run({ rows: [
    stage('owner-a', 'finished', 'reviewed', 1_000),
    stage('owner-a', 'stale', 'building', 90_000),
    stage('owner-a', 'future', 'reviewing', -1_000),
  ] });
  const body = JSON.parse(result.body);
  assert.equal(body.activity.status, 'ok');
  assert.deepEqual(body.activity.agents.map(agent => agent.status), Array(5).fill('idle'));
});

test('empty activity differs from storage failure and neither blocks GitHub issue results', async () => {
  const empty = JSON.parse((await run()).body);
  assert.equal(empty.activity.status, 'ok');
  assert.equal(empty.activity.agents.length, 5);
  const tracker = { fail: true };
  const failure = JSON.parse((await run({ tracker, token: 'test-token', fetchImpl: async () => ({ ok: true, json: async () => [{ number: 33, title: 'Office activity', html_url: 'https://github.com/startupsandcode/agent-village/issues/33', updated_at: '2026-10-12T11:00:00Z' }] }) })).body);
  assert.equal(failure.activity.status, 'unavailable');
  assert.equal(failure.tasks.status, 'ok');
  assert.deepEqual(failure.tasks.items.map(item => item.number), [33]);
  assert.equal(tracker.closes, 1);
  assert.equal(JSON.stringify(failure).includes('private database failure'), false);
  const absent = JSON.parse((await run({ env: {} })).body);
  assert.equal(absent.activity.status, 'unavailable');
});

test('unauthorized requests never open a database pool or load issues', async () => {
  const tracker = {};
  const result = await run({ cookie: 'bad', tracker });
  assert.equal(result.statusCode, 401);
  assert.equal(tracker.opens, undefined);
  assert.equal(JSON.parse(result.body).error, 'Office access denied');
});

test('HEAD returns no body and still closes the database pool', async () => {
  const tracker = {};
  const result = await run({ method: 'HEAD', tracker, rows: [stage('owner-a', 'a', 'building', 1_000)] });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, undefined);
  assert.equal(tracker.closes, 1);
});

test('activity access ignores caller supplied owners', async () => {
  const calls = [];
  const store = createHostedProjectStore({ query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } });
  const access = createHostedProjectAccess({ auth, store });
  await access.recentStages('valid-a', new Date(NOW - 90_000).toISOString(), { ownerSub: 'owner-b' });
  assert.equal(calls[0].values[0], 'owner-a');
  assert.match(calls[0].sql, /WHERE owner_sub = \$1/);
  assert.throws(() => access.recentStages('bad', new Date(NOW).toISOString()), /access denied/);
});
