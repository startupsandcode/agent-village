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

test('structured mission commands attach screenshots and never bypass sandbox or approval review', async () => {
  const images = ['/evidence/desktop.png', '/evidence/narrow.png'];
  const command = roleCommand('codex', '/workspace', '/schema.json', '/result.json', true, images);
  assert.deepEqual(command.slice(command.indexOf('--image'), command.indexOf('--output-schema')),
    ['--image', images[0], '--image', images[1]]);
  assert.ok(command.includes('--sandbox') && command.includes('read-only'));
  assert.ok(!command.includes('--dangerously-bypass-approvals-and-sandbox'));

  let launched;
  const runner = new CodexRunner({ login: async () => true, launch: async (args, options) => {
    launched = { args, options };
    return '{"stage":"susie_visual"}';
  } });
  const result = await runner.runStructured({ cwd: '/workspace', prompt: 'Review screenshots',
    timeoutSeconds: 120, schemaPath: '/mission-schema.json', readOnly: true, images,
    env: { CODEX_API_KEY: 'secret', OPENAI_API_KEY: 'secret', PATH: '/bin' } });
  assert.equal(result.stage, 'susie_visual');
  assert.deepEqual(launched.args.slice(launched.args.indexOf('--image'), launched.args.indexOf('--output-schema')),
    ['--image', images[0], '--image', images[1]]);
  assert.equal(launched.options.env.CODEX_API_KEY, undefined);
  assert.equal(launched.options.env.OPENAI_API_KEY, undefined);
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
    return JSON.stringify({ request_id: 'maya:12:aaaaaaaaaaaa', stage: 'maya', status: 'done',
      issue: 22, pr: null, question_id: null, question: null, category: 'routine', evidence: [], reviewed_sha: null });
  }, login: async () => true });
  await runner.runRole({ role: 'maya', cwd: '/tmp/astra', prompt: 'Inspect issue', timeoutSeconds: 300,
    env: { OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', PATH: '/bin' } });
  assert.equal(seen.OPENAI_API_KEY, undefined);
  assert.equal(seen.CODEX_API_KEY, undefined);
});
