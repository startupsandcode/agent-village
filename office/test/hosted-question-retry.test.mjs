import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedProjectAccess } from '../lib/hosted-project-access.mjs';
import { createHostedCoordinator } from '../lib/hosted-coordinator.mjs';

function setup(replies) {
  const rows = new Map();
  const claims = new Set();
  const store = {
    async create({ ownerSub, id, snapshot }) {
      const record = { id, version: 0, snapshot: structuredClone(snapshot) };
      rows.set(`${ownerSub}:${id}`, record);
      return structuredClone(record);
    },
    async read({ ownerSub, id }) { return structuredClone(rows.get(`${ownerSub}:${id}`) ?? null); },
    async update({ ownerSub, id, expectedVersion, snapshot }) {
      const key = `${ownerSub}:${id}`;
      const record = rows.get(key);
      if (!record || record.version !== expectedVersion) return null;
      const changed = { id, version: record.version + 1, snapshot: structuredClone(snapshot) };
      rows.set(key, changed);
      return structuredClone(changed);
    },
  };
  const auth = { authorize: cookie => cookie === 'owner' ? { status: 200, sub: 'owner-sub' } : { status: 200, sub: 'other-sub' } };
  const budget = { async reserve(_cookie, { id, kind }) { claims.add(`${kind}:${id}`); return true; } };
  const provider = { calls: 0, async generate() { return { result: replies[this.calls++], usage: { input: 1, output: 2 } }; } };
  const coordinator = createHostedCoordinator({ access: createHostedProjectAccess({ auth, store }), budget, provider });
  return { coordinator, rows, provider, claims };
}

test('invalid Maya question is a retryable question error, then retry records a real question', async () => {
  const { coordinator, provider, claims } = setup([{}, { question: 'Who is the website for?' }]);
  const created = await coordinator.create('owner', 'Build a garden website', 'create-question-1');
  assert.equal(created.status, 'question_error');
  assert.equal(created.retryQuestionAvailable, true);
  assert.equal(created.events.some(event => event.type === 'question'), false);
  assert.equal(provider.calls, 1);
  const retried = await coordinator.retryQuestion('owner', created.id, 'retry-question-1');
  assert.equal(retried.status, 'needs_answer');
  assert.equal(retried.events.at(-1).message, 'Who is the website for?');
  assert.equal(retried.retryQuestionAvailable, false);
  assert.equal((await coordinator.retryQuestion('owner', created.id, 'retry-question-1')).version, retried.version);
  assert.equal(provider.calls, 2);
  assert.equal([...claims].filter(value => value.startsWith('clarify:')).length, 2);
});

test('a second invalid retry remains retryable and duplicate request does not make another call', async () => {
  const { coordinator, provider } = setup([{}, {}, { question: 'What should visitors do?' }]);
  const created = await coordinator.create('owner', 'Build a garden website', 'create-question-2');
  const failed = await coordinator.retryQuestion('owner', created.id, 'retry-question-2');
  assert.equal(failed.status, 'question_error');
  assert.equal(failed.retryQuestionAvailable, true);
  assert.equal((await coordinator.retryQuestion('owner', created.id, 'retry-question-2')).version, failed.version);
  assert.equal(provider.calls, 2);
  assert.equal((await coordinator.retryQuestion('owner', created.id, 'retry-question-3')).status, 'needs_answer');
  assert.equal(provider.calls, 3);
});

test('replaying an older retry ID after another failed retry cannot call Maya again', async () => {
  const { coordinator, provider, claims } = setup([{}, {}, {}]);
  const created = await coordinator.create('owner', 'Build a garden website', 'create-question-5');
  const first = await coordinator.retryQuestion('owner', created.id, 'retry-question-A');
  assert.equal(first.status, 'question_error');
  const second = await coordinator.retryQuestion('owner', created.id, 'retry-question-B');
  assert.equal(second.status, 'question_error');
  assert.equal((await coordinator.retryQuestion('owner', created.id, 'retry-question-A')).version, second.version);
  assert.equal(provider.calls, 3);
  assert.equal([...claims].filter(value => value.startsWith('clarify:')).length, 3);
});

test('overlapping retry requests claim one provider call', async () => {
  const { coordinator, provider, claims } = setup([{}]);
  const created = await coordinator.create('owner', 'Build a garden website', 'create-question-4');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  provider.generate = async () => {
    provider.calls++;
    entered();
    await gate;
    return { result: { question: 'Who is it for?' }, usage: {} };
  };
  const first = coordinator.retryQuestion('owner', created.id, 'retry-question-7');
  await started;
  assert.equal((await coordinator.retryQuestion('owner', created.id, 'retry-question-7')).status, 'clarifying');
  await assert.rejects(coordinator.retryQuestion('owner', created.id, 'retry-question-8'), /Action not expected/);
  assert.equal(provider.calls, 2);
  release();
  assert.equal((await first).status, 'needs_answer');
  assert.equal([...claims].filter(value => value.startsWith('clarify:')).length, 2);
});

test('legacy blocked invalid question can retry; unrelated blocked error cannot', async () => {
  const { coordinator, rows, provider } = setup([{}, { question: 'Who is it for?' }]);
  const created = await coordinator.create('owner', 'Build a garden website', 'create-question-3');
  const key = `owner-sub:${created.id}`;
  const legacy = rows.get(key);
  legacy.snapshot.status = 'blocked';
  legacy.snapshot.events.at(-1).message = 'Maya returned an invalid question';
  assert.equal((await coordinator.read('owner', created.id)).retryQuestionAvailable, true);
  assert.equal((await coordinator.retryQuestion('owner', created.id, 'retry-question-4')).status, 'needs_answer');
  assert.equal(provider.calls, 2);
  const unrelated = rows.get(key);
  unrelated.snapshot.status = 'blocked';
  unrelated.snapshot.events.push({ at: new Date().toISOString(), agent: 'System', type: 'error', message: 'Artifact receipt invalid' });
  assert.equal((await coordinator.read('owner', created.id)).retryQuestionAvailable, false);
  await assert.rejects(coordinator.retryQuestion('owner', created.id, 'retry-question-5'), /Action not expected/);
  assert.equal(provider.calls, 2);
  await assert.rejects(coordinator.retryQuestion('other', created.id, 'retry-question-6'), /Project not found/);
});

test('retry history stays bounded without reopening spent request IDs', async () => {
  const { coordinator, rows, provider } = setup([{}]);
  const created = await coordinator.create('owner', 'Build a garden website', 'create-question-6');
  const record = rows.get(`owner-sub:${created.id}`);
  record.snapshot.clarifyRequestIds = Array.from({ length: 80 }, (_, index) => `retry-history-${index}`);
  record.snapshot.clarifyRequestId = 'retry-history-79';
  assert.equal((await coordinator.read('owner', created.id)).retryQuestionAvailable, false);
  assert.equal((await coordinator.retryQuestion('owner', created.id, 'retry-history-0')).version, record.version);
  await assert.rejects(coordinator.retryQuestion('owner', created.id, 'retry-new-81'), /Action not expected/);
  assert.equal(provider.calls, 1);
});
