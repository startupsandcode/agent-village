import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedDomain } from '../lib/hosted-domain.mjs';
import { createHostedProjectAccess } from '../lib/hosted-project-access.mjs';
import { createHostedCoordinator } from '../lib/hosted-coordinator.mjs';
import { createMayaDomainHandler } from '../api/maya-domain.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const blank = { audience: '', expertise: '', rules: '' };
const profile = { audience: 'Local gardeners', expertise: 'Seed swaps', rules: 'Plain language' };
const auth = { authorize: cookie => cookie === 'a' ? { status: 200, sub: 'owner-a', email: 'a@example.com' }
  : cookie === 'b' ? { status: 200, sub: 'owner-b', email: 'b@example.com' }
    : { status: 401 } };

test('hosted domain answers are validated, owner scoped, and reject the active API key', async () => {
  const rows = new Map();
  const domain = createHostedDomain({ auth, containsSecret: value => value.includes('test-secret'), query: async (sql, values) => {
    if (sql.startsWith('SELECT')) return { rows: rows.has(values[0]) ? [{ profile: rows.get(values[0]) }] : [] };
    if (sql.startsWith('INSERT')) rows.set(values[0], JSON.parse(values[1]));
    return { rows: [] };
  } });
  assert.deepEqual(await domain.read('a'), blank);
  assert.deepEqual(await domain.save('a', profile), profile);
  assert.deepEqual(await domain.read('a'), profile);
  assert.deepEqual(await domain.read('b'), blank);
  await assert.rejects(domain.save('a', { ...profile, rules: 'test-secret' }), /API key/);
  await assert.rejects(domain.save('a', { ...profile, audience: 'x'.repeat(501) }), /under 500/);
  await assert.rejects(domain.read('anonymous'), /denied/);
  assert.equal(rows.size, 1);
});

test('hosted domain route requires an operator and same origin before accessing storage', async () => {
  let opened = 0; let closed = 0;
  const env = { OFFICE_ALLOWED_ORIGINS: 'https://office.example', OFFICE_RUN_ALLOWED_EMAILS: 'a@example.com' };
  const handler = createMayaDomainHandler({ env, auth, runtimeFactory: async () => {
    opened++; return { domain: { read: async () => profile, save: async (_cookie, value) => value }, close: async () => { closed++; } };
  } });
  async function call(cookie, method, body, origin = 'https://office.example') {
    const response = { statusCode: 0, body: '', setHeader() {}, end(value) { this.body = value; } };
    await handler({ method, url: '/api/maya-domain', body, headers: { cookie, host: 'office.example', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }, response);
    return response;
  }
  assert.equal((await call(null, 'GET')).statusCode, 401);
  assert.equal((await call('b', 'GET')).statusCode, 403);
  assert.equal((await call('a', 'POST', profile, 'https://other.example')).statusCode, 403);
  assert.equal(opened, 0);
  const saved = await call('a', 'POST', profile);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(JSON.parse(saved.body), profile);
  assert.equal((await call('a', 'POST', { ...profile, extra: 'wrong' })).statusCode, 400);
  assert.equal(opened, 1); assert.equal(closed, 1);
});

test('new hosted projects snapshot domain answers into all three agent inputs', async () => {
  const rows = new Map(); const calls = [];
  const store = {
    async create({ ownerSub, id, snapshot }) { const row = { id, version: 0, snapshot }; rows.set(`${ownerSub}:${id}`, row); return structuredClone(row); },
    async read({ ownerSub, id }) { return structuredClone(rows.get(`${ownerSub}:${id}`) ?? null); },
    async update({ ownerSub, id, expectedVersion, snapshot }) { const row = rows.get(`${ownerSub}:${id}`); if (row.version !== expectedVersion) return null;
      const next = { id, version: expectedVersion + 1, snapshot }; rows.set(`${ownerSub}:${id}`, next); return structuredClone(next); },
  };
  const provider = { async generate({ input }) {
    calls.push(JSON.parse(input));
    const result = calls.length === 1 ? { question: 'Who is it for?' }
      : calls.length === 2 ? { summary: 'Garden site', audience: 'Neighbors', acceptance: ['Explain', 'Invite'], decision: 'Build' }
        : calls.length === 3 ? { title: 'Garden', theme: 'forest', sections: [
          { type: 'hero', heading: 'Welcome', body: 'Join neighbors', actionText: 'Explore' },
          { type: 'text', heading: 'Meet', body: 'Learn together' } ] }
          : { approved: true, summary: 'Matches', findings: [] };
    return { result, usage: { input: 1, output: 1 } };
  } };
  let currentProfile = profile;
  const coordinator = createHostedCoordinator({ access: createHostedProjectAccess({ auth, store }), provider,
    domain: { read: async () => currentProfile }, budget: { reserve: async () => true } });
  const started = await coordinator.create('a', 'Garden site', 'create-domain-1');
  currentProfile = { ...profile, audience: 'Changed later' };
  const planned = await coordinator.answer('a', started.id, 'Neighbors', 'answer-domain-1');
  const built = await coordinator.build('a', started.id, 'build-domain-1');
  const reviewed = await coordinator.review('a', started.id, 'review-domain-1');
  assert.equal(reviewed.status, 'reviewed');
  assert.deepEqual(reviewed.domainProfile, profile);
  assert.equal(planned.domainProfile.audience, profile.audience);
  assert.equal(built.domainProfile.audience, profile.audience);
  for (const input of calls) assert.deepEqual(input.domainProfile, profile);
});

test('hosted setup interview loads and saves domain answers through the owner API', async () => {
  const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
  for (const name of ['audience', 'expertise', 'rules']) assert.match(html, new RegExp(`id="hosted-domain-${name}"`));
  const listeners = new Map(); const elements = new Map();
  const get = name => {
    if (!elements.has(name)) elements.set(name, { hidden: name === '#hosted-chat', value: '', textContent: '', disabled: false,
      addEventListener(type, fn) { listeners.set(`${name}:${type}`, fn); },
      querySelector() { return { disabled: false, textContent: '' }; }, replaceChildren() {}, append() {} });
    return elements.get(name);
  };
  let saved;
  const reply = value => ({ ok: true, json: async () => value });
  const fetch = async (url, options = {}) => {
    if (url === '/api/maya-status') return reply({ runAvailable: true });
    if (url === '/api/maya-domain') {
      if (options.method === 'POST') { saved = JSON.parse(options.body); return reply(saved); }
      return reply(profile);
    }
    return reply({});
  };
  const source = await readFile(new URL('../public/office-assets/hosted-chat.js', import.meta.url), 'utf8');
  runInNewContext(source, { document: { querySelector: get, createElement: () => ({ textContent: '' }), createTextNode: value => ({ textContent: value }) },
    fetch, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setInterval: () => 1, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('#hosted-domain-audience').value, profile.audience);
  get('#hosted-domain-rules').value = 'Use examples';
  await listeners.get('#hosted-domain-form:submit')({ preventDefault() {} });
  assert.deepEqual(saved, { ...profile, rules: 'Use examples' });
  assert.match(get('#hosted-domain-result').textContent, /Saved.*new projects/);
});
