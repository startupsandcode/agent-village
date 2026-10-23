import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createCheckin, finishCheckin, loadCheckins, readAgents } from '../lib/checkins.mjs';
import { createOfficeServer } from '../server.mjs';
import { createTaskLoader } from '../lib/tasks.mjs';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');

test('explicit check-in expires after 90 minutes and finish clears it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'village-office-'));
  const file = join(dir, 'checkins');
  try {
    await createCheckin(file, 'sam', 'Building the office API', 7, NOW);
    const stored = await loadCheckins(file);
    assert.equal(stored.Sam.expiresAt, '2026-09-18T13:30:00.000Z');
    assert.equal(readAgents(stored, NOW + 5_399_999).find(agent => agent.name === 'Sam').status, 'working');
    const stale = readAgents(stored, NOW + 5_400_000).find(agent => agent.name === 'Sam');
    assert.equal(stale.status, 'stale');
    assert.equal(stale.summary, 'Building the office API');
    await finishCheckin(file, 'sam');
    assert.equal(readAgents(await loadCheckins(file), NOW).find(agent => agent.name === 'Sam').status, 'unknown');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-in rejects unknown agents, invalid summaries, and invalid issue numbers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'village-office-'));
  const file = join(dir, 'checkins');
  try {
    await assert.rejects(createCheckin(file, '../Sam', 'Task', 7, NOW));
    await assert.rejects(createCheckin(file, 'Sam', '   ', 7, NOW));
    await assert.rejects(createCheckin(file, 'Sam', '<script>', 7, NOW));
    await assert.rejects(createCheckin(file, 'Sam', 'Task', '7; echo secret', NOW));
    await assert.rejects(createCheckin(file, 'Sam', 'Task', 0, NOW));
    await assert.rejects(finishCheckin(file, 'Nobody'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('office API returns documented shape and blocks static traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'village-office-'));
  const file = join(dir, 'checkins');
  await createCheckin(file, 'Maya', 'Reviewing issue 7', 7, NOW);
  await writeFile(join(dir, 'index.html'), '<h1>Office</h1>');
  const server = createOfficeServer({
    checkinDir: file,
    publicDir: dir,
    now: () => NOW,
    getTasks: async () => ({ status: 'ok', updatedAt: '2026-09-18T12:00:00.000Z', items: [{ number: 7, title: 'Office', url: 'https://github.com/a/b/issues/7', updatedAt: '2026-09-18T11:00:00Z' }] }),
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.equal(server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/office`);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const body = await response.json();
    assert.equal(body.generatedAt, '2026-09-18T12:00:00.000Z');
    assert.equal(body.agents.length, 5);
    assert.deepEqual(body.agents.find(agent => agent.name === 'Maya'), {
      name: 'Maya', role: 'Engineering lead', status: 'working', summary: 'Reviewing issue 7', issueNumber: 7,
      updatedAt: '2026-09-18T12:00:00.000Z', expiresAt: '2026-09-18T13:30:00.000Z',
    });
    assert.deepEqual(body.tasks.items.map(item => item.number), [7]);
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /^text\/html/);
    assert.equal(await home.text(), '<h1>Office</h1>');
    assert.equal((await fetch(`${base}/.local/checkins.json`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/AGENTS.md`)).status, 404);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const probe = request(`${base}/api/office`, { headers: { Host: 'attacker.example' } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      probe.on('error', reject);
      probe.end();
    });
    assert.equal(hostileHostStatus, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('local server serves private office at /office after the public demo becomes home', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'village-office-'));
  const publicDir = join(dir, 'public');
  const privatePageFile = join(dir, 'private.html');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<h1>Synthetic demo</h1>');
  await writeFile(privatePageFile, '<h1>Local office</h1>');
  const server = createOfficeServer({ publicDir, privatePageFile });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await (await fetch(`${base}/`)).text(), '<h1>Synthetic demo</h1>');
    const office = await fetch(`${base}/office`);
    assert.equal(office.status, 200);
    assert.equal(await office.text(), '<h1>Local office</h1>');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('one malformed report does not erase other agent activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'village-office-'));
  const dir = join(root, 'checkins');
  try {
    await createCheckin(dir, 'Maya', 'Coordinating issue 7', 7, NOW);
    await writeFile(join(dir, 'sam.json'), '{broken');
    const agents = readAgents(await loadCheckins(dir), NOW);
    assert.equal(agents.find(agent => agent.name === 'Maya').status, 'working');
    assert.equal(agents.find(agent => agent.name === 'Sam').status, 'unavailable');
    assert.equal(agents.find(agent => agent.name === 'Quinn').status, 'unknown');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('issue loader validates GitHub data and caches for 30 seconds', async () => {
  let now = NOW;
  let calls = 0;
  const loader = createTaskLoader({ now: () => now, runGh: async args => {
    calls++;
    assert.deepEqual(args, ['issue', 'list', '-R', 'startupsandcode/agent-village', '--state', 'open', '--limit', '100', '--json', 'number,title,url,updatedAt']);
    return JSON.stringify([{ number: 7, title: 'Office', url: 'https://github.com/startupsandcode/agent-village/issues/7', updatedAt: '2026-09-18T11:00:00Z' }]);
  } });
  assert.equal((await loader()).items[0].number, 7);
  now += 29_999;
  assert.equal((await loader()).items[0].number, 7);
  assert.equal(calls, 1);
  now++;
  assert.equal((await loader()).status, 'ok');
  assert.equal(calls, 2);
});
test('cloned local office reads only its configured GitHub repository', async () => {
  const loader = createTaskLoader({ repo: 'acme/village', runGh: async args => {
    assert.equal(args[3], 'acme/village');
    return JSON.stringify([{ number: 7, title: 'Client task', url: 'https://github.com/acme/village/issues/7', updatedAt: '2026-09-18T11:00:00Z' }]);
  } });
  assert.equal((await loader()).items[0].title, 'Client task');
});

test('concurrent agent check-ins preserve every report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'village-office-'));
  const dir = join(root, 'checkins');
  try {
    await Promise.all(['Maya', 'Sam', 'Quinn', 'Theo', 'Susie'].map((agent, index) => createCheckin(dir, agent, `Task ${index + 1}`, index + 1, NOW)));
    const agents = readAgents(await loadCheckins(dir), NOW);
    assert.deepEqual(agents.map(agent => agent.status), ['working', 'working', 'working', 'working', 'working']);
    assert.deepEqual(agents.map(agent => agent.issueNumber), [1, 2, 3, 4, 5]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('issue loader reports unavailable on GitHub failure or malformed output', async () => {
  let attempts = 0;
  const failed = createTaskLoader({ now: () => NOW, runGh: async () => { attempts++; throw new Error('credential detail'); } });
  assert.deepEqual(await failed(), { status: 'error', updatedAt: null, items: [] });
  assert.deepEqual(await failed(), { status: 'error', updatedAt: null, items: [] });
  assert.equal(attempts, 2);
  const malformed = createTaskLoader({ now: () => NOW, runGh: async () => '[{"number":7,"title":"Office","url":"javascript:bad","updatedAt":"bad"}]' });
  assert.deepEqual(await malformed(), { status: 'error', updatedAt: null, items: [] });
});
