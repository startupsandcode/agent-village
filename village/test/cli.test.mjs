import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../cli.mjs';

const request = 'emma:12:aaaaaaaaaaaa';
const issue = { number: 21, body: 'Selected', comments: [{ body:
  `<!-- dispatch-ready:${request} -->\n\`\`\`json\n${JSON.stringify({
    request_id: request, repo: 'startupsandcode/astra-lab', parent_issue: 21,
    brief_id: 'emma-2026-09', brief_digest: 'a'.repeat(64), candidate_id: 'b',
    approved_at: '2026-09-29T13:00:00Z', first_actionable_issue: 22,
  })}\n\`\`\`` }] };

test('run accepts only a matching approved dispatch', async () => {
  const gh = { getIssue: async () => issue };
  const result = await main(['run', '--repo', 'startupsandcode/astra-lab', '--issue', '21',
    '--request-id', request], gh);
  assert.equal(result.status, 'accepted');
  await assert.rejects(() => main(['run', '--repo', 'startupsandcode/astra-lab', '--issue', '21',
    '--request-id', 'emma:12:bbbbbbbbbbbb'], gh), /request ID/);
});

test('run rejects a wrong repository before reading GitHub', async () => {
  const gh = { getIssue: async () => { throw new Error('should not read'); } };
  await assert.rejects(() => main(['run', '--repo', 'other/repo', '--issue', '21',
    '--request-id', request], gh), /repository/);
});
