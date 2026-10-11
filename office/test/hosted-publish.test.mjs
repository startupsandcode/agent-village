import test from 'node:test';
import assert from 'node:assert/strict';
import { renderArtifact } from '../lib/static-site.mjs';
import { createHostedPublisher } from '../lib/hosted-publish.mjs';
import { createHostedMayaHandler } from '../api/maya-projects.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const site = renderArtifact({ title: 'Garden Club', theme: 'forest', sections: [
  { type: 'hero', heading: 'Grow together', body: 'A garden club for neighbors.', actionText: 'Explore' },
  { type: 'text', heading: 'Join us', body: 'Meet your neighbors and learn to grow vegetables.' },
] });
const env = { OFFICE_ALLOWED_ORIGINS: 'https://office.example', OFFICE_RUN_ALLOWED_EMAILS: 'owner@example.com',
  VILLAGE_PUBLISH_GITHUB_TOKEN: 'mock-github-token', VILLAGE_PUBLISH_GITHUB_OWNER: 'alice',
  VILLAGE_PUBLISH_GITHUB_REPO: 'smoke-site', VILLAGE_PUBLISH_GITHUB_BRANCH: 'village-publish',
  VILLAGE_PUBLISH_GITHUB_DEDICATED_REPO_CONFIRMED: 'true',
  VILLAGE_PUBLISH_VERCEL_TOKEN: 'mock-vercel-token', VILLAGE_PUBLISH_VERCEL_TEAM: 'small-team',
  VILLAGE_PUBLISH_VERCEL_PROJECT: 'smoke-site' };
const auth = { authorize: cookie => cookie === 'owner' ? { status: 200, sub: 'owner-sub', email: 'owner@example.com' }
  : cookie === 'other' ? { status: 200, sub: 'other-sub', email: 'owner@example.com' }
    : cookie === 'viewer' ? { status: 200, sub: 'viewer-sub', email: 'viewer@example.com' } : { status: 401 } };

function fixture({ status = 'reviewed' } = {}) {
  let version = 0;
  let snapshot = { id, status, artifact: { sha256: site.sha256 }, files: { html: site.html, css: site.css },
    events: [{ agent: 'Quinn', type: 'review', reviewedSha256: site.sha256, message: 'Reviewed exact files' }] };
  const access = {
    async read(cookie, projectId) { return cookie === 'owner' && projectId === id ? { id, version, snapshot: structuredClone(snapshot) } : null; },
    async update(cookie, { id: projectId, expectedVersion, snapshot: next }) {
      if (cookie !== 'owner' || projectId !== id || version !== expectedVersion) return null;
      snapshot = structuredClone(next); version++; return { id, version, snapshot: structuredClone(snapshot) };
    },
  };
  return { access, read: () => structuredClone(snapshot), change: update => { snapshot = update(snapshot); version++; } };
}
function response() { return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } }; }
async function call(handler, cookie, body, origin = 'https://office.example') {
  const result = response();
  await handler({ method: 'POST', url: '/api/maya-projects', body, headers: { host: 'office.example', origin,
    cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }, result);
  return { status: result.statusCode, value: JSON.parse(result.body) };
}

test('hosted publish is owner scoped, same origin, exact reviewed receipt, and server-bound to its target', async () => {
  const { access, read } = fixture();
  const calls = [];
  const publisher = createHostedPublisher({ access, env, githubPublisher: async args => {
    calls.push(args); return { repository: 'alice/smoke-site', branch: 'village-publish', commitSha: 'a'.repeat(40),
      artifactSha256: site.sha256, url: 'https://github.com/alice/smoke-site/tree/village-publish' };
  } });
  const handler = createHostedMayaHandler({ env, auth, publisher, coordinator: {}, enabled: true });
  const body = { action: 'publishGithub', id, artifactSha256: site.sha256 };
  assert.equal((await call(handler, 'viewer', body)).status, 403);
  assert.equal((await call(handler, 'other', body)).status, 404);
  assert.equal((await call(handler, 'owner', body, 'https://other.example')).status, 403);
  assert.equal((await call(handler, 'owner', { ...body, owner: 'attacker' })).status, 400);
  assert.equal((await call(handler, 'owner', { ...body, artifactSha256: 'b'.repeat(64) })).status, 400);
  assert.equal(calls.length, 0);
  const first = await call(handler, 'owner', body);
  assert.equal(first.status, 200);
  assert.equal(first.value.receipt.commitSha, 'a'.repeat(40));
  assert.equal(calls[0].owner, 'alice');
  assert.equal(calls[0].repo, 'smoke-site');
  assert.equal(calls[0].token, 'mock-github-token');
  assert.equal(calls[0].snapshot.sha256, site.sha256);
  assert.equal((await call(handler, 'owner', body)).value.receipt.commitSha, 'a'.repeat(40));
  assert.equal(calls.length, 1);
  assert.equal(read().events.at(-1).type, 'publish');
  const status = await call(handler, 'owner', { action: 'publishStatus', id });
  assert.equal(status.value.targets.github.owner, 'alice');
  assert.ok(!JSON.stringify(status.value).includes('mock-github-token'));
});

test('hosted duplicate in flight or interrupted submission cannot create a second external write', async () => {
  const { access, read } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const publisher = createHostedPublisher({ access, env, vercelPublisher: async () => { calls++; started(); await gate;
    return { team: 'small-team', project: 'smoke-site', projectId: 'prj_abcdef', deploymentId: 'dpl_abcdef',
      url: 'https://smoke-site.vercel.app', state: 'QUEUED', artifactSha256: site.sha256 }; } });
  const first = publisher.publish('owner', id, 'vercel', site.sha256);
  await entered;
  const repeated = await publisher.publish('owner', id, 'vercel', site.sha256);
  assert.equal(repeated.status, 'submitting');
  assert.equal(calls, 1);
  assert.equal(read().events.filter(event => event.type === 'publish').length, 0);
  release();
  assert.equal((await first).status, 'submitted');
  assert.equal((await publisher.publish('owner', id, 'vercel', site.sha256)).status, 'submitted');
  assert.equal(calls, 1);
  assert.equal(read().events.filter(event => event.type === 'publish').length, 1);
});

test('hosted missing configuration and changed reviewed bytes fail before external write', async () => {
  const { access, change } = fixture();
  let calls = 0;
  const publisher = createHostedPublisher({ access, env: { ...env, VILLAGE_PUBLISH_GITHUB_TOKEN: '' }, githubPublisher: async () => { calls++; } });
  await assert.rejects(publisher.publish('owner', id, 'github', site.sha256), /not configured/);
  change(project => ({ ...project, files: { ...project.files, html: project.files.html + 'changed' } }));
  await assert.rejects(publisher.publish('owner', id, 'vercel', site.sha256), /Reviewed artifact receipt required/);
  assert.equal(calls, 0);
});
