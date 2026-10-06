import assert from 'node:assert/strict';
import test from 'node:test';
import { roleCommand, CodexRunner } from '../codex-runner.mjs';

test('write roles retain approval review and Quinn is read only', () => {
  const sam = roleCommand('codex', '/tmp/astra', '/tmp/schema.json', '/tmp/out.json', false);
  const quinn = roleCommand('codex', '/tmp/astra', '/tmp/schema.json', '/tmp/out.json', true);
  assert.ok(sam.includes('--approve-for-me'));
  assert.ok(quinn.includes('read-only'));
  assert.ok(!quinn.includes('--approve-for-me'));
  assert.ok(!sam.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('invalid structured response blocks a stage', async () => {
  const runner = new CodexRunner({ launch: async () => '{broken', login: async () => true });
  await assert.rejects(() => runner.runRole({ role: 'maya', cwd: '/tmp/astra', prompt: 'Inspect issue',
    timeoutSeconds: 300 }), /JSON/);
});

test('model API keys are absent from child environment', async () => {
  let seen;
  const runner = new CodexRunner({ launch: async (_args, options) => {
    seen = options.env;
    return JSON.stringify({ request_id: 'emma:12:aaaaaaaaaaaa', stage: 'maya', status: 'done',
      issue: 22, pr: null, question_id: null, question: null, category: 'routine', evidence: [], reviewed_sha: null });
  }, login: async () => true });
  await runner.runRole({ role: 'maya', cwd: '/tmp/astra', prompt: 'Inspect issue', timeoutSeconds: 300,
    env: { OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', PATH: '/bin' } });
  assert.equal(seen.OPENAI_API_KEY, undefined);
  assert.equal(seen.CODEX_API_KEY, undefined);
});
