import test from 'node:test';
import assert from 'node:assert/strict';
import { createMayaStatusHandler } from '../api/maya-status.mjs';
import { createOfficeHandler } from '../api/office.mjs';

function response() {
  return { statusCode: 0, headers: {}, body: null, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
}
test('hosted Maya status denies anonymous access and never returns a configured secret', () => {
  const secret = 'secret-never-returned';
  const handler = createMayaStatusHandler({ env: { VILLAGE_PROVIDER: 'openai', OPENAI_API_KEY: secret }, auth: { authorize: cookie => ({ status: cookie === 'valid' ? 200 : 401 }) } });
  const anonymous = response(); handler({ method: 'GET', headers: {} }, anonymous);
  assert.equal(anonymous.statusCode, 401);
  const invited = response(); handler({ method: 'GET', headers: { cookie: 'valid' } }, invited);
  assert.equal(invited.statusCode, 200);
  assert.deepEqual(JSON.parse(invited.body), { provider: 'openai', providerConfigured: true, officeName: '', runAvailable: false, reason: 'Hosted runs need a private durable project store and isolated executor. The local office can run now.' });
  assert.ok(!invited.body.includes(secret));
  const head = response(); handler({ method: 'HEAD', headers: { cookie: 'valid' } }, head);
  assert.equal(head.body, undefined);
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
