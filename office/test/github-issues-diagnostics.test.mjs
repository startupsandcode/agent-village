import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubIssuesLoader } from '../lib/github-issues.mjs';
import { createMayaIssuesHealthHandler } from '../api/maya-issues-health.mjs';

const repo = 'startupsandcode/agent-village';
const token = 'secret-token-never-return';
const now = Date.parse('2026-10-12T13:00:00Z');
const diagnostic = async options => (await createGitHubIssuesLoader({ repo, token, now: () => now, diagnostics: true, ...options })()).diagnostic;
const response = () => ({ statusCode: 200, headers: {}, body: null,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(body) { this.body = body; } });

test('issues diagnostic identifies missing token and repository without a network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Unexpected request'); };
  assert.deepEqual(await diagnostic({ token: '', fetchImpl }), { category: 'missing_token' });
  assert.deepEqual(await diagnostic({ repo: null, fetchImpl }), { category: 'missing_repository' });
  assert.deepEqual(await diagnostic({ repo: 'invalid path', fetchImpl }), { category: 'invalid_repository' });
  assert.equal(calls, 0);
});

test('issues diagnostic reports denied, rate-limited and other upstream statuses without response data', async () => {
  const denied = await diagnostic({ fetchImpl: async () => ({ ok: false, status: 401, text: async () => token }) });
  assert.deepEqual(denied, { category: 'upstream_denied', upstreamStatus: 401 });
  const unavailable = await diagnostic({ fetchImpl: async () => ({ ok: false, status: 503, text: async () => token }) });
  assert.deepEqual(unavailable, { category: 'upstream_http', upstreamStatus: 503 });
  assert.equal(JSON.stringify([denied, unavailable]).includes(token), false);
});

test('issues diagnostic honors Retry-After and does not immediately repeat a rate-limited request', async () => {
  let clock = now, calls = 0;
  const load = createGitHubIssuesLoader({ repo, token, diagnostics: true, now: () => clock, fetchImpl: async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 429, headers: { get: key => key === 'retry-after' ? '120' : null } }
      : { ok: true, json: async () => [] };
  } });
  assert.deepEqual((await load()).diagnostic, { category: 'rate_limited', upstreamStatus: 429, retryAfterSeconds: 120 });
  clock += 30_000;
  assert.deepEqual((await load()).diagnostic, { category: 'rate_limited', upstreamStatus: 429, retryAfterSeconds: 90 });
  assert.equal(calls, 1);
  clock += 90_000;
  assert.equal((await load()).status, 'ok');
  assert.equal(calls, 2);
});

test('issues diagnostic recognizes GitHub 403 rate limits and reset time without reading the response body', async () => {
  let calls = 0;
  const load = createGitHubIssuesLoader({ repo, token, diagnostics: true, now: () => now, fetchImpl: async () => {
    calls++;
    return { ok: false, status: 403, headers: { get: key => ({
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 180),
    })[key] ?? null }, text: async () => { throw new Error('Response body must not be read'); } };
  } });
  assert.deepEqual((await load()).diagnostic, { category: 'rate_limited', upstreamStatus: 403, retryAfterSeconds: 180 });
  assert.deepEqual((await load()).diagnostic, { category: 'rate_limited', upstreamStatus: 403, retryAfterSeconds: 180 });
  assert.equal(calls, 1);
});

test('issues diagnostic accepts an HTTP-date Retry-After without retrying early', async () => {
  let calls = 0;
  const until = new Date(now + 240_000).toUTCString();
  const load = createGitHubIssuesLoader({ repo, token, diagnostics: true, now: () => now, fetchImpl: async () => {
    calls++; return { ok: false, status: 429, headers: { get: key => key === 'retry-after' ? until : null } };
  } });
  assert.deepEqual((await load()).diagnostic, { category: 'rate_limited', upstreamStatus: 429, retryAfterSeconds: 240 });
  await load(); assert.equal(calls, 1);
});

