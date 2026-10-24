import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MissionCodexHandlers } from '../mission-codex.mjs';

test('strict role schema requires every property and allows null artifactPath outside Sam output', async () => {
  const schema = JSON.parse(await readFile(fileURLToPath(new URL('../mission-stage.schema.json', import.meta.url)), 'utf8'));
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
  assert.deepEqual(schema.properties.artifactPath.anyOf.map(option => option.type), ['null', 'string']);
  for (const [name, definition] of Object.entries(schema.properties)) {
    if (definition.type === 'object' && definition.properties) {
      assert.deepEqual(new Set(definition.required), new Set(Object.keys(definition.properties)), `${name} strict required fields`);
    }
  }
  assert.match(schema.properties.status.description, /Quinn uses done only when acceptance criteria pass/);
  assert.match(schema.properties.functionalChecks.description, /status alone is not a reason/);
});

const guide = { concept: 'Editorial volunteer invitation with a clear service-first composition.',
  sections: ['Hero and action', 'Opportunity details', 'Signup form'],
  typeScale: ['Display serif at 56px', 'Section heading at 32px', 'Body sans at 18px'],
  spacing: [4, 8, 16, 32],
  responsiveStates: ['At 960px, use an asymmetric two-column hero.', 'At 390px, stack content and keep the signup action visible.'],
  imagery: { direction: 'Natural documentary photography with warm light.',
    sourceRequirements: 'Use existing licensed assets only.', altStrategy: 'Describe informative images and mark decoration empty.' },
  interactions: ['Keep form labels persistent and show inline error text.', 'Use a visible focus ring and confirm successful submission.'],
  references: ['Editorial magazine hierarchy'] };
const mission = { id: 'mission-46', goal: 'Build a polished volunteer signup preview',
  acceptanceCriteria: ['The role is clear.', 'Signup works on mobile.', 'Keyboard navigation works.'],
  constraints: ['No paid resources'], repo: 'startupsandcode/agent-village',
  artifactId: 'artifact-46', destination: 'https://preview.example.test', revisions: 0,
  events: [{ stage: 'susie_design', revision: 0, status: 'done', output: { kind: 'design_guide', guide } }] };
const rendered = { artifactId: mission.artifactId, destination: mission.destination,
  previewUrl: mission.destination, desktop: { passed: true, evidenceRef: 'sha256:desktop' },
  narrow: { passed: true, evidenceRef: 'sha256:narrow' }, screenshotRef: 'C:/evidence/desktop.png' };

