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
import { readDomainProfile, saveDomainProfile } from '../domain.mjs';
import { UnsafeVercelDeploymentError } from '../publish-vercel.mjs';
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
test('both providers reject oversized input before any billable request', async () => {
  let calls = 0;
  for (const [name, key] of [['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY']]) {
    const provider = createProvider({ name, env: { [key]: 'fake' }, fetchImpl: async () => { calls++; throw new Error('Unexpected request'); } });
    await assert.rejects(provider.generate({ system: 'system', input: 'x'.repeat(32_768) }), /input exceeds project limit/);
  }
  assert.equal(calls, 0);
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
test('domain interview is saved locally, snapshotted, and shared with all three roles', async () => fixture(async root => {
  const profile = { audience: 'Local gardeners', expertise: 'Native plants', rules: 'Use plain language' };
  await saveDomainProfile(root, profile);
  assert.deepEqual(await readDomainProfile(root), profile);
  const provider = mockProvider();
  const engine = new VillageEngine({ root, provider });
  const result = await completed(engine);
  assert.deepEqual(result.domainProfile, profile);
  assert.match(result.events.find(event => event.type === 'context').message, /domain answers attached/);
  for (const call of provider.calls) assert.deepEqual(JSON.parse(call.input).domainProfile, profile);
  await saveDomainProfile(root, { ...profile, expertise: 'Changed after project' });
  assert.deepEqual((await engine.get(result.id)).domainProfile, profile);
  await assert.rejects(saveDomainProfile(root, { ...profile, audience: 'x'.repeat(501) }), /500 characters/);
  await saveDomainProfile(root, { audience: '庭'.repeat(500), expertise: '庭'.repeat(500), rules: '庭'.repeat(500) });
  assert.equal((await readDomainProfile(root)).audience.length, 500);
}));
test('domain profile containing the active key is blocked before any provider call', async () => fixture(async root => {
  await saveDomainProfile(root, { audience: 'private-key', expertise: '', rules: '' });
  const provider = mockProvider();
  provider.containsSecret = value => String(value).includes('private-key');
  const engine = new VillageEngine({ root, provider });
  await assert.rejects(engine.create('Garden site', 'domain-secret-123'), /Do not put an API key in domain answers/);
  assert.equal(provider.calls.length, 0);
  const server = createLocalServer({ provider, setupRoot: root, engine });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/domain`);
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes('private-key'));
  } finally { server.close(); }
}));
test('local publishing routes require reviewed files, same origin and server tokens; Preview retries reuse the receipt', async () => fixture(async root => {
  const engine = new VillageEngine({ root, provider: mockProvider() });
  const completedProject = await completed(engine);
  let githubCalls = 0, vercelCalls = 0;
  const githubPublisher = async args => { githubCalls++; assert.equal(args.token, 'fake-github-token'); return {
    repository: 'learner/site', branch: 'village-publish', commitSha: 'a'.repeat(40), artifactSha256: completedProject.artifact.sha256,
    url: 'https://github.com/learner/site/tree/village-publish', idempotent: false,
  }; };
  const vercelPublisher = async args => {
    vercelCalls++;
    assert.equal(args.token, 'fake-vercel-token');
    await args.onBeforeSubmit({ team: args.team, project: args.project, projectId: 'prj_test1234', artifactSha256: completedProject.artifact.sha256 });
    return { team: args.team, project: args.project, projectId: 'prj_test1234', deploymentId: 'dpl_test1234', url: 'https://site-test.vercel.app', state: 'QUEUED', artifactSha256: completedProject.artifact.sha256 };
  };
  const server = createLocalServer({ engine, setupRoot: root, env: { VILLAGE_PUBLISH_GITHUB_TOKEN: 'fake-github-token', VILLAGE_PUBLISH_VERCEL_TOKEN: 'fake-vercel-token' }, githubPublisher, vercelPublisher,
    deploymentInspector: async ({ receipt }) => ({ ...receipt, state: 'READY' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (service, payload, origin = base) => fetch(`${base}/api/projects/${completedProject.id}/publish/${service}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    assert.equal((await post('github', { owner: 'learner', repo: 'site', branch: 'village-publish' }, 'https://wrong.example')).status, 403);
    assert.equal(githubCalls, 0);
    assert.equal((await post('github', { owner: 'learner', repo: 'site', branch: 'village-publish' })).status, 200);
    assert.equal(githubCalls, 1);
    assert.equal((await post('vercel', { team: 'learner-team', project: 'site' })).status, 200);
    assert.equal((await post('vercel', { team: 'learner-team', project: 'site' })).status, 200);
    assert.equal(vercelCalls, 1);
    const status = await (await fetch(`${base}/api/projects/${completedProject.id}/publish`)).json();
    assert.equal(status.preview.state, 'READY');
    assert.equal((await engine.get(completedProject.id)).events.filter(event => event.type === 'publish').length, 2);
  } finally { server.close(); }
}));

test('local unsafe Vercel response retains known ID and target without enabling a retry', async () => fixture(async root => {
  const engine = new VillageEngine({ root, provider: mockProvider() });
  const completedProject = await completed(engine);
  let calls = 0;
  const server = createLocalServer({ engine, setupRoot: root, env: { VILLAGE_PUBLISH_VERCEL_TOKEN: 'fake-vercel-token' },
    vercelPublisher: async args => {
      calls++;
      await args.onBeforeSubmit({ team: args.team, project: args.project, projectId: 'prj_test1234', artifactSha256: completedProject.artifact.sha256 });
      throw new UnsafeVercelDeploymentError({ team: args.team, project: args.project, projectId: 'prj_test1234',
        deploymentId: 'dpl_unsafe1234', target: 'production', state: 'READY', url: 'https://site-unsafe.vercel.app',
        artifactSha256: completedProject.artifact.sha256 });
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${base}/api/projects/${completedProject.id}/publish/vercel`, { method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ team: 'team', project: 'site' }) });
  try {
    const first = await post();
    assert.equal(first.status, 409);
    const firstBody = await first.json();
    assert.equal(firstBody.preview.deploymentId, 'dpl_unsafe1234');
    assert.equal(firstBody.preview.target, 'production');
    assert.equal(firstBody.preview.status, 'needs_inspection');
    const readBack = await (await fetch(`${base}/api/projects/${completedProject.id}/publish`)).json();
    assert.deepEqual(readBack.preview, firstBody.preview);
    assert.equal((await post()).status, 409);
    assert.equal(calls, 1);
    assert.equal((await engine.get(completedProject.id)).events.some(event => event.type === 'publish'), false);
    assert.ok(!JSON.stringify(readBack).includes('fake-vercel-token'));
  } finally { server.close(); }
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
test('one Quinn rejection allows one bounded Sam revision and re-review of the replacement receipt', async () => fixture(async root => {
  const revisedSite = { ...validSite, sections: [...validSite.sections, { type: 'text', heading: 'How to join', body: 'Use the signup form to join.' }] };
  const provider = mockProvider([...sequence.slice(0, 3), { approved: false, summary: 'Add signup instructions.', findings: ['No signup instructions'] }, revisedSite,
    { approved: true, summary: 'Signup instructions now address the finding.', findings: [] }]);
  const engine = new VillageEngine({ root, provider });
  const rejected = await completed(engine);
  const oldSha = rejected.artifact.sha256;
  assert.equal(rejected.status, 'changes_requested');
  assert.equal(rejected.revisionAvailable, true);

  const revising = await engine.revise(rejected.id, 'revise-review-123');
  assert.equal(revising.status, 'revising');
  assert.equal((await engine.revise(rejected.id, 'revise-review-123')).status, 'revising');
  await engine.running.get(rejected.id).promise;
  const awaitingReview = await engine.get(rejected.id);
  assert.equal(awaitingReview.status, 'awaiting_review');
  assert.notEqual(awaitingReview.artifact.sha256, oldSha);
  assert.equal(awaitingReview.revisionAvailable, false);
  assert.equal((await engine.artifact(rejected.id, 'index.html')).toString('utf8'), await readFile(join(root, rejected.id, 'revisions', awaitingReview.artifact.revisionId, 'index.html'), 'utf8'));
  const revisionInput = JSON.parse(provider.calls[4].input);
  assert.equal(revisionInput.reviewSummary, 'Add signup instructions.');
  assert.deepEqual(revisionInput.findings, ['No signup instructions']);
  assert.match(revisionInput.currentHtml, /Grow together/);
  assert.equal(provider.calls.length, 5);

  const approved = await engine.review(rejected.id, 'review-revision-123');
  assert.equal(approved.status, 'reviewed');
  assert.equal(approved.events.at(-1).reviewedSha256, approved.artifact.sha256);
  assert.equal(provider.calls.length, 6);
  assert.equal((await engine.review(rejected.id, 'review-revision-123')).status, 'reviewed');
  await assert.rejects(engine.revise(rejected.id, 'revise-again-123'), /Action not expected/);
  assert.equal(provider.calls.length, 6);
}));
test('failed Sam revision preserves the rejected receipt and permits one recovery attempt', async () => fixture(async root => {
  const revisedSite = { ...validSite, sections: [...validSite.sections, { type: 'text', heading: 'Join us', body: 'Sign up today.' }] };
  const provider = mockProvider([...sequence.slice(0, 3), { approved: false, summary: 'Add signup instructions.', findings: ['No signup instructions'] }, revisedSite,
    { approved: true, summary: 'The finding is resolved.', findings: [] }]);
  const originalGenerate = provider.generate.bind(provider);
  let failNextRevision = true;
  provider.generate = async args => {
    if (provider.calls.length === 4) {
      if (failNextRevision) { failNextRevision = false; throw new Error('Temporary provider failure'); }
    }
    return originalGenerate(args);
  };
  const engine = new VillageEngine({ root, provider });
  const rejected = await completed(engine);
  const originalSha = rejected.artifact.sha256;
  await engine.revise(rejected.id, 'revise-failed-123');
  await engine.running.get(rejected.id).promise;
  const afterFailure = await engine.get(rejected.id);
  assert.equal(afterFailure.status, 'changes_requested');
  assert.equal(afterFailure.artifact.sha256, originalSha);
  assert.equal(afterFailure.revisionAvailable, true);
  assert.equal((await engine.revise(rejected.id, 'revise-failed-123')).revisionAvailable, true);
  assert.equal(provider.calls.length, 4);
  await engine.revise(rejected.id, 'revise-recovery-123');
  await engine.running.get(rejected.id).promise;
  assert.equal((await engine.get(rejected.id)).status, 'awaiting_review');
  assert.equal((await engine.review(rejected.id, 'review-recovery-123')).status, 'reviewed');
  assert.equal(provider.calls.length, 6);
}));
test('cancelling a revision review never records Quinn approval after the request returns', async () => fixture(async root => {
  const revisedSite = { ...validSite, sections: [...validSite.sections, { type: 'text', heading: 'Join us', body: 'Sign up today.' }] };
  const provider = mockProvider([...sequence.slice(0, 3), { approved: false, summary: 'Add signup instructions.', findings: ['No signup instructions'] }, revisedSite,
    { approved: true, summary: 'Finding resolved.', findings: [] }]);
  const originalGenerate = provider.generate.bind(provider);
  let startReview; let releaseReview;
  const reviewStarted = new Promise(resolve => { startReview = resolve; });
  const reviewGate = new Promise(resolve => { releaseReview = resolve; });
  provider.generate = async args => {
    if (provider.calls.length === 5) { startReview(); await reviewGate; }
    return originalGenerate(args);
  };
  const engine = new VillageEngine({ root, provider });
  const rejected = await completed(engine);
  await engine.revise(rejected.id, 'revise-cancel-123');
  await engine.running.get(rejected.id).promise;
  const sha = (await engine.get(rejected.id)).artifact.sha256;
  const reviewing = engine.review(rejected.id, 'review-cancel-123');
  await reviewStarted;
  assert.equal((await engine.cancel(rejected.id)).status, 'cancelled');
  releaseReview();
  assert.equal((await reviewing).status, 'cancelled');
  const current = await engine.get(rejected.id);
  assert.equal(current.status, 'cancelled');
  assert.equal(current.artifact.sha256, sha);
  assert.equal(current.events.some(event => event.agent === 'Quinn' && event.type === 'review' && event.reviewedSha256 === sha), false);
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
  assert.equal((await engine.get(first.id)).events.find(event => event.callId === 'build:build-12345')?.state, 'unreported');
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
  assert.equal(result.events.find(event => event.callId === 'review:build-12345')?.state, 'unreported');
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
  const root = await mkdtemp(join(tmpdir(), 'village-http-'));
  const server = createLocalServer({ providerError: 'Missing OPENAI_API_KEY on the server', setupRoot: root });
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
    const setup = await fetch(`${base}/setup`);
    assert.match(setup.headers.get('content-type'), /^text\/html/);
    assert.match(await setup.text(), /Start on your computer/);
    assert.match(await (await fetch(`${base}/setup.css`)).text(), /\.setup-shell/);
    assert.deepEqual(await (await fetch(`${base}/api/domain`)).json(), { audience: '', expertise: '', rules: '' });
    assert.equal((await fetch(`${base}/api/domain`, { method: 'POST', headers: { origin: 'https://wrong.example', 'content-type': 'application/json' }, body: JSON.stringify({ audience: 'Gardeners', expertise: '', rules: '' }) })).status, 403);
    const savedDomain = await fetch(`${base}/api/domain`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ audience: 'Gardeners', expertise: 'Native plants', rules: 'Plain language' }) });
    assert.equal(savedDomain.status, 200);
    assert.equal((await savedDomain.json()).expertise, 'Native plants');
    const denied = await fetch(`${base}/api/projects`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const config = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(config.status, 503);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
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
test('local connection check requires same-origin POST and bounds repeated CLI probes', async () => fixture(async root => {
  let inspected = 0;
  const server = createLocalServer({ providerError: 'Missing OPENAI_API_KEY on the server', setupRoot: root,
    connectionInspector: async () => { inspected++; await new Promise(resolve => setTimeout(resolve, 20)); return { github: { state: 'connected', account: 'learner' }, vercel: { state: 'unavailable' } }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const check = (headers = {}) => fetch(`${base}/api/connections`, { method: 'POST', headers: { origin: base, ...headers } });
  try {
    assert.equal((await fetch(`${base}/api/connections`)).status, 405);
    assert.equal((await check({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await check({ 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await fetch(`${base}/api/connections`, { method: 'POST' })).status, 403);
    assert.equal(inspected, 0);
    const [first, second] = await Promise.all([check(), check()]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const result = await first.json();
    assert.deepEqual(result, { github: { state: 'connected', account: 'learner' }, vercel: { state: 'unavailable' } });
    assert.equal(inspected, 1);
    assert.equal((await check()).status, 200);
    assert.equal(inspected, 1);
  } finally { server.close(); }
}));
test('failed connection probes are also rate bounded', async () => fixture(async root => {
  let inspected = 0;
  const server = createLocalServer({ providerError: 'Missing key', setupRoot: root,
    connectionInspector: async () => { inspected++; throw new Error('CLI failed'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${base}/api/connections`, { method: 'POST', headers: { origin: base } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { github: { state: 'unavailable' }, vercel: { state: 'unavailable' } });
    }
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
    assert.match(prepared.path.replaceAll('\\', '/'), /\/site$/);
    assert.equal((await fetch(`${base}/artifact/${first.id}/state.json`)).status, 404);
  } finally { server.close(); }
}));
