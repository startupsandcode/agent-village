import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { roleCommand, CodexRunner, resolveCodexCommand } from '../codex-runner.mjs';

test('Windows Codex CLI launches the installed official npm entry point without a shell', async () => {
  const checked = [];
  const command = await resolveCodexCommand(['codex', 'login', 'status'], {
    platform: 'win32', pathValue: 'C:\\Users\\JMann\\AppData\\Roaming\\npm;C:\\Windows\\System32',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    async canAccess(path) {
      checked.push(path);
      if (path === 'C:\\Users\\JMann\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js') return;
      throw new Error('not installed');
    },
  });
  assert.deepEqual(command, ['C:\\Program Files\\nodejs\\node.exe',
    'C:\\Users\\JMann\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'login', 'status']);
  assert.equal(checked.length, 1);
});

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
    return JSON.stringify({ request_id: 'emma:12:aaaaaaaaaaaa', stage: 'maya', status: 'done',
      issue: 22, pr: null, question_id: null, question: null, category: 'routine', evidence: [], reviewed_sha: null });
  }, login: async () => true });
  await runner.runRole({ role: 'maya', cwd: '/tmp/astra', prompt: 'Inspect issue', timeoutSeconds: 300,
    env: { OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', PATH: '/bin' } });
  assert.equal(seen.OPENAI_API_KEY, undefined);
  assert.equal(seen.CODEX_API_KEY, undefined);
});

test('CLI nonzero exit retains a short sanitized diagnostic without exposing tokens or local paths', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => true;
  const runner = new CodexRunner({ login: async () => true,
    resolveCommand: async () => ['node', 'codex.js'],
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.emit('data', 'request failed: temporary write denied; Authorization: Bearer secret-token-value. ' +
          'path C:\\Users\\JMann\\.codex\\tmp\\session.json');
        child.emit('close', 12);
      });
      return child;
    },
  });
  await assert.rejects(() => runner.runStructured({ cwd: 'C:\\workspace', prompt: 'Review the mission',
    timeoutSeconds: 10, schemaPath: 'C:\\schema.json' }), error => {
    assert.match(error.message, /Codex stage failed \(exit 12\)/);
    assert.match(error.message, /temporary write denied/);
    assert.doesNotMatch(error.message, /secret-token-value|C:\\\\Users/);
    return true;
  });
});

test('CLI process launch failures keep a safe platform error code', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => true;
  const runner = new CodexRunner({ login: async () => true,
    resolveCommand: async () => ['node', 'codex.js'],
    spawnProcess: () => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('access denied at C:\\Users\\JMann\\.codex'),
        { code: 'EACCES' })));
      return child;
    },
  });
  await assert.rejects(() => runner.runStructured({ cwd: 'C:\\workspace', prompt: 'Review the mission',
    timeoutSeconds: 10, schemaPath: 'C:\\schema.json' }), error => {
    assert.match(error.message, /Codex stage failed \(process launch EACCES\)/);
    assert.doesNotMatch(error.message, /C:\\\\Users/);
    return true;
  });
});
