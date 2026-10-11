import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('hosted chat exposes Cancel while a clarification request is in flight', async () => {
  const listeners = new Map();
  function element(name) {
    return { hidden: name === '#hosted-chat', disabled: false, value: '', textContent: '',
      addEventListener(type, fn) { listeners.set(`${name}:${type}`, fn); },
      querySelector() { return { disabled: false, textContent: '' }; },
      replaceChildren() {}, append() {}, focus() {} };
  }
  const elements = new Map();
  const get = name => { if (!elements.has(name)) elements.set(name, element(name)); return elements.get(name); };
  const initial = { id: 'project-1', goal: 'Garden website', status: 'clarifying', events: [], artifact: null };
  let releaseClarification;
  const clarification = new Promise(resolve => { releaseClarification = resolve; });
  let clarifyStarted;
  const started = new Promise(resolve => { clarifyStarted = resolve; });
  const reply = value => ({ ok: true, json: async () => value });
  const fetch = async (_url, options = {}) => {
    if (_url === '/api/maya-status') return reply({ runAvailable: true });
    if (options.method === 'POST') {
      const action = JSON.parse(options.body).action;
      if (action === 'start') return reply(initial);
      if (action === 'clarify') { clarifyStarted(); await clarification; return reply({ ...initial, status: 'cancelled' }); }
      if (action === 'cancel') return reply({ ...initial, status: 'cancelled' });
    }
    return reply(initial);
  };
  const sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const source = await readFile(new URL('../public/office-assets/hosted-chat.js', import.meta.url), 'utf8');
  runInNewContext(source, { document: { querySelector: get, createElement: () => element('new') }, fetch,
    sessionStorage, crypto: { randomUUID: () => 'request-12345' }, setInterval: () => 1, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('#hosted-chat').hidden, false);
  get('#hosted-message').value = 'Garden website';
  const submit = listeners.get('#hosted-chat-form:submit')({ preventDefault() {} });
  await started;
  assert.equal(get('#hosted-cancel').hidden, false);
  await listeners.get('#hosted-cancel:click')();
  assert.equal(get('#hosted-cancel').hidden, true);
  releaseClarification();
  await submit;
  assert.equal(get('#hosted-cancel').hidden, true);
});

test('a reloaded hosted chat observes an existing clarification result', async () => {
  const elements = new Map();
  const intervals = new Map();
  const get = name => {
    if (!elements.has(name)) elements.set(name, { hidden: true, disabled: false, textContent: '', value: '',
      addEventListener() {}, querySelector() { return { disabled: false, textContent: '' }; }, replaceChildren() {}, append() {} });
    return elements.get(name);
  };
  const clarifying = { id: 'project-1', version: 1, status: 'clarifying', events: [], artifact: null };
  let current = clarifying;
  let clarifyPosts = 0;
  const reply = value => ({ ok: true, json: async () => value });
  const fetch = async (url, options = {}) => {
    if (url === '/api/maya-status') return reply({ runAvailable: true });
    if (options.method === 'POST') { clarifyPosts++; return reply(clarifying); }
    return reply(current);
  };
  const source = await readFile(new URL('../public/office-assets/hosted-chat.js', import.meta.url), 'utf8');
  runInNewContext(source, { document: { querySelector: get, createElement: () => ({ textContent: '' }) }, fetch,
    sessionStorage: { getItem: () => 'project-1', setItem() {}, removeItem() {} }, crypto: { randomUUID: () => 'request-12345' },
    setInterval(fn, delay) { intervals.set(delay, fn); return delay; }, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('#hosted-cancel').hidden, false);
  assert.equal(clarifyPosts, 1); // the route reports the existing run
  current = { ...clarifying, version: 2, status: 'needs_answer', events: [{ agent: 'Maya', type: 'question', message: 'Who is it for?' }] };
  await intervals.get(2000)();
  assert.equal(get('#hosted-message').disabled, false);
  assert.equal(get('#hosted-cancel').hidden, true);
  assert.match(get('#hosted-request-state').textContent, /needs answer/);
});
