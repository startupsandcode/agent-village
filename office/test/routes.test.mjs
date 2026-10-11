import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficeHandler } from '../api/office.mjs';
import { createPrivatePageHandler } from '../api/private-page.mjs';
import { createLoginHandler } from '../api/auth/login.mjs';
import { createCallbackHandler } from '../api/auth/callback.mjs';
import { createLogoutHandler } from '../api/auth/logout.mjs';
import { createAuth } from '../lib/auth.mjs';

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

test('anonymous private page waits for an explicit sign-in and never reads private HTML', async () => {
  let reads = 0;
  const readPage = async () => { reads++; return '<h1>private</h1>'; };
  const handler = createPrivatePageHandler({ auth: { authorize: () => ({ status: 401 }) }, readPage });
  const denied = response();
  await handler({ method: 'GET', headers: {} }, denied);
  assert.equal(denied.statusCode, 200);
  assert.match(denied.headers['content-type'], /^text\/html/);
  assert.equal(denied.headers['cache-control'], 'no-store');
  assert.equal(denied.headers['x-content-type-options'], 'nosniff');
  assert.equal(denied.headers.location, undefined);
  assert.match(denied.body, /href="\/api\/auth\/login"/);
  assert.doesNotMatch(denied.body, /private/);
  assert.equal(reads, 0);

  const head = response();
  await handler({ method: 'HEAD', headers: {} }, head);
  assert.equal(head.statusCode, 200);
  assert.match(head.headers['content-type'], /^text\/html/);
  assert.equal(head.headers['cache-control'], 'no-store');
  assert.equal(head.headers['x-content-type-options'], 'nosniff');
  assert.equal(head.headers.location, undefined);
  assert.equal(head.body, undefined);
  assert.equal(reads, 0);
});

test('private page returns private HTML only after authorization', async () => {
  let reads = 0;
  const readPage = async () => { reads++; return '<h1>private</h1>'; };
  const allowed = response();
  await createPrivatePageHandler({ auth: { authorize: () => ({ status: 200 }) }, readPage })({ method: 'GET', headers: {} }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body, '<h1>private</h1>');
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(reads, 1);
});

test('missing preview sign-in configuration reports a clear 503 without private HTML', async () => {
  let reads = 0;
  const handler = createPrivatePageHandler({ auth: { authorize: () => ({ status: 503 }) }, readPage: async () => { reads++; return '<h1>private</h1>'; } });
  const unavailable = response();
  await handler({ method: 'GET', headers: {} }, unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body, 'Private office sign-in is not configured for this deployment.');
  assert.equal(reads, 0);
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

test('login route selects the callback from the registered request host', () => {
  const env = {
    VERCEL_APP_CLIENT_ID: 'client-123',
    VERCEL_APP_CLIENT_SECRET: 'client-secret',
    OFFICE_SESSION_SECRET: 'a-secret-at-least-thirty-two-bytes-long',
    OFFICE_ALLOWED_EMAILS: 'invited@example.com',
  };
  const handler = createLoginHandler({ auth: createAuth({ env }) });
  const custom = response();
  handler({ method: 'GET', headers: { host: 'agent-village.startupsandcode.com' } }, custom);
  assert.equal(custom.statusCode, 302);
  assert.equal(new URL(custom.headers.location).searchParams.get('redirect_uri'), 'https://agent-village.startupsandcode.com/api/auth/callback');
  const unknown = response();
  handler({ method: 'GET', headers: { host: 'attacker.example' } }, unknown);
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.headers.location, undefined);
});

test('callback route forwards its host to OAuth completion', async () => {
  const callback = response();
  const auth = { complete: async ({ host }) => {
    if (host !== 'agent-village.startupsandcode.com') throw new Error('Wrong callback host');
    return { sessionCookie: '__Host-office_session=x; HttpOnly; Secure; Path=/' };
  } };
  await createCallbackHandler({ auth })({ method: 'GET', url: '/api/auth/callback?code=abc&state=xyz', headers: { host: 'agent-village.startupsandcode.com' } }, callback);
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, '/office');
});

test('callback failure and logout remove both cookies', async () => {
  const callback = response();
  await createCallbackHandler({ auth: { complete: async () => { throw new Error('private token detail'); } } })({ method: 'GET', url: '/api/auth/callback?code=bad&state=bad', headers: {} }, callback);
  assert.equal(callback.statusCode, 403);
  assert.equal(callback.body.includes('private token detail'), false);
  assert.equal(callback.headers['set-cookie'].length, 2);
  const logout = response();
  await createLogoutHandler()({ method: 'POST', headers: { host: 'agent-village-six.vercel.app', origin: 'https://agent-village-six.vercel.app' } }, logout);
  assert.equal(logout.statusCode, 303);
  assert.equal(logout.headers.location, '/');
  assert.equal(logout.headers['set-cookie'].length, 2);
  const csrf = response();
  await createLogoutHandler()({ method: 'POST', headers: { host: 'agent-village-six.vercel.app', origin: 'https://attacker.example' } }, csrf);
  assert.equal(csrf.statusCode, 403);
});

test('logout accepts the custom domain only when Origin matches the request host', () => {
  const handler = createLogoutHandler();
  const allowed = response();
  handler({ method: 'POST', headers: { host: 'agent-village.startupsandcode.com', origin: 'https://agent-village.startupsandcode.com' } }, allowed);
  assert.equal(allowed.statusCode, 303);
  assert.equal(allowed.headers.location, '/');
  const crossOrigin = response();
  handler({ method: 'POST', headers: { host: 'agent-village.startupsandcode.com', origin: 'https://agent-village-six.vercel.app' } }, crossOrigin);
  assert.equal(crossOrigin.statusCode, 403);
  const unregistered = response();
  handler({ method: 'POST', headers: { host: 'attacker.example', origin: 'https://attacker.example' } }, unregistered);
  assert.equal(unregistered.statusCode, 403);
});