test('mission Codex adapters execute Susie design before Sam, then Quinn and screenshot-based Susie review', async () => {
  const calls = [];
  const responses = {
    susie_design: { stage: 'susie_design', status: 'done', artifactId: mission.artifactId,
      evidence: ['Guide covers visual hierarchy and responsive states.'], designGuide: guide,
      previewUrl: null, functionalChecks: [], visualFindings: [] },
    sam_implementation: { stage: 'sam_implementation', status: 'done', artifactId: mission.artifactId,
      evidence: ['Existing page updated and local preview started.'], designGuide: null,
      previewUrl: mission.destination, functionalChecks: [], visualFindings: [] },
    quinn_functional: { stage: 'quinn_functional', status: 'done', artifactId: mission.artifactId,
      evidence: ['Node tests were observed passing.'], designGuide: null,
      previewUrl: null, functionalChecks: ['Node test suite passed'], visualFindings: [] },
    susie_visual: { stage: 'susie_visual', status: 'done', artifactId: mission.artifactId,
      evidence: ['Both screenshots meet the design guide.'], designGuide: null,
      previewUrl: null, functionalChecks: [], visualFindings: [] },
  };
  const codex = { async runStructured(options) { calls.push(options); return responses[calls.at(-1).prompt.match(/You are (?:Susie|Sam|Quinn)/)?.[0].includes('Sam') ? 'sam_implementation' :
    options.images?.length ? 'susie_visual' : options.prompt.includes('independent read-only functional') ? 'quinn_functional' : 'susie_design']; } };
  const browserVerifier = { async capture({ mission: target, previewUrl }) {
    assert.equal(target.artifactId, mission.artifactId);
    assert.equal(previewUrl, mission.destination);
    return { rendered, captures: { desktop: { screenshotPath: 'C:/evidence/desktop.png', evidenceRef: 'sha256:desktop', metrics: { width: 1280 } },
      narrow: { screenshotPath: 'C:/evidence/narrow.png', evidenceRef: 'sha256:narrow', metrics: { width: 390 } } } };
  } };
  const adapters = new MissionCodexHandlers({ codex, workspacePath: 'C:/workspace', browserVerifier }).handlers();
  const design = await adapters.susie_design({ mission, stage: 'susie_design', revision: 0, attempt: 1 });
  const afterDesign = { ...mission, events: [...mission.events, { stage: 'susie_design', revision: 0,
    status: 'done', output: design.output }] };
  const implementation = await adapters.sam_implementation({ mission: afterDesign, stage: 'sam_implementation', revision: 0, attempt: 1 });
  const afterBuild = { ...afterDesign, events: [...afterDesign.events, { stage: 'sam_implementation', revision: 0,
    status: 'done', output: implementation.output }] };
  const functional = await adapters.quinn_functional({ mission: afterBuild, stage: 'quinn_functional', revision: 0, attempt: 1 });
  const afterFunctional = { ...afterBuild, events: [...afterBuild.events, { stage: 'quinn_functional', revision: 0,
    status: 'done', output: functional.output }] };
  const visual = await adapters.susie_visual({ mission: afterFunctional, stage: 'susie_visual', revision: 0, attempt: 1 });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].readOnly, true);
  assert.equal(calls[1].readOnly, false);
  assert.match(calls[1].prompt, /Editorial volunteer invitation/);
  assert.equal(calls[2].readOnly, true);
  assert.match(calls[2].prompt, /Set status to done only when the acceptance criteria pass/);
  assert.match(calls[2].prompt, /status alone is not a reason/);
  assert.equal(calls[3].readOnly, true);
  assert.deepEqual(calls[3].images, ['C:/evidence/desktop.png', 'C:/evidence/narrow.png']);
  assert.equal(visual.rendered.previewUrl, mission.destination);
  assert.equal(visual.output.decision, 'approved');
});

test('Quinn receives the approved criteria, local artifact path, read-only workspace, and prior browser checks', async () => {
  let received;
  const handlers = new MissionCodexHandlers({ workspacePath: 'C:/approved/worktree', codex: {
    async runStructured(options) {
      received = options;
      return { stage: 'quinn_functional', status: 'blocked', artifactId: mission.artifactId,
        evidence: ['Blocked review.'], designGuide: null, previewUrl: null, artifactPath: null,
        functionalChecks: ['Cannot verify criterion.'], visualFindings: [] };
    },
  } }).handlers();
  const reviewedMission = { ...mission, functionalReviewRecovery: { status: 'consumed',
    functionalChecks: ['HTTP 200 and exact artifact marker', 'Retry limit and status focus'] } };
  const implementation = { stage: 'sam_implementation', revision: 0, status: 'done',
    output: { kind: 'implementation', previewUrl: mission.destination } };
  await assert.rejects(handlers.quinn_functional({ mission: { ...reviewedMission,
    events: [...mission.events, implementation] }, stage: 'quinn_functional', revision: 0, attempt: 4 }));
  assert.equal(received.cwd, 'C:\\approved\\worktree');
  assert.equal(received.readOnly, true);
  assert.match(received.prompt, /validation\/mission-46\/dist/);
  assert.match(received.prompt, /Signup works on mobile/);
  assert.match(received.prompt, /HTTP 200 and exact artifact marker/);
  assert.match(received.prompt, /Retry limit and status focus/);
});

