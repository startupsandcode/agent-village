import test from 'node:test';
import assert from 'node:assert/strict';
import { createMayaStatusHandler } from '../api/maya-status.mjs';
import { createOfficeHandler } from '../api/office.mjs';

function response() {
  return { statusCode: 0, headers: {}, body: null, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
}
test('hosted Maya status denies anonymous access and never returns a configured secret', () => {
  const secret = 'secret-never-returned';
  const handler = createMayaStatusHandler({ env: { VILLAGE_PROVIDER: 'openai', OPENAI_API_KEY: secret }, auth: { authorize: cookie => ({ status: cookie === 'valid' ? 200 : 401, email: 'viewer@example.com' }) } });
  const anonymous = response(); handler({ method: 'GET', headers: {} }, anonymous);
  assert.equal(anonymous.statusCode, 401);
  const invited = response(); handler({ method: 'GET', headers: { cookie: 'valid' } }, invited);
  assert.equal(invited.statusCode, 200);
  assert.deepEqual(JSON.parse(invited.body), { provider: 'openai', providerKeyPresent: true, officeName: '', viewerEmail: 'viewer@example.com', operatorAllowlistPresent: false, runAvailable: false, reason: 'Hosted runs need private project storage, operator permission, a server-side provider key, and explicit activation. The local office can run now.', setup: {
    viewerSignIn: 'connected', runPermission: 'not_authorized', provider: 'key_present_unverified', durableProjects: 'not_connected', isolatedExecutor: 'not_required_for_static_sites', githubPublishing: 'not_connected', vercelPublishing: 'not_connected',
  } });
  assert.ok(!invited.body.includes(secret));
  const head = response(); handler({ method: 'HEAD', headers: { cookie: 'valid' } }, head);
  assert.equal(head.body, undefined);
});
test('hosted setup remains blocked when only a provider key and publishing tokens are configured', () => {
  const handler = createMayaStatusHandler({ env: { VILLAGE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'fake', GITHUB_AGENT_TOKEN: 'fake', VERCEL_TOKEN: 'fake' }, auth: { authorize: () => ({ status: 200 }) } });
  const result = response(); handler({ method: 'GET', headers: {} }, result);
  const status = JSON.parse(result.body);
  assert.equal(status.runAvailable, false);
  assert.equal(status.setup.provider, 'key_present_unverified');
  assert.equal(status.setup.githubPublishing, 'not_connected');
  assert.equal(status.setup.vercelPublishing, 'not_connected');
  assert.ok(!result.body.includes('fake'));
});
test('spending operator allowlist alone does not activate hosted runs', () => {
  const handler = createMayaStatusHandler({ env: { OFFICE_RUN_ALLOWED_EMAILS: 'owner@example.com', OPENAI_API_KEY: 'fake' }, auth: { authorize: () => ({ status: 200, email: 'owner@example.com' }) } });
  const result = response(); handler({ method: 'GET', headers: {} }, result);
  const status = JSON.parse(result.body);
  assert.equal(status.setup.runPermission, 'configured_unverified');
  assert.equal(status.viewerEmail, 'owner@example.com');
  assert.equal(status.operatorAllowlistPresent, true);
  assert.equal(status.runAvailable, false);
});
test('an existing session sees operator allowlist changes without a new sign-in', () => {
  const env = { OFFICE_RUN_ALLOWED_EMAILS: 'other@example.com' };
  const handler = createMayaStatusHandler({ env, auth: { authorize: () => ({ status: 200, email: 'owner@example.com' }) } });
  const first = response(); handler({ method: 'GET', headers: {} }, first);
  assert.equal(JSON.parse(first.body).setup.runPermission, 'not_authorized');
  env.OFFICE_RUN_ALLOWED_EMAILS = ' other@example.com, OWNER@EXAMPLE.COM ';
  const second = response(); handler({ method: 'GET', headers: {} }, second);
  assert.equal(JSON.parse(second.body).setup.runPermission, 'configured_unverified');
  assert.equal(JSON.parse(second.body).viewerEmail, 'owner@example.com');
  assert.ok(!second.body.includes('other@example.com'));
});
test('status reports only usable operator entries and configured publishing destinations', () => {
  const env = { OFFICE_RUN_ALLOWED_EMAILS: ', , ',
    VILLAGE_PUBLISH_GITHUB_TOKEN: 'github-secret', VILLAGE_PUBLISH_GITHUB_OWNER: 'owner', VILLAGE_PUBLISH_GITHUB_REPO: 'repo',
    VILLAGE_PUBLISH_GITHUB_BRANCH: 'pilot', VILLAGE_PUBLISH_GITHUB_DEDICATED_REPO_CONFIRMED: 'true',
    VILLAGE_PUBLISH_VERCEL_TOKEN: 'vercel-secret', VILLAGE_PUBLISH_VERCEL_TEAM: 'team', VILLAGE_PUBLISH_VERCEL_PROJECT: 'project' };
  const handler = createMayaStatusHandler({ env, auth: { authorize: () => ({ status: 200, email: 'viewer@example.com' }) } });
  const result = response(); handler({ method: 'GET', headers: {} }, result);
  const status = JSON.parse(result.body);
  assert.equal(status.operatorAllowlistPresent, false);
  assert.equal(status.setup.githubPublishing, 'configured_unverified');
  assert.equal(status.setup.vercelPublishing, 'configured_unverified');
  assert.ok(!result.body.includes('secret'));
});
test('hosted test mode is only shown after explicit activation and required settings', () => {
  const handler = createMayaStatusHandler({ env: { OFFICE_RUN_ALLOWED_EMAILS: 'owner@example.com', OPENAI_API_KEY: 'fake', VILLAGE_DATABASE_URL: 'fake', VILLAGE_HOSTED_RUNS_ENABLED: 'true' }, auth: { authorize: () => ({ status: 200, email: 'owner@example.com' }) } });
  const result = response(); handler({ method: 'GET', headers: {} }, result);
  const status = JSON.parse(result.body);
  assert.equal(status.runAvailable, true);
  assert.equal(status.setup.durableProjects, 'configured_unverified');
  assert.match(status.reason, /unverified/);
  assert.ok(!result.body.includes('fake'));
});
test('cloned hosted office does not inherit the original issue board without its own repository setting', async () => {
  let calls = 0;
  const handler = createOfficeHandler({ env: { OFFICE_ALLOWED_ORIGINS: 'https://my-office.example.com', GITHUB_AGENT_TOKEN: 'placeholder' },
    auth: { authorize: () => ({ status: 200 }) }, fetchImpl: async () => { calls++; throw new Error('Should not read John repository'); } });
  const result = response();
  await handler({ method: 'GET', headers: {} }, result);
  assert.equal(JSON.parse(result.body).repository, null);
  assert.equal(JSON.parse(result.body).tasks.status, 'error');
  assert.equal(calls, 0);
});
test('cloned hosted office rejects issue URLs from another repository', async () => {
  const handler = createOfficeHandler({ env: { OFFICE_ALLOWED_ORIGINS: 'https://my-office.example.com', VILLAGE_GITHUB_REPO: 'acme/village', GITHUB_ISSUES_TOKEN: 'placeholder' },
    auth: { authorize: () => ({ status: 200 }) }, fetchImpl: async () => ({ ok: true, json: async () => [{ number: 7, title: 'Wrong source', html_url: 'https://github.com/startupsandcode/agent-village/issues/7', updated_at: '2026-10-11T10:00:00Z' }] }) });
  const result = response();
  await handler({ method: 'GET', headers: {} }, result);
  assert.equal(JSON.parse(result.body).repository, 'acme/village');
  assert.equal(JSON.parse(result.body).tasks.status, 'error');
});
