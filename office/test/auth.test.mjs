import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createAuth } from '../lib/auth.mjs';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const env = {
  VERCEL_APP_CLIENT_ID: 'client-123',
  VERCEL_APP_CLIENT_SECRET: 'client-secret',
  OFFICE_SESSION_SECRET: 'a-secret-at-least-thirty-two-bytes-long',
  OFFICE_ALLOWED_EMAILS: 'invited@example.com',
};
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
function idToken(nonce, overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://vercel.com', aud: env.VERCEL_APP_CLIENT_ID, sub: 'user-123', nonce, iat: NOW / 1000, exp: NOW / 1000 + 3600, ...overrides })).toString('base64url');
  const body = `${header}.${claims}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
function makeFetch(nonce, { user = { sub: 'user-123', email: 'invited@example.com', email_verified: true }, claims = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'access-token', id_token: idToken(nonce, claims) }) };
    if (url.endsWith('/userinfo')) return { ok: true, json: async () => user };
    if (url.endsWith('/jwks')) return { ok: true, json: async () => ({ keys: [jwk] }) };
    throw new Error(`Unexpected URL ${url}`);
  };
  return { fetchImpl, calls };
}

test('login uses a registered callback, PKCE S256, and signed short-lived flow cookie', () => {
  const auth = createAuth({ env, now: () => NOW });
  const { url, cookie } = auth.begin();
  const target = new URL(url);
  assert.equal(target.origin, 'https://vercel.com');
  assert.equal(target.pathname, '/oauth/authorize');
  assert.equal(target.searchParams.get('redirect_uri'), 'https://agent-village-six.vercel.app/api/auth/callback');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('scope'), 'openid email');
  assert.match(cookie, /^__Host-office_oauth=/);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600/);
  const flow = auth.readFlow(cookie.split(';')[0]);
  assert.equal(flow.state, target.searchParams.get('state'));
  assert.equal(flow.nonce, target.searchParams.get('nonce'));
  assert.equal(target.searchParams.get('code_challenge'), createHash('sha256').update(flow.verifier).digest('base64url'));
});

test('custom-domain login exchanges the code with its own registered callback', async () => {
  const first = createAuth({ env, now: () => NOW });
  const { url, cookie } = first.begin('agent-village.startupsandcode.com');
  const callback = 'https://agent-village.startupsandcode.com/api/auth/callback';
  assert.equal(new URL(url).searchParams.get('redirect_uri'), callback);
  const flow = first.readFlow(cookie.split(';')[0]);
  const { fetchImpl, calls } = makeFetch(flow.nonce);
  const auth = createAuth({ env, now: () => NOW, fetchImpl });
  await auth.complete({ code: 'one-use-code', state: flow.state, cookie, host: 'agent-village.startupsandcode.com' });
  assert.equal(new URLSearchParams(calls[0].options.body).get('redirect_uri'), callback);
});

test('OAuth rejects unregistered hosts and a callback on a different host before token exchange', async () => {
  const first = createAuth({ env, now: () => NOW });
  assert.throws(() => first.begin('attacker.example'), /host|origin|callback/i);
  const { cookie } = first.begin('agent-village.startupsandcode.com');
  const flow = first.readFlow(cookie.split(';')[0]);
  let called = false;
  const auth = createAuth({ env, now: () => NOW, fetchImpl: async () => { called = true; } });
  await assert.rejects(auth.complete({ code: 'code', state: flow.state, cookie, host: 'agent-village-six.vercel.app' }), /host|origin|callback/i);
  assert.equal(called, false);
});
test('cloned office uses only its explicitly configured callback hosts', () => {
  const cloned = createAuth({ env: { ...env, OFFICE_ALLOWED_ORIGINS: 'https://my-office.example.com' }, now: () => NOW });
  assert.equal(new URL(cloned.begin('my-office.example.com').url).searchParams.get('redirect_uri'), 'https://my-office.example.com/api/auth/callback');
  assert.throws(() => cloned.begin('agent-village.startupsandcode.com'), /Unregistered office host/);
  assert.throws(() => createAuth({ env: { ...env, OFFICE_ALLOWED_ORIGINS: 'https://my-office.example.com/extra' } }).begin('my-office.example.com'), /Invalid office origin/);
  assert.throws(() => createAuth({ env: { ...env, OFFICE_ALLOWED_ORIGINS: 'http://my-office.example.com' } }).begin('my-office.example.com'), /Invalid office origin/);
});

test('callback accepts only signed state, valid nonce, and a verified invited email', async () => {
  const first = createAuth({ env, now: () => NOW });
  const { url, cookie } = first.begin();
  const flow = first.readFlow(cookie.split(';')[0]);
  const { fetchImpl, calls } = makeFetch(flow.nonce);
  const auth = createAuth({ env, now: () => NOW, fetchImpl });
  const result = await auth.complete({ code: 'one-use-code', state: new URL(url).searchParams.get('state'), cookie });
  assert.equal(result.email, 'invited@example.com');
  assert.match(result.sessionCookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(auth.authorize(result.sessionCookie.split(';')[0]).status, 200);
  assert.equal(calls[0].url, 'https://api.vercel.com/login/oauth/token');
  const params = new URLSearchParams(calls[0].options.body);
  assert.equal(params.get('code_verifier'), flow.verifier);
  assert.equal(params.get('client_secret'), env.VERCEL_APP_CLIENT_SECRET);
  const userInfoRequest = calls.find(call => call.url.endsWith('/userinfo'));
  assert.equal(userInfoRequest.options.method, 'POST');
  assert.equal(userInfoRequest.options.headers.Authorization, 'Bearer access-token');
});

test('missing configuration fails closed and no OAuth request starts', () => {
  const auth = createAuth({ env: {}, now: () => NOW });
  assert.throws(() => auth.begin(), /configuration/i);
  assert.equal(auth.authorize('').status, 503);
});

test('callback rejects wrong state before token exchange', async () => {
  const first = createAuth({ env, now: () => NOW });
  const { cookie } = first.begin();
  let called = false;
  const auth = createAuth({ env, now: () => NOW, fetchImpl: async () => { called = true; } });
  await assert.rejects(auth.complete({ code: 'code', state: 'wrong', cookie }), /state/i);
  assert.equal(called, false);
});

test('callback rejects forged nonce, unverified and uninvited identity', async () => {
  const first = createAuth({ env, now: () => NOW });
  const { cookie } = first.begin();
  const flow = first.readFlow(cookie.split(';')[0]);
  for (const options of [
    { claims: { nonce: 'wrong' } },
    { user: { sub: 'user-123', email: 'invited@example.com', email_verified: false } },
    { user: { sub: 'user-123', email: 'other@example.com', email_verified: true } },
  ]) {
    const { fetchImpl } = makeFetch(flow.nonce, options);
    const auth = createAuth({ env, now: () => NOW, fetchImpl });
    await assert.rejects(auth.complete({ code: 'code', state: flow.state, cookie }), /denied|invalid/i);
  }
});

test('session tampering, expiration, and invite removal deny access', async () => {
  const first = createAuth({ env, now: () => NOW });
  const { cookie } = first.begin();
  const flow = first.readFlow(cookie.split(';')[0]);
  const { fetchImpl } = makeFetch(flow.nonce);
  const auth = createAuth({ env, now: () => NOW, fetchImpl });
  const { sessionCookie } = await auth.complete({ code: 'code', state: flow.state, cookie });
  const session = sessionCookie.split(';')[0];
  assert.equal(auth.authorize(`${session}x`).status, 401);
  assert.equal(createAuth({ env, now: () => NOW + 3_600_001 }).authorize(session).status, 401);
  assert.equal(createAuth({ env: { ...env, OFFICE_ALLOWED_EMAILS: 'other@example.com' }, now: () => NOW }).authorize(session).status, 403);
});
