import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectConnections } from '../connections.mjs';

test('connection probes use read-only commands and omit provider secrets from child environment', async () => {
  const calls = [];
  const result = await inspectConnections({ env: { PATH: '/usr/bin', HOME: '/tmp/example', OPENAI_API_KEY: 'must-not-leak', ANTHROPIC_API_KEY: 'must-not-leak' },
    run: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: file === 'gh' ? 'learner\n' : 'learner-team\n' }; } });
  assert.deepEqual(result, { github: { state: 'connected', account: 'learner' }, vercel: { state: 'connected', account: 'learner-team' } });
  assert.deepEqual(calls.map(call => [call.file, call.args]), [['gh', ['api', 'user', '--jq', '.login']], ['vercel', ['whoami', '--non-interactive']]]);
  assert.ok(calls.every(call => !JSON.stringify(call.options).includes('must-not-leak') && call.options.timeout === 5000));
  assert.ok(calls.every(call => call.options.env.NO_UPDATE_NOTIFIER === '1'));
});
test('connection probes report unavailable without returning CLI errors or token output', async () => {
  const result = await inspectConnections({ run: async file => { if (file === 'gh') throw new Error('token secret'); return { stdout: 'Authorization: Bearer secret' }; } });
  assert.deepEqual(result, { github: { state: 'unavailable' }, vercel: { state: 'unavailable' } });
});
