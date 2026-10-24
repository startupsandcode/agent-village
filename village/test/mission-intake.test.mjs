import assert from 'node:assert/strict';
import test from 'node:test';
import { MissionStore } from '../mission-runner.mjs';
import { MayaMissionIntake } from '../mission-intake.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const team = { id: 'one-team', roles: { design: 'susie', build: 'sam',
  functional_review: 'quinn', visual_review: 'susie' } };
const input = { id: 'mission-46', repo: 'startupsandcode/agent-village',
  workspaceBranch: 'issue-46-design-led-missions',
  goal: 'Build a responsive preview for the volunteer program.', destination: 'https://preview.example.test',
  artifactId: 'volunteer-preview-46', constraints: ['No paid resources'], team };
const criteria = ['Visitors can find an opportunity.', 'The signup flow works on desktop and mobile.',
  'Keyboard users can complete and correct the signup form.'];

function fakeCodex(result) {
  const calls = [];
  return { calls, async runStructured(options) { calls.push(options); return result; } };
}

test('Maya intake pins one scoped proposal and creates a manifest only after exact user acceptance', async t => {
  const codex = fakeCodex({ status: 'agreed', summary: 'A responsive volunteer signup preview.',
    acceptanceCriteria: criteria, questions: [] });
  const intake = new MayaMissionIntake({ codex, workspacePath: process.cwd() });
  const proposal = await intake.propose(input);
  assert.equal(proposal.status, 'agreed');
  assert.equal(codex.calls.length, 1);
  assert.equal(codex.calls[0].readOnly, true);
  assert.match(codex.calls[0].prompt, /No paid resources/);
  assert.match(codex.calls[0].prompt, /Feature branch: issue-46-design-led-missions/);
  assert.throws(() => intake.accept(proposal.proposalId, 'I agree'), /exact Maya proposal/);

  const agreedInput = intake.accept(proposal.proposalId, `I agree to mission ${proposal.proposalId}`);
  const root = await mkdtemp(join(tmpdir(), 'village-intake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await new MissionStore(root).create(agreedInput);
  assert.equal(manifest.goal, input.goal);
  assert.deepEqual(manifest.acceptanceCriteria, criteria);
  assert.equal(manifest.mayaAgreement.acceptedByUser, true);
  assert.equal(manifest.mayaAgreement.destination, input.destination);
  assert.equal(manifest.workspaceBranch, input.workspaceBranch);
  assert.equal(manifest.mayaAgreement.workspaceBranch, input.workspaceBranch);
});

test('Maya questions and blocked scopes cannot be accepted into a mission', async () => {
  for (const status of ['needs_user', 'blocked']) {
    const intake = new MayaMissionIntake({ codex: fakeCodex({ status, summary: '',
      acceptanceCriteria: [], questions: ['Which existing preview destination?'] }), workspacePath: process.cwd() });
    const response = await intake.propose(input);
    assert.equal(response.status, status);
    assert.equal('proposalId' in response, false);
    assert.throws(() => intake.accept('missing', 'I agree to mission missing'), /exact Maya proposal/);
  }
});

test('intake does not accept a proposal after its destination or user constraints change', async t => {
  const intake = new MayaMissionIntake({ codex: fakeCodex({ status: 'agreed', summary: 'Bounded preview',
    acceptanceCriteria: criteria, questions: [] }), workspacePath: process.cwd() });
  const proposal = await intake.propose(input);
  const agreed = intake.accept(proposal.proposalId, `I agree to mission ${proposal.proposalId}`);
  const tampered = { ...agreed, destination: 'https://elsewhere.example' };
  const root = await mkdtemp(join(tmpdir(), 'village-intake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(new MissionStore(root).create(tampered), /exact mission/);
});
