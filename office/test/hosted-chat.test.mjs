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
  const initial = { id: 'project-1', version: 0, goal: 'Garden website', status: 'clarifying', events: [], artifact: null };
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
      if (action === 'clarify') { clarifyStarted(); await clarification; return reply({ ...initial, version: 1, status: 'cancelled' }); }
      if (action === 'cancel') return reply({ ...initial, version: 1, status: 'cancelled' });
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

test('an older status read cannot replace a newer cancellation result', async () => {
  const elements = new Map();
  const listeners = new Map();
  const intervals = new Map();
  const get = name => {
    if (!elements.has(name)) elements.set(name, { hidden: true, disabled: false, textContent: '', value: '',
      addEventListener(type, fn) { listeners.set(`${name}:${type}`, fn); },
      querySelector() { return { disabled: false, textContent: '' }; }, replaceChildren() {}, append() {} });
    return elements.get(name);
  };
  const active = { id: 'project-1', version: 2, status: 'clarifying', events: [], artifact: null };
  let reads = 0;
  let resolveStaleRead;
  const staleRead = new Promise(resolve => { resolveStaleRead = resolve; });
  const reply = value => ({ ok: true, json: async () => value });
  const fetch = async (url, options = {}) => {
    if (url === '/api/maya-status') return reply({ runAvailable: true });
    if (options.method === 'POST') return reply({ ...active, version: 3, status: 'cancelled' });
    return ++reads === 1 ? reply(active) : staleRead;
  };
  const source = await readFile(new URL('../public/office-assets/hosted-chat.js', import.meta.url), 'utf8');
  runInNewContext(source, { document: { querySelector: get, createElement: () => ({ textContent: '' }) }, fetch,
    sessionStorage: { getItem: () => 'project-1', setItem() {}, removeItem() {} }, crypto: { randomUUID: () => 'request-12345' },
    setInterval(fn, delay) { intervals.set(delay, fn); return delay; }, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve));
  const pendingRead = intervals.get(2000)();
  await listeners.get('#hosted-cancel:click')();
  assert.equal(get('#hosted-cancel').hidden, true);
  resolveStaleRead(reply(active));
  await pendingRead;
  assert.equal(get('#hosted-cancel').hidden, true);
  assert.match(get('#hosted-request-state').textContent, /Cancellation recorded/);
});

test('an in-flight stage poll cannot restore a stage after Cancel', async () => {
  const elements = new Map(); const listeners = new Map(); const intervals = new Map();
  const get = name => {
    if (!elements.has(name)) elements.set(name, { hidden: true, disabled: false, textContent: '', value: '',
      addEventListener(type, fn) { listeners.set(`${name}:${type}`, fn); },
      querySelector() { return { disabled: false, textContent: '' }; }, replaceChildren() {}, append() {} });
    return elements.get(name);
  };
  const active = { id: 'project-1', version: 2, status: 'clarifying', events: [], artifact: null };
  const cancelled = { ...active, version: 3, status: 'cancelled' };
  let resolveStaleRead; let resolveAction; let reads = 0;
  const staleRead = new Promise(resolve => { resolveStaleRead = resolve; });
  const heldAction = new Promise(resolve => { resolveAction = resolve; });
  const reply = value => ({ ok: true, json: async () => value });
  const fetch = async (url, options = {}) => {
    if (url === '/api/maya-status') return reply({ runAvailable: true });
    if (options.method === 'POST') return JSON.parse(options.body).action === 'cancel' ? reply(cancelled) : heldAction;
    return ++reads === 1 ? reply(active) : staleRead;
  };
  const source = await readFile(new URL('../public/office-assets/hosted-chat.js', import.meta.url), 'utf8');
  runInNewContext(source, { document: { querySelector: get, createElement: () => ({ textContent: '' }) }, fetch,
    sessionStorage: { getItem: () => 'project-1', setItem() {}, removeItem() {} }, crypto: { randomUUID: () => 'request-12345' },
    setInterval(fn, delay) { intervals.set(delay, fn); return delay; }, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve));
  const pendingRead = intervals.get(500)();
  await listeners.get('#hosted-cancel:click')();
  resolveStaleRead(reply(active));
  await pendingRead;
  assert.equal(get('#hosted-cancel').hidden, true);
  assert.match(get('#hosted-request-state').textContent, /Cancellation recorded/);
  resolveAction(reply(cancelled));
});

test('hosted preview links to sibling reviewed artifact files', async () => {
  const elements = new Map();
  const get = name => {
    if (!elements.has(name)) elements.set(name, { hidden: true, disabled: false, textContent: '', value: '', children: [],
      addEventListener() {}, querySelector() { return { disabled: false, textContent: '' }; },
      replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); } });
    return elements.get(name);
  };
  const id = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const reviewed = { id, version: 4, status: 'reviewed', events: [], artifact: { sha256: 'digest' } };
  const reply = value => ({ ok: true, json: async () => value });
  const source = await readFile(new URL('../public/office-assets/hosted-chat.js', import.meta.url), 'utf8');
  runInNewContext(source, { document: { querySelector: get, createElement: () => ({ textContent: '' }) },
    fetch: async url => reply(url === '/api/maya-status' ? { runAvailable: true } : reviewed),
    sessionStorage: { getItem: () => id, setItem() {}, removeItem() {} },
    setInterval: () => 1, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve));
  const [, link, frame] = get('#hosted-artifact').children;
  assert.equal(link.href, `/api/maya-artifacts/${id}/index.html`);
  assert.equal(frame.src, link.href);
  assert.equal(new URL('styles.css', `https://office.example${frame.src}`).pathname, `/api/maya-artifacts/${id}/styles.css`);
});
