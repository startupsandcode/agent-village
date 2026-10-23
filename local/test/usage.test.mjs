import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { readLocalUsage } from '../usage.mjs';
import { VillageEngine } from '../engine.mjs';

test('local project and monthly totals deduplicate a call and keep unknown usage visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'village-usage-'));
  const mine = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const another = '6ba7b810-9dad-41d1-80b4-00c04fd430c9';
  try {
    for (const id of [mine, another]) await mkdir(join(root, id));
    await writeFile(join(root, mine, 'state.json'), JSON.stringify({ id: mine, events: [
      { at: '2026-10-11T10:00:00Z', agent: 'Maya', type: 'usage', callId: 'a', provider: 'openai', model: 'gpt-4.1-mini', state: 'pending' },
      { at: '2026-10-11T10:00:00Z', agent: 'Maya', type: 'usage', callId: 'a', provider: 'openai', model: 'gpt-4.1-mini', state: 'measured', inputTokens: 10, outputTokens: 20, estimatedCostNanoUsd: 99_999_999, message: 'sensitive arbitrary text', secret: 'private-key' },
      { at: '2026-10-11T10:01:00Z', agent: 'Sam', type: 'usage', callId: 'b', provider: 'openai', state: 'unreported' },
    ] }));
    await writeFile(join(root, another, 'state.json'), JSON.stringify({ id: another, events: [
      { at: '2026-10-11T10:02:00Z', agent: 'Quinn', type: 'usage', callId: 'c', provider: 'anthropic', state: 'pending' },
    ] }));
    const summary = await readLocalUsage({ root, projectId: mine, month: '2026-10' });
    assert.equal(summary.project.total.calls, 2);
    assert.equal(summary.project.total.inputTokens, 10);
    assert.equal(summary.monthly.total.calls, 3);
    assert.equal(summary.monthly.total.pendingCalls, 1);
    assert.equal(summary.monthly.total.unreportedCalls, 1);
    assert.equal(summary.project.total.estimatedCostNanoUsd, 36_000);
    assert.ok(!JSON.stringify(summary).includes('private-key'));
    assert.ok(!JSON.stringify(summary).includes('sensitive arbitrary text'));
    assert.ok(!JSON.stringify(summary).includes('"callId"'));
    await assert.rejects(readLocalUsage({ root, projectId: '../other' }), /Invalid usage query/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider failures retain known usage and cancellations without tokens remain unreported', async () => {
  const error = new Error('Provider output truncated');
  error.usage = { input: 7, output: 3 };
  const provider = { name: 'openai', model: 'gpt-4.1-mini',
    generate: async () => { throw error; } };
  const engine = new VillageEngine({ provider });
  engine.save = async () => {};
  const project = { events: [] };
  await assert.rejects(engine.runProvider(project, 'Sam', 'build:abc', {}), /truncated/);
  assert.equal(project.events.length, 1);
  assert.equal(project.events[0].state, 'measured');
  assert.equal(project.events[0].estimatedCostNanoUsd, 7 * 400 + 3 * 1600);
  provider.generate = async () => { throw new Error('Request cancelled'); };
  await assert.rejects(engine.runProvider(project, 'Quinn', 'review:abc', {}), /cancelled/);
  assert.equal(project.events[1].state, 'unreported');
  assert.equal(project.events[1].estimatedCostNanoUsd, null);
});

test('provider model containing its configured key is redacted from usage events', async () => {
  const key = 'test-secret-key-value';
  const provider = { name: 'openai', model: `gpt-${key}`, redact: value => String(value).replaceAll(key, '[redacted]'),
    generate: async () => ({ result: {}, usage: { input: 1, output: 2 } }) };
  const engine = new VillageEngine({ provider });
  engine.save = async () => {};
  const project = { events: [] };
  await engine.runProvider(project, 'Maya', 'clarify:abc', {});
  assert.ok(!JSON.stringify(project.events).includes(key));
});

test('local failed provider response retains reported usage and deduplicates the create retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'village-usage-'));
  let attempts = 0;
  const provider = { name: 'openai', model: 'gpt-4.1-mini', async generate() {
    attempts++;
    const error = new Error('Provider output truncated at token limit'); error.usage = { input: 12, output: 1800 }; throw error;
  } };
  try {
    const engine = new VillageEngine({ root, provider });
    const first = await engine.create('Garden website', 'create-usage-123');
    assert.equal(first.status, 'blocked');
    assert.equal((await engine.create('Garden website', 'create-usage-123')).id, first.id);
    assert.equal(attempts, 1);
    const summary = await readLocalUsage({ root, projectId: first.id, month: first.createdAt.slice(0, 7) });
    assert.equal(summary.project.total.calls, 1);
    assert.equal(summary.project.total.outputTokens, 1800);
    assert.equal(summary.project.total.unreportedCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancelled project usage refreshes a pending call until its receipt settles', async () => {
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.hidden = false; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    get childElementCount() { return this.children.length; }
    get firstChild() { return this.children[0]; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    querySelector() { return this.button; }
  }
  const names = ['#chat-form', '#message', '#conversation', '#events', '#provider', '#build', '#cancel', '#new-project', '#artifact', '#usage-status', '#usage-agents', '#usage-calls', '#usage-pricing'];
  const elements = Object.fromEntries(names.map(name => [name, new Element()]));
  elements['#chat-form'].button = new Element();
  const projectId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const project = { id: projectId, goal: 'Garden site', status: 'cancelled', artifact: null, events: [
    { at: '2026-10-11T10:00:00Z', agent: 'Maya', type: 'cancelled', message: 'Build cancelled' },
  ] };
  const totals = pending => ({ calls: 1, inputTokens: 0, outputTokens: 0, estimatedCostNanoUsd: 0, pendingCalls: pending ? 1 : 0, unreportedCalls: pending ? 0 : 1, unpricedCalls: 0 });
  let pending = true;
  const retries = [];
  const usage = () => ({ project: { total: totals(pending), agents: {} }, monthly: { total: totals(pending) }, month: '2026-10',
    calls: [{ agent: 'Sam', model: 'gpt-4.1-mini', state: pending ? 'pending' : 'unreported' }],
    pricingDate: '2026-10-11', pricingSources: { openai: 'https://example.test/a', anthropic: 'https://example.test/b' } });
  const context = {
    window: { dispatchEvent() {} }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { querySelector: name => elements[name], createElement: () => new Element() },
    sessionStorage: { getItem: () => projectId, setItem() {}, removeItem() {} },
    crypto: { randomUUID: () => 'request-12345' },
    fetch: async path => ({ ok: true, json: async () => path === '/api/status' ? { ready: true, provider: 'mock', model: 'fixture' }
      : path.startsWith('/api/usage') ? usage() : project }),
    setInterval() {}, setTimeout: callback => { retries.push(callback); return retries.length; }, clearTimeout() {}, Date,
  };
  runInNewContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retries.length, 1);
  assert.match(elements['#usage-calls'].children[0].textContent, /pending or interrupted/);
  pending = false;
  retries[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements['#usage-calls'].children[0].textContent, /tokens unreported/);
  assert.equal(retries.length, 1);
});
