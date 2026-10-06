import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from '../worker.mjs';

const dispatch = { request_id: 'emma:12:aaaaaaaaaaaa', repo: 'startupsandcode/astra-lab',
  parent_issue: 21, first_actionable_issue: 22, brief_id: 'emma-2026-09',
  brief_digest: 'a'.repeat(64), candidate_id: 'b', approved_at: '2026-09-29T13:00:00Z' };
const sha = 'abc'.padEnd(40, '0');
const otherSha = 'def'.padEnd(40, '0');
const comment = body => ({ body, author: { login: 'startupsandcode' } });
const dispatchBody = `<!-- dispatch-ready:${dispatch.request_id} -->\n\`\`\`json\n${JSON.stringify(dispatch)}\n\`\`\``;

function result(stage, status, extra = {}) {
  return { request_id: dispatch.request_id, stage, status, issue: 22,
    pr: null, question_id: null, question: null, category: 'routine', evidence: [], reviewed_sha: null, ...extra };
}

function fixture() {
  const comments = [comment(dispatchBody)];
  const issues = new Map([
    [21, { number: 21, body: `<!-- emma-ticket:${dispatch.request_id}:parent -->\nApproved parent` }],
    [22, { number: 22, title: 'Build smallest release for #21',
      body: `<!-- emma-ticket:${dispatch.request_id}:build -->\nParent #21; opportunity #12.\n\nApproved implementation issue` }],
  ]);
  const gh = {
    prs: new Map(),
    getIssue: async number => issues.get(number),
    listComments: async () => [...comments],
    comment: async (_number, body) => { comments.push(comment(body)); },
    getPr: async number => gh.prs.get(number) ?? null,
  };
  const codex = { replies: [], calls: [], runRole: async options => {
    codex.calls.push(options);
    return codex.replies.shift();
  } };
  const workspaces = { ensure: async () => '/tmp/astra-worktree', dirty: async () => false,
    head: async () => sha };
  return { gh, codex, workspaces, worker: new Worker({ gh, codex, workspaces }), comments, issues };
}

test('Maya intake then Sam draft PR then Quinn independent review', async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', 'done'), result('sam', 'ready_for_review', { pr: 44 }),
    result('quinn', 'done', { pr: 44, reviewed_sha: sha, evidence: [`Reviewed SHA ${sha}`] }));
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: sha, issue: 22 });
  assert.equal((await f.worker.advance(dispatch)).status, 'progress');
  assert.equal((await f.worker.advance(dispatch)).status, 'ready_for_review');
  assert.equal((await f.worker.advance(dispatch)).status, 'ready_for_review');
  assert.deepEqual(f.codex.calls.map(call => call.role), ['maya', 'sam', 'quinn']);
  assert.equal(f.codex.calls[2].readOnly, true);
  const review = f.comments.find(c => c.body.includes('village-stage-result:') && c.body.includes('"stage":"quinn"'));
  assert.equal(JSON.parse(review.body.split('\n', 2)[1]).reviewed_sha, sha);
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
  f.comments.push(comment('<!-- emma-answer:q-7 -->\n' + JSON.stringify({
    request_id: dispatch.request_id, issue: 22, category: 'routine', brief_basis: 'Approved buyer',
    status: 'answered', answer: 'Use the approved buyer copy', question_id: 'q-7' })));
  assert.equal((await f.worker.advance(dispatch)).status, 'progress');
  assert.deepEqual(f.codex.calls.map(call => call.role), ['maya', 'maya']);
});

test('Quinn routine rejection routes back to Sam', async () => {
  const f = fixture();
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: sha, issue: 22 });
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
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: sha, issue: 22 });
  f.codex.replies.push(result('maya', 'done'), result('sam', 'ready_for_review', { pr: 44 }),
    result('quinn', 'done', { pr: 44, reviewed_sha: otherSha }));
  await f.worker.advance(dispatch);
  await f.worker.advance(dispatch);
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal(f.comments.filter(item => item.body.includes(`"reviewed_sha":"${otherSha}"`)).length, 0);
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
  f.comments.push(comment('<!-- emma-john-decision:q-7 -->\n' + JSON.stringify({
    request_id: dispatch.request_id, issue: 22,
    question_id: 'q-7', status: 'approved', answer: 'Approve smaller scope', category: 'scope' })));
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

