import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishReviewedSite } from '../publish-github.mjs';
import { artifactDigest } from '../artifact.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const sha = value => value.repeat(40);
const blobSha = content => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
const html = '<!doctype html><html lang="en"><title>Example</title><link rel="stylesheet" href="styles.css"><h1>Example</h1></html>';
const css = 'body { color: #123456; background: #ffffff; font-family: system-ui; padding: 3rem; line-height: 1.5; }';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'village-github-'));
  const artifactSha = artifactDigest(html, css);
  const engine = {
    get: async () => ({ status: 'reviewed', artifact: { sha256: artifactSha } }),
    checkedWorkspace: async () => root,
    artifact: async (_id, name) => name === 'index.html' ? html : css,
  };
  try { await fn({ engine, root, artifactSha }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function githubMock({ privateRepo = true, defaultBranch = 'main', protectedBranch = false, hasPages = false, entries = [{ path: 'notes.txt', mode: '100644', type: 'blob', sha: sha('a') }], pause, failPatch = false, wrongRef = false } = {}) {
  const calls = [];
  let tree = entries;
  let head = sha('1');
  const fetchImpl = async (url, options) => {
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/alice\/site(?:\/|$)/);
    assert.equal(options.headers.Authorization, 'Bearer test-only-token');
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    const path = new URL(url).pathname;
    let status = 200;
    let data;
    if (path === '/repos/alice/site') data = { full_name: 'alice/site', owner: { login: 'alice' }, private: privateRepo, has_pages: hasPages, default_branch: defaultBranch, permissions: { push: true } };
    else if (path.endsWith('/branches/village-publish')) data = { name: 'village-publish', protected: protectedBranch, commit: { sha: head } };
    else if (path.includes('/git/commits/') && options.method === 'GET') data = { tree: { sha: sha('2') } };
    else if (path.endsWith('/git/trees/' + sha('2'))) data = { tree, truncated: false };
    else if (path.endsWith('/git/blobs')) { status = 201; data = { sha: blobSha(Buffer.from(JSON.parse(options.body).content, 'base64')) }; }
    else if (path.endsWith('/git/trees')) { status = 201; data = { sha: sha('3') }; }
    else if (path.endsWith('/git/commits')) { status = 201; data = { sha: sha('4') }; }
    else if (path.endsWith('/git/refs/heads/village-publish')) {
      if (pause) await pause();
      if (failPatch) return new Response(JSON.stringify({ message: 'secret token should not be repeated' }), { status: 422 });
      tree = [...tree, ...calls.findLast(call => call.url.endsWith('/git/trees') && call.method === 'POST').body.tree];
      head = sha('4');
      data = { ref: 'refs/heads/village-publish', object: { sha: wrongRef ? sha('5') : head } };
    } else assert.fail(`Unexpected GitHub route: ${path}`);
    return new Response(JSON.stringify(data), { status });
  };
  return { fetchImpl, calls, getTree: () => tree };
}

const args = (engine, fetchImpl, overrides = {}) => ({ engine, id, owner: 'alice', repo: 'site', branch: 'village-publish', token: 'test-only-token', fetchImpl, ...overrides });
const hostedArgs = (fetchImpl, snapshot, overrides = {}) => ({ snapshot, owner: 'alice', repo: 'site', branch: 'village-publish', token: 'test-only-token', fetchImpl, ...overrides });

test('publishes only reviewed delivery files to existing private non-default branch, preserving unrelated files', async () => fixture(async ({ engine, artifactSha }) => {
  const mock = githubMock();
  const result = await publishReviewedSite(args(engine, mock.fetchImpl));
  assert.equal(result.artifactSha256, artifactSha);
  assert.equal(result.idempotent, false);
  assert.equal(result.commitSha, sha('4'));
  assert.equal(result.url, 'https://github.com/alice/site/tree/village-publish');
  const treeCreate = mock.calls.find(call => call.url.endsWith('/git/trees') && call.method === 'POST');
  assert.equal(treeCreate.body.base_tree, sha('2'));
  assert.deepEqual(treeCreate.body.tree.map(item => item.path).sort(), ['.vercelignore', 'README.md', 'index.html', 'package.json', 'styles.css', 'verify.test.mjs']);
  assert.equal(mock.getTree()[0].path, 'notes.txt');
  assert.deepEqual(mock.calls.at(-1).body, { sha: sha('4'), force: false });
  assert.ok(mock.calls.every(call => !JSON.stringify(call.body ?? '').includes('test-only-token')));
}));

test('retry after successful publish returns existing commit without another write', async () => fixture(async ({ engine }) => {
  const mock = githubMock();
  await publishReviewedSite(args(engine, mock.fetchImpl));
  const before = mock.calls.length;
  const result = await publishReviewedSite(args(engine, mock.fetchImpl));
  assert.equal(result.idempotent, true);
  assert.equal(result.commitSha, sha('4'));
  assert.ok(mock.calls.slice(before).every(call => call.method === 'GET'));
}));

test('rejects public, default, protected, and colliding targets before writing', async () => fixture(async ({ engine }) => {
  for (const [options, pattern] of [
    [{ privateRepo: false }, /private repository/],
    [{ defaultBranch: 'village-publish' }, /non-default branch/],
    [{ protectedBranch: true }, /unprotected/],
    [{ hasPages: true }, /private repository/],
    [{ entries: [{ path: 'index.html', type: 'blob', mode: '100644', sha: sha('a') }] }, /already contains delivery files/],
    [{ entries: [{ path: '.github', type: 'tree', mode: '040000', sha: sha('a') }] }, /automation configuration/],
  ]) {
    const mock = githubMock(options);
    await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl)), pattern);
    assert.ok(mock.calls.every(call => call.method === 'GET'));
  }
}));

