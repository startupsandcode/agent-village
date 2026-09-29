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
