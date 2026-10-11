import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  constructor(name) { this.name = name; this.children = []; this.handlers = {}; this.value = ''; this.hidden = false; this.disabled = false; }
  append(...items) { this.children.push(...items); }
  replaceChildren() { this.children = []; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0]; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelector(name) { return this.name === 'form' && name === 'button' ? this.button : this.children.find(item => item.name === name); }
  focus() {}
}
function response(value) { return { ok: true, json: async () => value }; }

test('waiting for Maya is visible without inventing an active desk or result', async () => {
  const names = ['#chat-form', '#message', '#conversation', '#events', '#provider', '#request-state', '#build', '#cancel', '#new-project', '#artifact'];
  const elements = Object.fromEntries(names.map(name => [name, new Element(name)]));
  elements['#chat-form'].name = 'form';
  elements['#chat-form'].button = new Element('button');
  let complete;
  const waiting = new Promise(resolve => { complete = resolve; });
  const notices = [];
  const context = {
    window: { dispatchEvent(event) { if (event.type === 'village-request') notices.push(event.detail); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { querySelector: name => elements[name], createElement: name => new Element(name) },
    sessionStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    crypto: { randomUUID: () => 'request-12345' },
    fetch: path => path === '/api/status' ? Promise.resolve(response({ ready: true, provider: 'mock', model: 'fixture' })) : waiting,
    setInterval: () => {}, Date,
  };
  runInNewContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  elements['#message'].value = 'Garden club website';
  const submit = elements['#chat-form'].handlers.submit({ preventDefault() {} });
  assert.match(elements['#request-state'].textContent, /Waiting for Maya’s recorded clarification/);
  assert.equal(elements['#request-state'].hidden, false);
  assert.equal(elements['#events'].childElementCount, 0);
  assert.equal(notices.length, 1);
  complete(response({ id: 'a20d0a90-3476-4dd7-a903-b2b829394828', goal: 'Garden club website', status: 'needs_answer', artifact: null, events: [{ at: '2026-10-11T10:00:00Z', agent: 'Maya', type: 'question', message: 'Who is it for?' }] }));
  await submit;
  assert.equal(elements['#request-state'].hidden, true);
  assert.equal(notices.at(-1), null);
});

test('late answer response cannot resurrect a project after Start another project', async () => {
  const names = ['#chat-form', '#message', '#conversation', '#events', '#provider', '#build', '#cancel', '#new-project', '#artifact', '#export', '#export-path', '#publish-status'];
  const elements = Object.fromEntries(names.map(name => [name, new Element(name)]));
  elements['#chat-form'].name = 'form';
  elements['#chat-form'].button = new Element('button');
  let releaseAnswer;
  const answerResponse = new Promise(resolve => { releaseAnswer = resolve; });
  const base = { id: 'a20d0a90-3476-4dd7-a903-b2b829394828', goal: 'A garden club website', answer: null, plan: null, status: 'needs_answer', artifact: null, events: [
    { at: '2026-10-11T10:00:00Z', agent: 'Maya', type: 'question', message: 'Who is it for?' },
  ] };
  const ready = { ...base, answer: 'New gardeners', status: 'ready', plan: { acceptance: ['Explain the club', 'Invite visitors'] }, events: [...base.events,
    { at: '2026-10-11T10:01:00Z', agent: 'User', type: 'answer', message: 'New gardeners' },
    { at: '2026-10-11T10:01:01Z', agent: 'Maya', type: 'plan', message: 'Build a club page.' },
  ] };
  const storage = new Map();
  const context = {
    window: { dispatchEvent() {} }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { querySelector: name => elements[name], createElement: name => new Element(name) },
    sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => 'request-12345' },
    fetch: async path => path === '/api/status' ? response({ ready: true, provider: 'mock', model: 'fixture' }) : path === '/api/projects' ? response(base) : path.endsWith('/answer') ? answerResponse : response(base),
    setInterval: () => {}, Date,
  };
  runInNewContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const form = elements['#chat-form'];
  elements['#message'].value = 'A garden club website';
  await form.handlers.submit({ preventDefault() {} });
  assert.equal(storage.get('villageProjectId'), base.id);
  elements['#message'].value = 'New gardeners';
  const pending = form.handlers.submit({ preventDefault() {} });
  elements['#publish-status'].textContent = 'Reviewed files prepared locally.';
  elements['#new-project'].handlers.click();
  releaseAnswer(response(ready));
  await pending;
  assert.equal(storage.has('villageProjectId'), false);
  assert.equal(elements['#conversation'].childElementCount, 0);
  assert.equal(elements['#events'].childElementCount, 0);
  assert.equal(elements['#message'].disabled, false);
  assert.equal(form.button.disabled, false);
  assert.match(elements['#publish-status'].textContent, /reviewed local site is required/);
});
test('late status poll cannot restore a project after Start another project', async () => {
  const names = ['#chat-form', '#message', '#conversation', '#events', '#provider', '#build', '#cancel', '#new-project', '#artifact'];
  const elements = Object.fromEntries(names.map(name => [name, new Element(name)]));
  elements['#chat-form'].name = 'form';
  elements['#chat-form'].button = new Element('button');
  const id = 'a20d0a90-3476-4dd7-a903-b2b829394828';
  const planning = { id, goal: 'A garden club website', answer: 'Neighbors', plan: null, status: 'planning', artifact: null, events: [
    { at: '2026-10-11T10:00:00Z', agent: 'Maya', type: 'question', message: 'Who is it for?' },
    { at: '2026-10-11T10:01:00Z', agent: 'User', type: 'answer', message: 'Neighbors' },
  ] };
  const ready = { ...planning, status: 'ready', plan: { acceptance: ['Explain the club', 'Invite visitors'] }, events: [...planning.events,
    { at: '2026-10-11T10:01:01Z', agent: 'Maya', type: 'plan', message: 'Build a club page.' },
  ] };
  const storage = new Map([['villageProjectId', id]]);
  let poll, getCount = 0, releaseLate;
  const lateResponse = new Promise(resolve => { releaseLate = resolve; });
  const context = {
    window: { dispatchEvent() {} }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { querySelector: name => elements[name], createElement: name => new Element(name) },
    sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => 'request-12345' },
    fetch: async path => {
      if (path === '/api/status') return response({ ready: true, provider: 'mock', model: 'fixture' });
      if (path === `/api/projects/${id}`) { getCount++; return getCount === 1 ? response(planning) : getCount === 2 ? response(ready) : lateResponse; }
      throw new Error('Unexpected request');
    },
    setInterval: fn => { poll = fn; }, Date,
  };
  runInNewContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const firstPoll = poll();
  const latePoll = poll();
  await firstPoll;
  assert.equal(elements['#new-project'].hidden, false);
  elements['#new-project'].handlers.click();
  releaseLate(response(ready));
  await latePoll;
  assert.equal(storage.has('villageProjectId'), false);
  assert.equal(elements['#conversation'].childElementCount, 0);
  assert.equal(elements['#events'].childElementCount, 0);
});
