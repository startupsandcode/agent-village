import assert from 'node:assert/strict';
import test from 'node:test';
import { rehearse } from '../rehearsal.mjs';

const dispatch = { request_id: 'emma:12:aaaaaaaaaaaa', repo: 'startupsandcode/astra-lab',
  parent_issue: 21, first_actionable_issue: 22, brief_id: 'emma-2026-09',
  brief_digest: 'a'.repeat(64), candidate_id: 'b', approved_at: '2026-09-29T13:00:00Z' };

test('offline rehearsal emits the trusted worker trail with zero-based synthetic-host starts', async () => {
  const priorHost = process.env.EMMA_HOST_ID;
  try {
    process.env.EMMA_HOST_ID = 'existing-host';
    const output = await rehearse(dispatch);
    assert.equal(process.env.EMMA_HOST_ID, 'existing-host');
    assert.deepEqual(output.statuses, ['needs_emma', 'needs_emma', 'progress',
      'ready_for_review', 'blocked', 'ready_for_review', 'ready_for_review']);
    assert.equal(output.duplicate_question_count, 1);
    assert.equal(output.interrupted_state, 'blocked');
    assert.equal(output.reviewed_sha, 'abcdef123456'.padEnd(40, '0'));
    assert.ok(output.comments.every(item => item.author.login === 'startupsandcode'));
    assert.ok(output.comments.every(item => /^https:\/\/github\.com\/startupsandcode\/astra-lab\/issues\/21#issuecomment-[1-9]\d*$/.test(item.url)));
    const starts = output.comments.filter(item => item.body.startsWith('<!-- village-stage-start:'));
    assert.equal(starts.length, 6);
    starts.forEach((item, index) => {
      assert.ok(item.body.startsWith(`<!-- village-stage-start:${dispatch.request_id}:${index} -->\n`));
      assert.equal(JSON.parse(item.body.split('\n')[1]).host, 'synthetic-host');
    });
    const result = output.comments.findLast(item => item.body.startsWith('<!-- village-stage-result:'));
    assert.equal(JSON.parse(result.body.split('\n')[1]).reviewed_sha, output.reviewed_sha);
    delete process.env.EMMA_HOST_ID;
    await rehearse(dispatch);
    assert.equal(process.env.EMMA_HOST_ID, undefined);
  } finally {
    if (priorHost === undefined) delete process.env.EMMA_HOST_ID;
    else process.env.EMMA_HOST_ID = priorHost;
  }
});
