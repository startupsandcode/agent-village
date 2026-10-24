import assert from 'node:assert/strict';
import test from 'node:test';
import { MissionCodexHandlers } from '../mission-codex.mjs';

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
  assert.equal(calls[3].readOnly, true);
  assert.deepEqual(calls[3].images, ['C:/evidence/desktop.png', 'C:/evidence/narrow.png']);
  assert.equal(visual.rendered.previewUrl, mission.destination);
  assert.equal(visual.output.decision, 'approved');
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
