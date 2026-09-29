import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from '../worker.mjs';

const dispatch = { request_id: 'emma:12:aaaaaaaaaaaa', repo: 'startupsandcode/astra-lab',
  parent_issue: 21, first_actionable_issue: 22, brief_id: 'emma-2026-09',
  brief_digest: 'a'.repeat(64), candidate_id: 'b', approved_at: '2026-09-29T13:00:00Z' };

function result(stage, status, extra = {}) {
  return { request_id: dispatch.request_id, stage, status, issue: 22,
    pr: null, question_id: null, question: null, category: 'routine', evidence: [], ...extra };
}

function fixture() {
  const comments = [];
  const gh = {
    prs: new Map(),
    getIssue: async number => ({ number, body: 'Approved implementation issue' }),
    listComments: async () => [...comments],
    comment: async (_number, body) => { comments.push({ body }); },
    getPr: async number => gh.prs.get(number) ?? null,
  };
  const codex = { replies: [], calls: [], runRole: async options => {
    codex.calls.push(options);
    return codex.replies.shift();
  } };
  const workspaces = { ensure: async () => '/tmp/astra-worktree', dirty: async () => false,
    head: async () => 'abc' };
  return { gh, codex, workspaces, worker: new Worker({ gh, codex, workspaces }), comments };
}

test('Maya intake then Sam draft PR then Quinn independent review', async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', 'done'), result('sam', 'ready_for_review', { pr: 44 }),
    result('quinn', 'done', { pr: 44, reviewed_sha: 'abc', evidence: ['Reviewed SHA abc'] }));
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: 'abc', issue: 22 });
  assert.equal((await f.worker.advance(dispatch)).status, 'progress');
  assert.equal((await f.worker.advance(dispatch)).status, 'ready_for_review');
  assert.equal((await f.worker.advance(dispatch)).status, 'ready_for_review');
  assert.deepEqual(f.codex.calls.map(call => call.role), ['maya', 'sam', 'quinn']);
  assert.equal(f.codex.calls[2].readOnly, true);
  const review = f.comments.find(c => c.body.includes('village-stage-result:') && c.body.includes('"stage":"quinn"'));
  assert.equal(JSON.parse(review.body.split('\n', 2)[1]).reviewed_sha, 'abc');
});

test('claimed PR must exist', async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', 'done'), result('sam', 'ready_for_review', { pr: 44 }));
  await f.worker.advance(dispatch);
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
});

test('malformed role output cannot advance state', async () => {
  const f = fixture();
  f.codex.replies.push({ status: 'done' });
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
});

test('unfinished stage after interruption stops without overwriting work', async () => {
  const f = fixture();
  f.codex.runRole = async () => { throw new Error('interrupted'); };
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  f.codex.runRole = async () => { throw new Error('must not restart'); };
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal(f.comments.filter(c => c.body.includes('village-stage-start:')).length, 1);
});

test('dirty issue worktree stops a new stage and preserves files', async () => {
  const f = fixture();
  f.workspaces.dirty = async () => true;
  f.codex.replies.push(result('maya', 'done'));
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal(f.codex.calls.length, 0);
});

test('material spending or outreach question goes to John', async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', 'needs_john', { question_id: 'q-7',
    question: 'Buy a metered API?', category: 'spend' }));
  assert.equal((await f.worker.advance(dispatch)).status, 'needs_john');
  assert.equal(f.comments.filter(c => c.body.includes('village-question:')).length, 1);
});

test('Emma answer resumes Maya from the durable question trail', async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', 'needs_emma', { question_id: 'q-7',
    question: 'Which copy?', category: 'routine' }), result('maya', 'done'));
  assert.equal((await f.worker.advance(dispatch)).status, 'needs_emma');
  assert.equal((await f.worker.advance(dispatch)).status, 'needs_emma');
  f.comments.push({ body: '<!-- emma-answer:q-7 -->\n' + JSON.stringify({
    status: 'answered', answer: 'Use the approved buyer copy', question_id: 'q-7' }) });
  assert.equal((await f.worker.advance(dispatch)).status, 'progress');
  assert.deepEqual(f.codex.calls.map(call => call.role), ['maya', 'maya']);
});

test('Quinn routine rejection routes back to Sam', async () => {
  const f = fixture();
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: 'abc', issue: 22 });
  f.codex.replies.push(result('maya', 'done'), result('sam', 'ready_for_review', { pr: 44 }),
    result('quinn', 'blocked', { pr: 44, evidence: ['Failing edge case'] }),
    result('sam', 'ready_for_review', { pr: 44 }));
  await f.worker.advance(dispatch);
  await f.worker.advance(dispatch);
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal((await f.worker.advance(dispatch)).status, 'ready_for_review');
  assert.deepEqual(f.codex.calls.map(call => call.role), ['maya', 'sam', 'quinn', 'sam']);
});

test('Quinn cannot approve a different current PR head than the one she reviewed', async () => {
  const f = fixture();
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: 'abc', issue: 22 });
  f.codex.replies.push(result('maya', 'done'), result('sam', 'ready_for_review', { pr: 44 }),
    result('quinn', 'done', { pr: 44, reviewed_sha: 'def' }));
  await f.worker.advance(dispatch);
  await f.worker.advance(dispatch);
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal(f.comments.filter(item => item.body.includes('"reviewed_sha":"def"')).length, 0);
});

test('lost question comment is reconstructed from durable stage result', async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', 'needs_emma', { question_id: 'q-7',
    question: 'Which approved copy?', category: 'routine' }));
  const original = f.gh.comment;
  f.gh.comment = async (number, body) => {
    if (body.includes('village-question:')) throw new Error('lost question write');
    await original(number, body);
  };
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  f.gh.comment = original;
  assert.equal((await f.worker.advance(dispatch)).status, 'needs_emma');
  assert.equal(f.comments.filter(item => item.body.includes('village-question:')).length, 1);
  assert.equal(f.codex.calls.length, 1);
});

test('explicit John decision resumes a material question, while rejection blocks', async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', 'needs_john', { question_id: 'q-7',
    question: 'Change scope?', category: 'scope' }), result('maya', 'done'));
  assert.equal((await f.worker.advance(dispatch)).status, 'needs_john');
  assert.equal((await f.worker.advance(dispatch)).status, 'needs_john');
  f.comments.push({ body: '<!-- emma-john-decision:q-7 -->\n' + JSON.stringify({
    question_id: 'q-7', status: 'approved', answer: 'Approve smaller scope', category: 'scope' }) });
  assert.equal((await f.worker.advance(dispatch)).status, 'progress');
  assert.deepEqual(f.codex.calls.map(call => call.role), ['maya', 'maya']);
});

test('host switch during Codex stage stops before result write', async () => {
  const f = fixture();
  let checks = 0;
  f.worker.authorize = async () => { if (++checks === 2) throw new Error('active host changed'); };
  f.codex.replies.push(result('maya', 'done'));
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal(f.comments.filter(item => item.body.includes('village-stage-result:')).length, 0);
});