test('Sam cannot launch without Susie design checkpoint and role result must match the artifact', async () => {
  let calls = 0;
  const handler = new MissionCodexHandlers({ codex: { async runStructured() { calls++; return {}; } },
    workspacePath: 'C:/workspace' }).handlers().sam_implementation;
  await assert.rejects(handler({ mission: { ...mission, events: [] }, stage: 'sam_implementation', revision: 0 }), /design guide checkpoint/);
  assert.equal(calls, 0);

  const susie = new MissionCodexHandlers({ codex: { async runStructured() { return {
    stage: 'susie_design', status: 'done', artifactId: 'other-artifact', evidence: ['wrong artifact'], designGuide: guide,
  }; } }, workspacePath: 'C:/workspace' }).handlers().susie_design;
  await assert.rejects(susie({ mission, stage: 'susie_design', revision: 0 }), /did not match the approved artifact/);
});

function quinnFixture({ status, functionalChecks }) {
  const implementation = { stage: 'sam_implementation', revision: 0, status: 'done',
    output: { kind: 'implementation', previewUrl: mission.destination } };
  const reviewedMission = { ...mission, events: [...mission.events, implementation] };
  const result = { stage: 'quinn_functional', status, artifactId: mission.artifactId,
    evidence: ['Fixture evidence is intentionally not copied into failure diagnostics.'], designGuide: null,
    previewUrl: null, artifactPath: null, functionalChecks, visualFindings: [] };
  const handler = new MissionCodexHandlers({ codex: { async runStructured() { return result; } },
    workspacePath: 'C:/workspace' }).handlers().quinn_functional;
  return () => handler({ mission: reviewedMission, stage: 'quinn_functional', revision: 0, attempt: 1 });
}

test('Quinn non-approval retains bounded actionable checks while redacting secrets and private locations', async () => {
  const checks = ['Keyboard cancellation criterion failed: cancel stayed enabled after activation. ' +
    'Bearer secret-value https://private.example.test C:\\private\\review.txt person@example.test'];
  await assert.rejects(quinnFixture({ status: 'blocked', functionalChecks: checks }), error => {
    assert.match(error.message, /status=blocked/);
    assert.match(error.message, /Keyboard cancellation criterion failed: cancel stayed enabled/);
    assert.match(error.message, /Bearer \[redacted\]/);
    assert.match(error.message, /\[url\]/);
    assert.match(error.message, /\[path\]/);
    assert.match(error.message, /\[email\]/);
    assert.ok(error.message.length <= 500);
    assert.doesNotMatch(error.message, /Fixture evidence|intentionally/);
    assert.doesNotMatch(error.message, /secret-value|private\.example|C:\\private|person@example/);
    return true;
  });
});

test('Quinn blocked status without a reason explicitly reports the missing diagnostic', async () => {
  await assert.rejects(quinnFixture({ status: 'blocked', functionalChecks: [] }), error => {
    assert.equal(error.message, 'Quinn review did not approve (status=blocked); no actionable functionalChecks reason was returned');
    return true;
  });
});

test('Quinn invalid status diagnostics neither echo arbitrary status nor untrusted check text', async () => {
  await assert.rejects(quinnFixture({ status: 'blocked Bearer secret-token-value', functionalChecks: ['unverified'] }), error => {
    assert.equal(error.message, 'Quinn review did not approve (status=invalid); no actionable functionalChecks reason was returned');
    assert.doesNotMatch(error.message, /unverified/);
    assert.doesNotMatch(error.message, /secret-token-value/);
    return true;
  });
});

test('Quinn approval with no functional checks is distinguished from a blocked review', async () => {
  await assert.rejects(quinnFixture({ status: 'done', functionalChecks: [] }), error => {
    assert.equal(error.message, 'Quinn returned no functional checks (status=done)');
    return true;
  });
});

test('Quinn completed review carries its nonempty functional checks into the durable stage result', async () => {
  const result = await quinnFixture({ status: 'done', functionalChecks: ['preview marker matched', 'retry control works'] })();
  assert.deepEqual(result.output, { kind: 'functional_review', checks: ['preview marker matched', 'retry control works'] });
});
