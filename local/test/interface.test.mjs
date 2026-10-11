import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../providers.mjs';
import { VillageEngine } from '../engine.mjs';
import { createLocalServer } from '../server.mjs';
import { artifactDigest, renderArtifact, verifyStaticSite } from '../artifact.mjs';
import { exportProject } from '../export.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const validSite = { title: 'Garden Club', theme: 'forest', sections: [
  { type: 'hero', heading: 'Grow together', body: 'A welcoming club for neighborhood gardeners.', actionText: 'Explore benefits' },
  { type: 'cards', heading: 'Why join', items: [{ title: 'Meet', body: 'Connect with nearby gardeners.' }, { title: 'Learn', body: 'Share practical growing tips.' }] },
  { type: 'cta', heading: 'Visit a gathering', body: 'Come meet neighbors at the next garden gathering.' },
] };
const sequence = [
  { question: 'Who is the site for?' },
  { summary: 'A garden club landing page', audience: 'Local gardeners', acceptance: ['Explain the club', 'Invite visitors'], decision: 'Build a small site for nearby gardeners.' },
  validSite,
  { approved: true, summary: 'The generated page covers the stated goal.', findings: [] },
];
function mockProvider(values = sequence) {
  let count = 0;
  return { name: 'mock', model: 'deterministic', calls: [], async generate(args) { this.calls.push(args); return { result: values[count++], usage: { input: 10, output: 20 } }; } };
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'village-local-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function completed(engine) {
  const first = await engine.create('A neighborhood garden club website', 'request-12345');
  const second = await engine.answer(first.id, 'Local gardeners', 'answer-12345');
  await engine.build(first.id, 'build-12345');
  for (let i = 0; i < 100; i++) { const value = await engine.get(first.id); if (!['building', 'reviewing'].includes(value.status)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Build did not finish');
}

test('OpenAI and Anthropic adapters use server headers and parse results', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.includes('openai')
      ? { status: 'completed', output_text: '{"question":"OpenAI question"}', usage: { input_tokens: 1, output_tokens: 2 } }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"question":"Anthropic question"}' }], usage: { input_tokens: 3, output_tokens: 4 } } };
  };
  const openai = createProvider({ name: 'openai', env: { OPENAI_API_KEY: 'test-openai' }, fetchImpl });
  const anthropic = createProvider({ name: 'anthropic', env: { ANTHROPIC_API_KEY: 'test-anthropic' }, fetchImpl });
  assert.equal((await openai.generate({ system: 'system', input: 'input' })).result.question, 'OpenAI question');
  assert.equal((await anthropic.generate({ system: 'system', input: 'input' })).result.question, 'Anthropic question');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-openai');
  assert.equal(calls[1].options.headers['x-api-key'], 'test-anthropic');
  assert.ok(!calls[0].options.body.includes('test-openai'));
  assert.ok(!calls[1].options.body.includes('test-anthropic'));
  assert.deepEqual(JSON.parse(calls[1].options.body).thinking, { type: 'between_tools' });
  assert.deepEqual(JSON.parse(calls[1].options.body).output_config, { effort: 'low' });
});
test('OpenAI parses the raw Responses HTTP output shape', async () => {
  const provider = createProvider({ name: 'openai', env: { OPENAI_API_KEY: 'fake' }, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"question":"Raw HTTP output"}' }] }] }) }) });
  assert.equal((await provider.generate({ system: 'x', input: 'y' })).result.question, 'Raw HTTP output');
});
test('provider missing-key and HTTP errors are explicit without body leakage', async () => {
  assert.throws(() => createProvider({ name: 'openai', env: {} }), /Missing OPENAI_API_KEY/);
  assert.throws(() => createProvider({ name: 'anthropic', env: {} }), /Missing ANTHROPIC_API_KEY/);
  const provider = createProvider({ name: 'openai', env: { OPENAI_API_KEY: 'private-key' }, fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(provider.generate({ system: 'x', input: 'y' }), /Provider request failed \(401\)/);
});
test('provider truncation and cancellation fail without treating partial JSON as success', async () => {
  const openai = createProvider({ name: 'openai', env: { OPENAI_API_KEY: 'fake' }, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'incomplete', output_text: '{"question":"partial"}' }) }) });
  await assert.rejects(openai.generate({ system: 'x', input: 'y' }), /truncated/);
  const anthropic = createProvider({ name: 'anthropic', env: { ANTHROPIC_API_KEY: 'fake' }, fetchImpl: async () => ({ ok: true, json: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"question":"partial"}' }] }) }) });
  await assert.rejects(anthropic.generate({ system: 'x', input: 'y' }), /truncated/);
  const controller = new AbortController();
  const pending = createProvider({ name: 'openai', env: { OPENAI_API_KEY: 'fake' }, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const call = pending.generate({ system: 'x', input: 'y', signal: controller.signal });
  controller.abort();
  await assert.rejects(call, /Request cancelled/);
  const timeout = createProvider({ name: 'openai', env: { OPENAI_API_KEY: 'fake' }, timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(timeout.generate({ system: 'x', input: 'y' }), /Provider timed out/);
  const ignoringAbort = createProvider({ name: 'openai', env: { OPENAI_API_KEY: 'fake' }, timeoutMs: 5, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(ignoringAbort.generate({ system: 'x', input: 'y' }), /Provider timed out/);
});
test('configured API key is rejected from chat before any provider call', async () => fixture(async root => {
  const provider = mockProvider();
  provider.containsSecret = value => String(value).includes('private-key');
  const engine = new VillageEngine({ root, provider });
  await assert.rejects(engine.create('Use private-key in this site', 'request-12345'), /Do not put an API key in chat/);
  assert.equal(provider.calls.length, 0);
}));
test('full mock flow creates an inspectable artifact and exact review receipt', async () => fixture(async root => {
  const provider = mockProvider(); const engine = new VillageEngine({ root, provider });
  const result = await completed(engine);
  assert.equal(result.status, 'reviewed');
  assert.equal(result.events.filter(event => event.agent === 'Sam' && event.type === 'result').length, 1);
  assert.equal(result.events.find(event => event.agent === 'Quinn' && event.type === 'review').reviewedSha256, result.artifact.sha256);
  assert.ok(result.events.find(event => event.agent === 'Sam' && event.type === 'result').checks.includes('No executable markup'));
  const html = await readFile(join(root, result.id, 'index.html'), 'utf8');
  assert.match(html, /Grow together/);
  assert.equal(provider.calls.length, 4);
  assert.match(provider.calls[3].input, /Grow together/);
  assert.equal((await engine.create('duplicate', 'request-12345')).id, result.id);
  assert.equal((await engine.build(result.id, 'build-12345')).events.length, result.events.length);
  assert.equal(provider.calls.length, 4);
  await assert.rejects(engine.artifact(result.id, '../state.json'), /Artifact not found/);
}));
test('reviewed site exports a runnable, receipt-checked project without chat or keys', async () => fixture(async root => {
  const engine = new VillageEngine({ root, provider: mockProvider() });
  const result = await completed(engine);
  const output = await exportProject(engine, result.id);
  assert.equal(output.sha256, result.artifact.sha256);
  assert.equal((await exportProject(engine, result.id)).path, output.path);
  const files = await Promise.all(['index.html', 'styles.css', 'verify.test.mjs', 'package.json', 'README.md', '.vercelignore'].map(name => readFile(join(output.path, name), 'utf8')));
  assert.ok(files.every(value => !value.includes('OPENAI_API_KEY') && !value.includes('ANTHROPIC_API_KEY')));
  const tested = await execFileAsync(process.execPath, ['verify.test.mjs'], { cwd: output.path });
  assert.match(tested.stdout + tested.stderr, /pass 1/);
  await writeFile(join(output.path, 'index.html'), 'changed');
  await assert.rejects(exportProject(engine, result.id), /Prepared project changed/);
  await writeFile(join(output.path, 'index.html'), await engine.artifact(result.id, 'index.html'));
  await rm(join(output.path, 'verify.test.mjs'));
  await assert.rejects(exportProject(engine, result.id), /Prepared project changed/);
}));
test('export rejects extra delivery files and test discovery stays pinned', async () => fixture(async root => {
  const engine = new VillageEngine({ root, provider: mockProvider() });
  const result = await completed(engine);
  const output = await exportProject(engine, result.id);
  assert.equal(JSON.parse(await readFile(join(output.path, 'package.json'), 'utf8')).scripts.test, 'node --test verify.test.mjs');
  await writeFile(join(output.path, 'extra.test.mjs'), "throw new Error('extra test executed')\n");
  await assert.rejects(exportProject(engine, result.id), /Prepared project changed/);
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  const rejected = await execFileAsync(process.execPath, ['--test', 'verify.test.mjs'], { cwd: output.path, env: cleanEnv }).then(() => null, error => error);
  assert.ok(rejected);
  assert.match(rejected.stdout, /fail 1/);
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /extra test executed/);
  await rm(join(output.path, 'extra.test.mjs'));
  await mkdir(join(output.path, 'assets'));
  await assert.rejects(exportProject(engine, result.id), /Prepared project changed/);
  await rm(join(output.path, 'assets'), { recursive: true });
  await mkdir(join(output.path, '.git'));
  await mkdir(join(output.path, '.vercel'));
  assert.equal((await exportProject(engine, result.id)).path, output.path);
  await writeFile(join(output.path, '.vercelignore'), 'changed');
  await assert.rejects(exportProject(engine, result.id), /Prepared project changed/);
}));
test('static site verification rejects executable and remote resources', () => {
  const base = '<!doctype html><html lang="en"><title>Safe</title><link rel="stylesheet" href="styles.css"><h1>Safe</h1></html>';
  const css = 'body { font-family: system-ui; color: #123456; background: #ffffff; margin: 0; padding: 2rem; line-height: 1.5; }';
  assert.equal(verifyStaticSite(base, css).length, 5);
  assert.throws(() => verifyStaticSite(base.replace('</html>', '<script>alert(1)</script></html>'), css), /No executable markup/);
  assert.throws(() => verifyStaticSite(base, `${css} @import "https://example.com/a.css";`), /No remote resources/);
});
test('Sam can choose different safe page structures and themes', () => {
  const first = renderArtifact(validSite);
  const second = renderArtifact({ title: 'Garden questions', theme: 'ocean', sections: [
    { type: 'hero', heading: 'Ask local gardeners', body: 'Friendly answers from nearby growers.', actionText: 'Read answers' },
    { type: 'faq', heading: 'Common questions', items: [{ question: 'When?', answer: 'Every Saturday.' }, { question: 'Who?', answer: 'Anyone nearby.' }] },
    { type: 'text', heading: 'Come as you are', body: 'Beginners are welcome.' },
  ] });
  assert.notEqual(first.sha256, second.sha256);
  assert.match(first.html, /section-cards/);
  assert.match(second.html, /section-faq/);
  assert.match(second.html, /<details>/);
  assert.notEqual(first.css, second.css);
  assert.throws(() => renderArtifact({ ...validSite, theme: 'javascript' }), /Invalid artifact structure/);
  assert.throws(() => renderArtifact({ ...validSite, theme: '__proto__' }), /Invalid artifact structure/);
  assert.throws(() => renderArtifact({ ...validSite, theme: 'constructor' }), /Invalid artifact structure/);
  assert.throws(() => renderArtifact({ ...validSite, sections: [validSite.sections[1], validSite.sections[0]] }), /Invalid artifact structure/);
});
test('request ID remains deduplicated after server restart', async () => fixture(async root => {
  const firstProvider = mockProvider();
  const first = await new VillageEngine({ root, provider: firstProvider }).create('Garden club website', 'request-12345');
  const secondProvider = mockProvider();
  const replay = await new VillageEngine({ root, provider: secondProvider }).create('Garden club website', 'request-12345');
  assert.equal(replay.id, first.id);
  assert.equal(secondProvider.calls.length, 0);
}));
test('post-review file changes invalidate the visible receipt and served artifact', async () => fixture(async root => {
  const engine = new VillageEngine({ root, provider: mockProvider() });
  const result = await completed(engine);
  await writeFile(join(root, result.id, 'index.html'), '<h1>Changed after review</h1>');
  const refreshed = await engine.get(result.id);
  assert.equal(refreshed.status, 'blocked');
  assert.equal(refreshed.artifact, null);
  assert.match(refreshed.events.at(-1).message, /changed after review/);
  await assert.rejects(engine.artifact(result.id, 'index.html'), /Artifact not found/);
}));
test('receipt binds HTML and CSS separately, including their file boundary', async () => fixture(async root => {
  const engine = new VillageEngine({ root, provider: mockProvider() });
  const result = await completed(engine);
  const html = await readFile(join(root, result.id, 'index.html'), 'utf8');
  const css = await readFile(join(root, result.id, 'styles.css'), 'utf8');
  const moved = html.slice(-1);
  const changedHtml = html.slice(0, -1);
  const changedCss = moved + css;
  assert.equal(changedHtml + changedCss, html + css);
  assert.notEqual(artifactDigest(changedHtml, changedCss), result.artifact.sha256);
  await writeFile(join(root, result.id, 'index.html'), changedHtml);
  await writeFile(join(root, result.id, 'styles.css'), changedCss);
  const refreshed = await engine.get(result.id);
  assert.equal(refreshed.status, 'blocked');
  assert.equal(refreshed.artifact, null);
  await assert.rejects(engine.artifact(result.id, 'styles.css'), /Artifact not found/);
}));
test('restored project ID and workspace directory must match', async () => fixture(async root => {
  const first = await new VillageEngine({ root, provider: mockProvider() }).create('Garden club website', 'request-12345');
  const file = join(root, first.id, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...state, id: '00000000-0000-0000-0000-000000000000' }));
  await assert.rejects(new VillageEngine({ root, provider: mockProvider() }).get(first.id), /Project state mismatch/);
  await rm(join(root, first.id), { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), 'village-outside-'));
  try {
    await symlink(outside, join(root, first.id));
    await assert.rejects(new VillageEngine({ root, provider: mockProvider() }).get(first.id), /Project not found/);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));
test('Maya plan exposes only validated fields and answer retries do not call provider again', async () => fixture(async root => {
  const values = [...sequence];
  values[1] = { ...values[1], unexpected: 'untrusted extra data' };
  const provider = mockProvider(values);
  const engine = new VillageEngine({ root, provider });
  const first = await engine.create('Garden club website', 'request-12345');
  const planned = await engine.answer(first.id, 'Neighbors', 'answer-12345');
  assert.equal(planned.plan.unexpected, undefined);
  assert.equal((await engine.answer(first.id, 'Neighbors', 'answer-12345')).status, 'ready');
  assert.equal(provider.calls.length, 2);
}));
test('rejected review remains visibly unapproved', async () => fixture(async root => {
  const provider = mockProvider([...sequence.slice(0, 3), { approved: false, summary: 'Missing the invitation.', findings: ['No signup instructions'] }]);
  const result = await completed(new VillageEngine({ root, provider }));
  assert.equal(result.status, 'changes_requested');
  assert.deepEqual(result.events.at(-1).findings, ['No signup instructions']);
}));
test('generated content is escaped and cannot insert executable markup', async () => fixture(async root => {
  const provider = mockProvider([...sequence.slice(0, 2), { ...validSite, sections: [{ ...validSite.sections[0], heading: '<script>alert(1)</script>' }, ...validSite.sections.slice(1)] }, sequence[3]]);
  const result = await completed(new VillageEngine({ root, provider }));
  const html = await readFile(join(root, result.id, 'index.html'), 'utf8');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
}));
test('cancelled build stays cancelled and does not write artifact', async () => fixture(async root => {
  let started;
  const gate = new Promise(resolve => { started = resolve; });
  const provider = mockProvider();
  const original = provider.generate.bind(provider);
  provider.generate = async args => { if (provider.calls.length === 2) { provider.calls.push(args); await gate; return { result: validSite, usage: {} }; } return original(args); };
  const engine = new VillageEngine({ root, provider });
  const first = await engine.create('Garden website', 'request-12345');
  await engine.answer(first.id, 'Neighbors', 'answer-12345');
  await engine.build(first.id, 'build-12345');
  await engine.cancel(first.id);
  started();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await engine.get(first.id)).status, 'cancelled');
  assert.equal((await engine.get(first.id)).artifact, null);
  assert.equal(provider.calls.length, 3);
}));
test('cancellation during Quinn review never records approval', async () => fixture(async root => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = mockProvider();
  const original = provider.generate.bind(provider);
  provider.generate = async args => { if (provider.calls.length === 3) { provider.calls.push(args); await gate; return { result: sequence[3], usage: {} }; } return original(args); };
  const engine = new VillageEngine({ root, provider });
  const first = await engine.create('Garden website', 'request-12345');
  await engine.answer(first.id, 'Neighbors', 'answer-12345');
  await engine.build(first.id, 'build-12345');
  for (let i = 0; i < 100 && (await engine.get(first.id)).status !== 'reviewing'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await engine.get(first.id)).status, 'reviewing');
  await engine.cancel(first.id);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  const result = await engine.get(first.id);
  assert.equal(result.status, 'cancelled');
  assert.ok(!result.events.some(event => event.type === 'review'));
}));
test('cancellation during the initial build save never starts Sam or restores building status', async () => fixture(async root => {
  const provider = mockProvider();
  const engine = new VillageEngine({ root, provider });
  const first = await engine.create('Garden website', 'request-12345');
  await engine.answer(first.id, 'Neighbors', 'answer-12345');
  let releaseSave, saveStarted;
  const gate = new Promise(resolve => { releaseSave = resolve; });
  const entered = new Promise(resolve => { saveStarted = resolve; });
  const originalSave = engine.save.bind(engine);
  engine.save = async project => {
    if (project.status === 'building') { saveStarted(); await gate; }
    return originalSave(project);
  };
  const building = engine.build(first.id, 'build-12345');
  await entered;
  await engine.cancel(first.id);
  releaseSave();
  assert.equal((await building).status, 'cancelled');
  assert.equal((await engine.get(first.id)).status, 'cancelled');
  assert.equal(JSON.parse(await readFile(join(root, first.id, 'state.json'), 'utf8')).status, 'cancelled');
  assert.equal(provider.calls.length, 2);
}));
test('cancellation during review-start save never invokes Quinn', async () => fixture(async root => {
  const provider = mockProvider();
  const engine = new VillageEngine({ root, provider });
  const first = await engine.create('Garden website', 'request-12345');
  await engine.answer(first.id, 'Neighbors', 'answer-12345');
  let releaseSave, saveStarted;
  const gate = new Promise(resolve => { releaseSave = resolve; });
  const entered = new Promise(resolve => { saveStarted = resolve; });
  const originalSave = engine.save.bind(engine);
  engine.save = async project => {
    if (project.status === 'reviewing') { saveStarted(); await gate; }
    return originalSave(project);
  };
  await engine.build(first.id, 'build-12345');
  await entered;
  await engine.cancel(first.id);
  releaseSave();
  for (let i = 0; i < 100 && engine.running.has(first.id); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const result = await engine.get(first.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(provider.calls.length, 3);
  assert.ok(!result.events.some(event => event.type === 'review'));
}));
test('local HTTP reports missing configuration and enforces host and origin', async () => {
  const server = createLocalServer({ providerError: 'Missing OPENAI_API_KEY on the server' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.ready, false);
    assert.match(status.error, /OPENAI_API_KEY/);
    const home = await fetch(base);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await home.text(), /Who’s at their desk/);
    assert.equal((await fetch(`${base}/office-assets/styles.css`)).status, 200);
    assert.equal((await fetch(`${base}/office.js`)).status, 200);
    assert.match(await (await fetch(`${base}/setup`)).text(), /Your first office and project/);
    const denied = await fetch(`${base}/api/projects`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const config = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(config.status, 503);
  } finally { server.close(); }
});
test('first-run office name is saved locally without provider credentials', async () => fixture(async root => {
  const server = createLocalServer({ providerError: 'Missing OPENAI_API_KEY on the server', setupRoot: root, officeName: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (name, origin = base) => fetch(`${base}/api/setup`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  try {
    assert.equal((await (await fetch(`${base}/api/status`)).json()).officeName, '');
    assert.equal((await post('Wrong', 'https://example.com')).status, 403);
    assert.equal((await post('<script>')).status, 400);
    assert.equal((await post('Maple Village')).status, 200);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.officeName, 'Maple Village');
    assert.equal(status.ready, false);
    assert.equal(JSON.parse(await readFile(join(root, 'office-setup.json'), 'utf8')).name, 'Maple Village');
    assert.equal((await readFile(join(root, 'office-setup.json'), 'utf8')).includes('API_KEY'), false);
  } finally { server.close(); }
}));
test('invalid fixed office name does not block local first-run naming', async () => fixture(async root => {
  const server = createLocalServer({ providerError: 'Missing OPENAI_API_KEY on the server', setupRoot: root, officeName: 'x'.repeat(61) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.officeName, '');
    assert.equal(status.officeNameEditable, true);
    assert.equal((await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'My Village' }) })).status, 200);
  } finally { server.close(); }
}));
test('local connection status is read-only and available before a provider key', async () => fixture(async root => {
  let inspected = 0;
  const server = createLocalServer({ providerError: 'Missing OPENAI_API_KEY on the server', setupRoot: root,
    connectionInspector: async () => { inspected++; return { github: { state: 'connected', account: 'learner' }, vercel: { state: 'unavailable' } }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await (await fetch(`${base}/api/connections`)).json();
    assert.deepEqual(result, { github: { state: 'connected', account: 'learner' }, vercel: { state: 'unavailable' } });
    assert.equal(inspected, 1);
    assert.equal((await fetch(`${base}/api/connections`, { method: 'POST' })).status, 405);
    assert.equal(inspected, 1);
  } finally { server.close(); }
}));
test('local HTTP completes the mock project and serves only approved artifact paths', async () => fixture(async root => {
  const engine = new VillageEngine({ root, provider: mockProvider() });
  const server = createLocalServer({ provider: { name: 'mock', model: 'deterministic' }, engine });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, data) => await (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })).json();
  try {
    const first = await post('/api/projects', { goal: 'Garden club website', requestId: 'request-12345' });
    assert.equal(first.status, 'needs_answer');
    const planned = await post(`/api/projects/${first.id}/answer`, { answer: 'Neighbors', requestId: 'answer-12345' });
    assert.equal(planned.status, 'ready');
    await post(`/api/projects/${first.id}/build`, { requestId: 'build-12345' });
    let finished;
    for (let i = 0; i < 100; i++) { finished = await (await fetch(`${base}/api/projects/${first.id}`)).json(); if (finished.status === 'reviewed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(finished.status, 'reviewed');
    const artifact = await fetch(base + finished.artifact.url);
    assert.equal(artifact.status, 200);
    assert.match(artifact.headers.get('content-security-policy'), /script-src 'none'/);
    assert.match(await artifact.text(), /Grow together/);
    const prepared = await post(`/api/projects/${first.id}/export`, {});
    assert.equal(prepared.sha256, finished.artifact.sha256);
    assert.match(prepared.path, /\/site$/);
    assert.equal((await fetch(`${base}/artifact/${first.id}/state.json`)).status, 404);
  } finally { server.close(); }
}));