test('rejects missing credential and invalid target without any network call', async () => fixture(async ({ engine }) => {
  const mock = githubMock();
  await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl, { token: '' })), /credential is missing/);
  await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl, { branch: '../main' })), /Invalid GitHub branch/);
  await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl, { owner: 'evil/path' })), /Invalid GitHub owner/);
  assert.equal(mock.calls.length, 0);
}));

test('duplicate in-flight request is rejected and failed ref update does not claim publication', async () => fixture(async ({ engine }) => {
  let release;
  let reached;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const mock = githubMock({ pause: async () => { reached(); await gate; }, failPatch: true });
  const first = publishReviewedSite(args(engine, mock.fetchImpl));
  await entered;
  await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl)), /already in progress/);
  release();
  await assert.rejects(first, error => error.message === 'GitHub request failed (422); check repository access, branch, or conflict');
  assert.ok(mock.calls.filter(call => call.method === 'PATCH').length === 1);
}));

test('a mismatched GitHub ref response does not claim publication', async () => fixture(async ({ engine }) => {
  const mock = githubMock({ wrongRef: true });
  await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl)), /ref receipt did not match/);
}));

test('unreviewed artifact is never sent to GitHub', async () => fixture(async ({ engine }) => {
  engine.get = async () => ({ status: 'changes_requested', artifact: null });
  const mock = githubMock();
  await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl)), /Only a reviewed project/);
  assert.equal(mock.calls.length, 0);
}));

test('an already cancelled request makes no GitHub calls', async () => fixture(async ({ engine }) => {
  const mock = githubMock();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl, { signal: controller.signal })), /Publishing cancelled/);
  assert.equal(mock.calls.length, 0);
}));

test('a file edited after export validation cannot be published with the reviewed receipt', async () => {
  for (const name of ['index.html', 'README.md']) {
    await fixture(async ({ engine, root, artifactSha }) => {
      let reads = 0;
      engine.get = async () => {
        reads++;
        if (reads === 2) await writeFile(join(root, 'site', name), 'unreviewed replacement');
        return { status: 'reviewed', artifact: { sha256: artifactSha } };
      };
      const mock = githubMock();
      await assert.rejects(publishReviewedSite(args(engine, mock.fetchImpl)), /Prepared project changed/);
      assert.equal(mock.calls.length, 0);
    });
  }
});

test('a later workspace edit cannot change the captured bytes sent to GitHub', async () => fixture(async ({ engine, root, artifactSha }) => {
  const mock = githubMock();
  let edited = false;
  const fetchImpl = async (url, options) => {
    if (!edited) {
      edited = true;
      await writeFile(join(root, 'site', 'index.html'), 'changed after snapshot');
    }
    return mock.fetchImpl(url, options);
  };
  const result = await publishReviewedSite(args(engine, fetchImpl));
  assert.equal(result.artifactSha256, artifactSha);
  const indexBlob = mock.calls.find(call => call.url.endsWith('/git/blobs') && Buffer.from(call.body.content, 'base64').toString() === html);
  assert.ok(indexBlob, 'reviewed HTML snapshot was uploaded');
  assert.ok(mock.calls.filter(call => call.url.endsWith('/git/blobs')).every(call => !Buffer.from(call.body.content, 'base64').toString().includes('changed after snapshot')));
}));

test('hosted reviewed snapshot publishes the exact canonical six files without filesystem access', async () => {
  const mock = githubMock();
  const reviewed = artifactDigest(html, css);
  const result = await publishReviewedSite(hostedArgs(mock.fetchImpl, { html, css, sha256: reviewed }));
  assert.equal(result.artifactSha256, reviewed);
  const blobBodies = mock.calls.filter(call => call.url.endsWith('/git/blobs')).map(call => Buffer.from(call.body.content, 'base64').toString());
  assert.equal(blobBodies.length, 6);
  assert.ok(blobBodies.includes(html));
  assert.ok(blobBodies.includes(css));
  assert.ok(blobBodies.some(body => body.includes(`Receipt: SHA-256 ${reviewed}`)));
  assert.ok(blobBodies.some(body => body.includes("'index.html', 'package.json', 'styles.css'")));
  assert.ok(blobBodies.includes('.git\n.vercel\n'));
  assert.ok(blobBodies.some(body => body.startsWith('{') && JSON.parse(body).scripts?.test === 'node --test verify.test.mjs'));
  assert.deepEqual(mock.getTree().slice(1).map(item => item.path).sort(), ['.vercelignore', 'README.md', 'index.html', 'package.json', 'styles.css', 'verify.test.mjs']);
});

test('hosted digest mismatch and ambiguous source make no GitHub calls', async () => {
  const mock = githubMock();
  const reviewed = artifactDigest(html, css);
  await assert.rejects(publishReviewedSite(hostedArgs(mock.fetchImpl, { html: `${html}changed`, css, sha256: reviewed })), /Reviewed files changed/);
  await assert.rejects(publishReviewedSite(hostedArgs(mock.fetchImpl, { html, css, sha256: reviewed }, { id })), /Choose one reviewed project source/);
  assert.equal(mock.calls.length, 0);
});
