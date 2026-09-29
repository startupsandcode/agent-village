import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli.mjs';

const request = 'emma:12:aaaaaaaaaaaa';
const issue = { number: 21, body: 'Selected', comments: [{ body:
  `<!-- dispatch-ready:${request} -->\n\`\`\`json\n${JSON.stringify({
    request_id: request, repo: 'startupsandcode/astra-lab', parent_issue: 21,
    brief_id: 'emma-2026-09', brief_digest: 'a'.repeat(64), candidate_id: 'b',
    approved_at: '2026-09-29T13:00:00Z', first_actionable_issue: 22,
  })}\n\`\`\`` }] };

async function fixture(host = 'mac') {
  const root = await mkdtemp(join(tmpdir(), 'village-cli-'));
  await mkdir(join(root, 'ops'));
  await writeFile(join(root, 'ops', 'runner-config.json'), JSON.stringify({ enabled: true }));
  const control = { number: 5, body: 'Emma control', comments: [
    { body: `<!-- emma-active-host:${host} -->\nActive Emma host: ${host}` },
    { body: '<!-- emma-attempt:2026-09-29:run-1 -->\n' + JSON.stringify({
      request_id: request, host_id: host, day: '2026-09-29', attempt_id: 'run-1' }) },
  ] };
  const gh = { getIssue: async number => number === 5 ? control : issue };
  return { root, control, gh, options: { env: { EMMA_HOST_ID: 'mac', EMMA_ATTEMPT_ID: 'run-1' },
    astraRoot: root, day: '2026-09-29' }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('run accepts only a matching approved dispatch', async () => {
  const f = await fixture();
  try {
  const worker = { advance: async dispatch => ({ status: 'progress', request_id: dispatch.request_id }) };
  const result = await main(['run', '--repo', 'startupsandcode/astra-lab', '--issue', '21',
    '--request-id', request], f.gh, worker, f.options);
  assert.equal(result.status, 'progress');
  await assert.rejects(() => main(['run', '--repo', 'startupsandcode/astra-lab', '--issue', '21',
    '--request-id', 'emma:12:bbbbbbbbbbbb'], f.gh, worker, f.options), /request ID/);
  } finally { await f.cleanup(); }
});

test('run rejects a wrong repository before reading GitHub', async () => {
  const gh = { getIssue: async () => { throw new Error('should not read'); } };
  await assert.rejects(() => main(['run', '--repo', 'other/repo', '--issue', '21',
    '--request-id', request], gh), /repository/);
});

test('run blocks conflicting host, missing claim, and paused Astra before worker writes', async () => {
  const f = await fixture('windows');
  let writes = 0;
  const worker = { advance: async () => { writes++; return { status: 'progress' }; } };
  const args = ['run', '--repo', 'startupsandcode/astra-lab', '--issue', '21', '--request-id', request];
  try {
    await assert.rejects(() => main(args, f.gh, worker, f.options), /active host/);
    f.control.comments[0].body = '<!-- emma-active-host:mac -->\nActive Emma host: mac';
    await assert.rejects(() => main(args, f.gh, worker, f.options), /attempt/);
    f.control.comments[1].body = '<!-- emma-attempt:2026-09-29:run-1 -->\n' + JSON.stringify({
      request_id: request, host_id: 'mac', day: '2026-09-29', attempt_id: 'run-1' });
    await writeFile(join(f.root, 'PAUSE'), '');
    await assert.rejects(() => main(args, f.gh, worker, f.options), /PAUSE/);
    assert.equal(writes, 0);
  } finally { await f.cleanup(); }
});
