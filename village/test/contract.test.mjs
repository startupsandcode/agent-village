import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDispatch, validateResult } from '../contract.mjs';

function validIssue() {
  const dispatch = {
    request_id: 'emma:12:aaaaaaaaaaaa', repo: 'startupsandcode/astra-lab',
    parent_issue: 21, brief_id: 'emma-2026-09', brief_digest: 'a'.repeat(64),
    candidate_id: 'b', approved_at: '2026-09-29T13:00:00+00:00',
    first_actionable_issue: 22,
  };
  return { number: 21, body: 'Selected project',
    comments: [{ body: `<!-- dispatch-ready:${dispatch.request_id} -->\n\`\`\`json\n${JSON.stringify(dispatch)}\n\`\`\`` }] };
}

function validResult() {
  return { request_id: 'emma:12:aaaaaaaaaaaa', stage: 'maya', status: 'progress',
    issue: 22, pr: null, question_id: null, question: null, category: 'routine', evidence: [] };
}

test('accepts one approved Astra dispatch', () => {
  assert.equal(parseDispatch(validIssue()).first_actionable_issue, 22);
});

test('rejects missing approval marker', () => {
  const issue = validIssue();
  issue.comments = [];
  assert.throws(() => parseDispatch(issue), /dispatch/);
});

test('rejects wrong repository and duplicate dispatch comments', () => {
  const issue = validIssue();
  issue.comments[0].body = issue.comments[0].body.replace('startupsandcode/astra-lab', 'other/repo');
  assert.throws(() => parseDispatch(issue), /repo/);
  const duplicate = validIssue();
  duplicate.comments.push(duplicate.comments[0]);
  assert.throws(() => parseDispatch(duplicate), /duplicate/);
});

test('rejects issue number mismatch and malformed request ID', () => {
  const issue = validIssue();
  issue.number = 99;
  assert.throws(() => parseDispatch(issue), /parent_issue/);
  const malformed = validIssue();
  malformed.comments[0].body = malformed.comments[0].body.replace('aaaaaaaaaaaa', 'invalid');
  assert.throws(() => parseDispatch(malformed), /request_id|dispatch/);
});

test('question requires stable id', () => {
  const result = { ...validResult(), status: 'needs_emma', question: 'Which copy?', question_id: '' };
  assert.throws(() => validateResult(result), /question_id/);
});

test('non-routine question cannot be answered by Emma alone', () => {
  const result = { ...validResult(), status: 'needs_emma', question: 'Buy API?',
    question_id: 'q-7', category: 'spend' };
  assert.throws(() => validateResult(result), /needs_john|blocked/);
});

test('rejects invalid status and malformed PR reference', () => {
  assert.throws(() => validateResult({ ...validResult(), status: 'released' }), /status/);
  assert.throws(() => validateResult({ ...validResult(), pr: '44' }), /pr/);
});

test('accepts a bounded progress result', () => {
  assert.equal(validateResult(validResult()).status, 'progress');
});

test('Quinn done must attest the exact reviewed SHA', () => {
  assert.throws(() => validateResult({ ...validResult(), stage: 'quinn', status: 'done', pr: 44 }), /reviewed_sha/);
  assert.equal(validateResult({ ...validResult(), stage: 'quinn', status: 'done',
    pr: 44, reviewed_sha: 'abcdef123456' }).reviewed_sha, 'abcdef123456');
});