test('issues diagnostic identifies network and malformed responses without leaking error text', async () => {
  const network = await diagnostic({ fetchImpl: async () => { throw new Error(token); } });
  const malformed = await diagnostic({ fetchImpl: async () => ({ ok: true, json: async () => ({ private: token }) }) });
  const invalidIssue = await diagnostic({ fetchImpl: async () => ({ ok: true, json: async () => [{ number: 1, title: token, html_url: 'https://evil.example/1', updated_at: '2026-10-12T00:00:00Z' }] }) });
  assert.deepEqual(network, { category: 'network_error' });
  assert.deepEqual(malformed, { category: 'malformed_response' });
  assert.deepEqual(invalidIssue, { category: 'invalid_issue_data' });
  assert.equal(JSON.stringify([network, malformed, invalidIssue]).includes(token), false);
});

test('operator-only issues health rejects viewers and cross-site requests before touching GitHub', async () => {
  let calls = 0;
  const env = { OFFICE_RUN_ALLOWED_EMAILS: 'operator@example.com', OFFICE_ALLOWED_ORIGINS: 'https://office.example.com', VILLAGE_GITHUB_REPO: repo, GITHUB_AGENT_TOKEN: token };
  const handler = createMayaIssuesHealthHandler({ env, auth: { authorize: () => ({ status: 200, email: 'viewer@example.com' }) }, fetchImpl: async () => { calls++; throw new Error('Unexpected request'); } });
  const viewer = response(); await handler({ method: 'GET', headers: { host: 'office.example.com' } }, viewer);
  assert.equal(viewer.statusCode, 403);
  assert.equal(calls, 0);
  const operator = createMayaIssuesHealthHandler({ env, auth: { authorize: () => ({ status: 200, email: 'operator@example.com' }) }, fetchImpl: async () => { calls++; throw new Error('Unexpected request'); } });
  const crossSite = response(); await operator({ method: 'GET', headers: { host: 'office.example.com', 'sec-fetch-site': 'cross-site' } }, crossSite);
  assert.equal(crossSite.statusCode, 403);
  assert.equal(calls, 0);
});

test('operator-only issues health returns only a sanitized category and upstream status', async () => {
  const env = { OFFICE_RUN_ALLOWED_EMAILS: 'operator@example.com', OFFICE_ALLOWED_ORIGINS: 'https://office.example.com', VILLAGE_GITHUB_REPO: repo, GITHUB_AGENT_TOKEN: token };
  const handler = createMayaIssuesHealthHandler({ env, auth: { authorize: () => ({ status: 200, email: 'operator@example.com' }) },
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => token }) });
  const result = response(); await handler({ method: 'GET', headers: { host: 'office.example.com', 'sec-fetch-site': 'same-origin' } }, result);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { ready: false, diagnostic: { category: 'upstream_denied', upstreamStatus: 403 } });
  assert.equal(result.body.includes(token), false);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('operator-only issues health reports an issue count without titles or URLs on success', async () => {
  const env = { OFFICE_RUN_ALLOWED_EMAILS: 'operator@example.com', OFFICE_ALLOWED_ORIGINS: 'https://office.example.com', VILLAGE_GITHUB_REPO: repo, GITHUB_AGENT_TOKEN: token };
  const handler = createMayaIssuesHealthHandler({ env, auth: { authorize: () => ({ status: 200, email: 'operator@example.com' }) },
    fetchImpl: async () => ({ ok: true, json: async () => [{ number: 7, title: 'Private title', html_url: `https://github.com/${repo}/issues/7`, updated_at: '2026-10-12T00:00:00Z' }] }) });
  const result = response(); await handler({ method: 'GET', headers: { host: 'office.example.com' } }, result);
  assert.deepEqual(JSON.parse(result.body), { ready: true, issueCount: 1 });
  assert.equal(result.body.includes('Private title'), false);
});