const stageBody = (kind, index, value) =>
  `<!-- village-stage-${kind}:${dispatch.request_id}:${index} -->\n${JSON.stringify(value)}`;
const answerBody = (status = 'answered', extra = {}) => '<!-- emma-answer:q-7 -->\n' + JSON.stringify({
  request_id: dispatch.request_id, issue: 22, question_id: 'q-7', category: 'routine',
  status, answer: 'Use approved buyer copy', brief_basis: 'Brief buyer choice', ...extra });
const johnBody = (extra = {}) => '<!-- emma-john-decision:q-7 -->\n' + JSON.stringify({
  request_id: dispatch.request_id, issue: 22, question_id: 'q-7', category: 'routine',
  status: 'approved', answer: 'John approves this decision', ...extra });

test('progress resumes the same role for Maya, Sam and Quinn', async () => {
  const f = fixture();
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: sha, issue: 22 });
  f.codex.replies.push(result('maya', 'progress'), result('maya', 'done'),
    result('sam', 'progress', { evidence: ['Implemented first acceptance criterion'] }),
    result('sam', 'ready_for_review', { pr: 44 }), result('quinn', 'progress', { pr: 44 }),
    result('quinn', 'done', { pr: 44, reviewed_sha: sha }));
  for (let i = 0; i < 6; i++) assert.notEqual((await f.worker.advance(dispatch)).status, 'blocked');
  assert.deepEqual(f.codex.calls.map(call => call.role), ['maya', 'maya', 'sam', 'sam', 'quinn', 'quinn']);
  assert.ok(f.codex.calls[3].prompt.includes('Implemented first acceptance criterion'));
  assert.ok(f.codex.calls[5].prompt.includes(sha));
});

for (const direct of [true, false]) test(`routine ${direct ? 'needs_john' : 'Emma escalation'} waits for John`, async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', direct ? 'needs_john' : 'needs_emma', {
    question_id: 'q-7', question: 'Which buyer copy?' }), result('maya', 'done'));
  await f.worker.advance(dispatch);
  f.comments.push(comment(answerBody(direct ? 'answered' : 'needs_john')));
  assert.equal((await f.worker.advance(dispatch)).status, 'needs_john');
  assert.equal(f.codex.calls.length, 1);
  f.comments.push(comment(johnBody()));
  assert.equal((await f.worker.advance(dispatch)).status, 'progress');
  assert.ok(f.codex.calls[1].prompt.includes('John approves this decision'));
  assert.ok(f.codex.calls[1].prompt.includes('Use approved buyer copy'));
});

test('John rejection keeps a routine escalation blocked on every replay', async () => {
  const f = fixture();
  f.codex.replies.push(result('maya', 'needs_john', { question_id: 'q-7', question: 'Decide copy' }));
  await f.worker.advance(dispatch);
  f.comments.push(comment(johnBody({ status: 'rejected', answer: 'Do not proceed' })));
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal(f.codex.calls.length, 1);
});

test('resumed Sam receives validated answer, prior Quinn evidence and PR identity', async () => {
  const f = fixture();
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: sha, issue: 22 });
  f.codex.replies.push(result('maya', 'done'), result('sam', 'ready_for_review', { pr: 44 }),
    result('quinn', 'blocked', { pr: 44, evidence: ['Recover malformed-input handling'] }),
    result('sam', 'needs_emma', { pr: 44, question_id: 'q-7', question: 'Use buyer copy?' }),
    result('sam', 'ready_for_review', { pr: 44 }));
  for (let i = 0; i < 4; i++) await f.worker.advance(dispatch);
  f.comments.push(comment(answerBody()));
  assert.equal((await f.worker.advance(dispatch)).status, 'ready_for_review');
  const prompt = f.codex.calls.at(-1).prompt;
  for (const evidence of ['Use approved buyer copy', 'Recover malformed-input handling', sha,
    'https://github.com/startupsandcode/astra-lab/pull/44']) assert.ok(prompt.includes(evidence));
});

