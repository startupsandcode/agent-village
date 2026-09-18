import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficeHandler } from '../api/office.mjs';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const TOKEN = 'secret-test-token-never-send-to-client';

function responseRecorder() {
  const response = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; return this; },
  };
  return response;
}

test('hosted API sends token only to GitHub and returns selected issue fields', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => [
      { number: 7, title: 'Build office', html_url: 'https://github.com/startupsandcode/agent-village/issues/7', updated_at: '2026-09-18T11:00:00Z', body: 'Internal details' },
      { number: 8, title: 'PR title', html_url: 'https://github.com/startupsandcode/agent-village/pull/8', updated_at: '2026-09-18T11:05:00Z', pull_request: { url: 'https://api.github.com/repos/startupsandcode/agent-village/pulls/8' } },
    ] };
  };
  const handler = createOfficeHandler({ token: TOKEN, fetchImpl, now: () => NOW });
  const response = responseRecorder();
  await handler({ method: 'GET' }, response);
  assert.equal(request.url, 'https://api.github.com/repos/startupsandcode/agent-village/issues?state=open&per_page=100');
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.body.includes(TOKEN), false);
  const body = JSON.parse(response.body);
  assert.equal(body.generatedAt, '2026-09-18T12:00:00.000Z');
  assert.equal(body.checkinsConfigured, false);
  assert.deepEqual(body.tasks, { status: 'ok', updatedAt: '2026-09-18T12:00:00.000Z', items: [
    { number: 7, title: 'Build office', url: 'https://github.com/startupsandcode/agent-village/issues/7', updatedAt: '2026-09-18T11:00:00Z' },
  ] });
  assert.equal(body.agents.length, 5);
  assert.deepEqual(body.agents.map(agent => agent.status), Array(5).fill('unavailable'));
  assert.deepEqual(body.agents[0], { name: 'Maya', role: 'Engineering lead', status: 'unavailable', summary: null, issueNumber: null, updatedAt: null, expiresAt: null });
});

test('hosted API does not call GitHub without a token', async () => {
  const handler = createOfficeHandler({ token: '', fetchImpl: async () => { throw new Error('Unexpected fetch'); }, now: () => NOW });
  const response = responseRecorder();
  await handler({ method: 'GET' }, response);
  assert.deepEqual(JSON.parse(response.body).tasks, { status: 'error', updatedAt: null, items: [] });
});

test('hosted API uses existing GITHUB_AGENT_TOKEN when the preferred variable is absent', async () => {
  const sent = [];
  const fetchImpl = async (_url, options) => {
    sent.push(options.headers.Authorization);
    return { ok: true, json: async () => [] };
  };
  const fallback = responseRecorder();
  await createOfficeHandler({ env: { GITHUB_AGENT_TOKEN: TOKEN }, fetchImpl, now: () => NOW })({ method: 'GET' }, fallback);
  assert.deepEqual(sent, [`Bearer ${TOKEN}`]);
  assert.equal(JSON.parse(fallback.body).tasks.status, 'ok');
  assert.equal(fallback.body.includes(TOKEN), false);

  const preferred = 'preferred-test-token-never-send-to-client';
  const primary = responseRecorder();
  await createOfficeHandler({ env: { GITHUB_ISSUES_TOKEN: preferred, GITHUB_AGENT_TOKEN: TOKEN }, fetchImpl, now: () => NOW })({ method: 'GET' }, primary);
  assert.deepEqual(sent, [`Bearer ${TOKEN}`, `Bearer ${preferred}`]);
  assert.equal(primary.body.includes(preferred), false);
  assert.equal(primary.body.includes(TOKEN), false);
});

test('hosted API hides GitHub failures and malformed issue data', async () => {
  const cases = [
    async () => ({ ok: false, status: 401, text: async () => TOKEN }),
    async () => { throw new Error(TOKEN); },
    async () => ({ ok: true, json: async () => [{ number: 7, title: 'Bad', html_url: 'javascript:bad', updated_at: 'bad' }] }),
  ];
  for (const fetchImpl of cases) {
    const handler = createOfficeHandler({ token: TOKEN, fetchImpl, now: () => NOW });
    const response = responseRecorder();
    await handler({ method: 'GET' }, response);
    assert.deepEqual(JSON.parse(response.body).tasks, { status: 'error', updatedAt: null, items: [] });
    assert.equal(response.body.includes(TOKEN), false);
  }
});

test('hosted API supports HEAD without a body and rejects other methods without fetching', async () => {
  let calls = 0;
  const handler = createOfficeHandler({ token: TOKEN, fetchImpl: async () => { calls++; return { ok: true, json: async () => [] }; }, now: () => NOW });
  const head = responseRecorder();
  await handler({ method: 'HEAD' }, head);
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, undefined);
  const post = responseRecorder();
  await handler({ method: 'POST' }, post);
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal(post.body.includes(TOKEN), false);
  assert.equal(calls, 1);
});

test('hosted API returns issues on page two after a full page of pull requests', async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (urls.length === 1) return { ok: true, json: async () => Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      pull_request: { url: `https://api.github.com/repos/startupsandcode/agent-village/pulls/${index + 1}` },
    })) };
    return { ok: true, json: async () => [{
      number: 101, title: 'Issue after PRs', html_url: 'https://github.com/startupsandcode/agent-village/issues/101', updated_at: '2026-09-18T11:00:00Z',
    }] };
  };
  const response = responseRecorder();
  await createOfficeHandler({ token: TOKEN, fetchImpl, now: () => NOW })({ method: 'GET' }, response);
  assert.deepEqual(urls, [
    'https://api.github.com/repos/startupsandcode/agent-village/issues?state=open&per_page=100',
    'https://api.github.com/repos/startupsandcode/agent-village/issues?state=open&per_page=100&page=2',
  ]);
  assert.deepEqual(JSON.parse(response.body).tasks.items, [{
    number: 101, title: 'Issue after PRs', url: 'https://github.com/startupsandcode/agent-village/issues/101', updatedAt: '2026-09-18T11:00:00Z',
  }]);
  assert.equal(response.body.includes(TOKEN), false);
});

test('hosted API reports an error rather than silently truncating a full final page', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    return { ok: true, json: async () => Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      pull_request: { url: `https://api.github.com/repos/startupsandcode/agent-village/pulls/${index + 1}` },
    })) };
  };
  const response = responseRecorder();
  await createOfficeHandler({ token: TOKEN, fetchImpl, now: () => NOW })({ method: 'GET' }, response);
  assert.equal(urls.length, 10);
  assert.deepEqual(JSON.parse(response.body).tasks, { status: 'error', updatedAt: null, items: [] });
  assert.equal(response.body.includes(TOKEN), false);
});
