import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficeHandler } from '../api/office.mjs';
import { createPrivatePageHandler } from '../api/private-page.mjs';
import { createLoginHandler } from '../api/auth/login.mjs';
import { createCallbackHandler } from '../api/auth/callback.mjs';
import { createLogoutHandler } from '../api/auth/logout.mjs';

function response() {
  return { statusCode: 200, headers: {}, body: undefined, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(body) { this.body = body; } };
}

test('anonymous and uninvited office API requests never fetch GitHub', async () => {
  for (const status of [401, 403, 503]) {
    let calls = 0;
    const handler = createOfficeHandler({ env: { GITHUB_AGENT_TOKEN: 'token' }, auth: { authorize: () => ({ status }) }, fetchImpl: async () => { calls++; } });
    const result = response();
    await handler({ method: 'GET', headers: { cookie: '' } }, result);
    assert.equal(result.statusCode, status);
    assert.equal(calls, 0);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.body.includes('token'), false);
  }
});

test('private page returns HTML only after authorization', async () => {
  let reads = 0;
  const readPage = async () => { reads++; return '<h1>private</h1>'; };
  const denied = response();
  await createPrivatePageHandler({ auth: { authorize: () => ({ status: 401 }) }, readPage })({ method: 'GET', headers: {} }, denied);
  assert.equal(denied.statusCode, 302);
  assert.equal(denied.headers.location, '/api/auth/login');
  assert.equal(reads, 0);
  const allowed = response();
  await createPrivatePageHandler({ auth: { authorize: () => ({ status: 200 }) }, readPage })({ method: 'GET', headers: {} }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body, '<h1>private</h1>');
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(reads, 1);
});

test('login and callback set secure cookies and use safe redirects', async () => {
  const auth = {
    begin: () => ({ url: 'https://vercel.com/oauth/authorize?state=abc', cookie: '__Host-office_oauth=x; HttpOnly; Secure; SameSite=Lax; Path=/' }),
    complete: async () => ({ email: 'invited@example.com', sessionCookie: '__Host-office_session=x; HttpOnly; Secure; SameSite=Lax; Path=/' }),
  };
  const login = response();
  await createLoginHandler({ auth })({ method: 'GET' }, login);
  assert.equal(login.statusCode, 302);
  assert.equal(login.headers.location, 'https://vercel.com/oauth/authorize?state=abc');
  assert.match(login.headers['set-cookie'], /HttpOnly/);
  const callback = response();
  await createCallbackHandler({ auth })({ method: 'GET', url: '/api/auth/callback?code=abc&state=xyz', headers: { cookie: 'oauth=x' } }, callback);
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, '/office');
  assert.equal(callback.headers['set-cookie'].length, 2);
  assert.match(callback.headers['set-cookie'][1], /__Host-office_session=/);
});

test('callback failure and logout remove both cookies', async () => {
  const callback = response();
  await createCallbackHandler({ auth: { complete: async () => { throw new Error('private token detail'); } } })({ method: 'GET', url: '/api/auth/callback?code=bad&state=bad', headers: {} }, callback);
  assert.equal(callback.statusCode, 403);
  assert.equal(callback.body.includes('private token detail'), false);
  assert.equal(callback.headers['set-cookie'].length, 2);
  const logout = response();
  await createLogoutHandler()({ method: 'POST', headers: { origin: 'https://agent-village-six.vercel.app' } }, logout);
  assert.equal(logout.statusCode, 303);
  assert.equal(logout.headers.location, '/');
  assert.equal(logout.headers['set-cookie'].length, 2);
  const csrf = response();
  await createLogoutHandler()({ method: 'POST', headers: { origin: 'https://attacker.example' } }, csrf);
  assert.equal(csrf.statusCode, 403);
});