test('cached Quinn approval is checked against the live PR on every retry', async () => {
  const f = fixture();
  f.gh.prs.set(44, { number: 44, isDraft: true, headRefOid: sha, issue: 22 });
  f.codex.replies.push(result('maya', 'done'), result('sam', 'ready_for_review', { pr: 44 }),
    result('quinn', 'done', { pr: 44, reviewed_sha: sha }));
  for (let i = 0; i < 3; i++) await f.worker.advance(dispatch);
  assert.equal((await f.worker.advance(dispatch)).status, 'ready_for_review');
  f.gh.prs.get(44).headRefOid = otherSha;
  assert.match((await f.worker.advance(dispatch)).reason, /cached Quinn/);
  assert.equal(f.codex.calls.length, 3);
});

test('stored results require valid schema and dispatch binding before replay', async () => {
  for (const mutation of [value => ({ ...value, issue: 99 }), value => ({ ...value, extra: true }),
    value => ({ ...value, request_id: 'emma:12:bbbbbbbbbbbb' }),
    value => ({ ...value, reviewed_sha: 'abc' }), value => ({ ...value, evidence: 'unchecked' })]) {
    const f = fixture();
    f.comments.push(comment(stageBody('start', 0, { stage: 'maya', issue: 22, host: null })),
      comment(stageBody('result', 0, mutation(result('maya', 'done')))));
    assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
    assert.equal(f.codex.calls.length, 0);
  }
});

test('illegal stored transitions and reordered events cannot resume', async () => {
  for (const entries of [
    [stageBody('start', 0, { stage: 'sam', issue: 22, host: null }), stageBody('result', 0, result('sam', 'progress'))],
    [stageBody('result', 0, result('maya', 'done')), stageBody('start', 0, { stage: 'maya', issue: 22, host: null })],
    [stageBody('start', 0, { stage: 'maya', issue: 22, host: null }), stageBody('result', 0, result('maya', 'progress')),
      stageBody('start', 1, { stage: 'sam', issue: 22, host: null }), stageBody('result', 1, result('sam', 'progress'))],
  ]) {
    const f = fixture();
    f.comments.push(...entries.map(comment));
    assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
    assert.equal(f.codex.calls.length, 0);
  }
});

test('dispatch and actionable issue are revalidated before a new stage', async () => {
  for (const mutate of [f => { f.comments[0].author.login = 'someone-else'; },
    f => { f.issues.get(22).body = 'Unrelated issue with no dispatch binding'; },
    f => { f.issues.get(22).body = f.issues.get(22).body.replace('Parent #21', 'Parent #99'); },
    f => { f.issues.get(22).title = 'Unrelated delivery task'; }]) {
    const f = fixture();
    mutate(f);
    assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
    assert.equal(f.codex.calls.length, 0);
  }
});

test('forged or mismatched answer, decision and stage records fail closed', async () => {
  for (const entry of [
    { ...comment(johnBody()), author: { login: 'someone-else' } },
    comment(johnBody({ request_id: 'emma:99:aaaaaaaaaaaa' })),
    comment(johnBody({ answer: '' })), comment(johnBody({ issue: 99 })),
    comment(johnBody({ extra: 'fake' })),
    { ...comment(johnBody()), url: 'https://github.com/other/repo/issues/21#issuecomment-1' },
    { ...comment(answerBody()), author: { login: 'someone-else' } },
  ]) {
    const f = fixture();
    f.codex.replies.push(result('maya', 'needs_john', { question_id: 'q-7', question: 'Choose copy' }));
    await f.worker.advance(dispatch);
    f.comments.push(entry);
    assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
    assert.equal(f.codex.calls.length, 1);
  }
  const f = fixture();
  f.comments.push({ ...comment(stageBody('start', 0, { stage: 'maya', issue: 22, host: null })),
    author: { login: 'someone-else' } }, comment(stageBody('result', 0, result('maya', 'done'))));
  assert.equal((await f.worker.advance(dispatch)).status, 'blocked');
  assert.equal(f.codex.calls.length, 0);
});
