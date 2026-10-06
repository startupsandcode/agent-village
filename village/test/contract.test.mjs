import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseDispatch, validateResult } from '../contract.mjs';

function validIssue() {
  const dispatch = {
    request_id: 'emma:12:aaaaaaaaaaaa', repo: 'startupsandcode/astra-lab',
    parent_issue: 21, brief_id: 'emma-2026-09', brief_digest: 'a'.repeat(64),
    candidate_id: 'b', approved_at: '2026-09-29T13:00:00+00:00',
    first_actionable_issue: 22,
  };
  return { number: 21, body: 'Selected project',
    comments: [{ author: { login: 'startupsandcode' },
      url: 'https://github.com/startupsandcode/astra-lab/issues/21#issuecomment-1',
      body: `<!-- dispatch-ready:${dispatch.request_id} -->\n\`\`\`json\n${JSON.stringify(dispatch)}\n\`\`\`` }] };
}

function validResult() {
  return { request_id: 'emma:12:aaaaaaaaaaaa', stage: 'maya', status: 'progress',
    issue: 22, pr: null, question_id: null, question: null, category: 'routine', evidence: [], reviewed_sha: null };
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
  issue.comments[0].url = 'https://github.com/startupsandcode/astra-lab/issues/99#issuecomment-1';
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
    pr: 44, reviewed_sha: 'a'.repeat(40) }).reviewed_sha, 'a'.repeat(40));
});

test('dispatch refuses untrusted authors, foreign provenance and unknown fields', () => {
  for (const mutate of [issue => { issue.comments[0].author.login = 'someone-else'; },
    issue => { delete issue.comments[0].author; },
    issue => { issue.comments[0].url = 'https://github.com/other/repo/issues/21#issuecomment-1'; },
    issue => { issue.comments[0].body = issue.comments[0].body.replace('"repo":', '"extra":true,"repo":'); }]) {
    const issue = validIssue();
    mutate(issue);
    assert.throws(() => parseDispatch(issue), /author|provenance|schema/);
  }
});

test('durable dispatch records require canonical comment URLs', () => {
  for (const url of [undefined, null, '', 'https://github.com/startupsandcode/astra-lab/issues/99#issuecomment-1']) {
    const issue = validIssue();
    issue.comments[0].url = url;
    assert.throws(() => parseDispatch(issue), /provenance/);
  }
});

test('dispatch timestamp must be a real calendar time with a timezone', () => {
  for (const invalid of ['September 29, 2026', '2026-09-29T13:00:00',
    '2026-02-30T13:00:00Z', '2026-09-29T24:00:00Z']) {
    const issue = validIssue();
    issue.comments[0].body = issue.comments[0].body.replace('2026-09-29T13:00:00+00:00', invalid);
    assert.throws(() => parseDispatch(issue), /approved_at/);
  }
});

test('structured output schema requires every property, including reviewed_sha', async () => {
  const schema = JSON.parse(await readFile(new URL('../role-result.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.equal(schema.additionalProperties, false);
  const missing = validResult();
  delete missing.reviewed_sha;
  assert.throws(() => validateResult(missing), /schema/);
  assert.throws(() => validateResult({ ...validResult(), stage: 'quinn', status: 'done',
    pr: 44, reviewed_sha: 'abc' }), /reviewed_sha/);
});

test('roles cannot claim another role completion status', () => {
  for (const [stage, status] of [['maya', 'ready_for_review'], ['sam', 'done'], ['quinn', 'ready_for_review']]) {
    assert.throws(() => validateResult({ ...validResult(), stage, status, pr: 44 }), /transition/);
  }
});
