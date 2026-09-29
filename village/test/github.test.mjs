import assert from 'node:assert/strict';
import test from 'node:test';
import { VillageGh } from '../github.mjs';

test('reads a parent issue and comments from the scoped Astra repository', async () => {
  const calls = [];
  const run = async args => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify({ number: 21, body: 'Selected',
      comments: [{ body: 'approved' }] }) };
  };
  const gh = new VillageGh({ run });
  assert.equal((await gh.getIssue(21)).number, 21);
  assert.ok(calls[0].includes('startupsandcode/astra-lab'));
});

test('malformed or mismatched GitHub issue data stops', async () => {
  const broken = new VillageGh({ run: async () => ({ status: 0, stdout: '{' }) });
  await assert.rejects(() => broken.getIssue(21), /JSON/);
  const mismatch = new VillageGh({ run: async () => ({ status: 0, stdout: '{"number":22,"body":"x","comments":[]}' }) });
  await assert.rejects(() => mismatch.getIssue(21), /number/);
});

test('reviewed work reads a real PR and posts scoped evidence', async () => {
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args.includes('comment')) return { status: 0, stdout: 'https://github.com/startupsandcode/astra-lab/issues/21#issuecomment-123' };
    if (args.includes('pr')) return { status: 0, stdout: JSON.stringify({ number: 44,
      isDraft: true, headRefOid: 'abc', body: 'Closes #22' }) };
    return { status: 0, stdout: JSON.stringify({ number: 21, body: 'Selected',
      comments: [{ body: 'stage event' }] }) };
  };
  const gh = new VillageGh({ run });
  assert.equal((await gh.getPr(44)).number, 44);
  assert.equal((await gh.listComments(21))[0].body, 'stage event');
  await gh.comment(21, 'stage event');
  assert.ok(calls.every(args => args.includes('startupsandcode/astra-lab')));
});
