import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MissionRunner, MissionStore } from '../mission-runner.mjs';

const goal = 'Build a polished volunteer signup preview';
const missionInput = { id: 'mission-46', repo: 'startupsandcode/agent-village', goal,
  destination: 'preview:volunteer-signup', artifactId: 'artifact-46',
  team: { id: 'single-design-led-team', roles: { design: 'susie', build: 'sam',
    functional_review: 'quinn', visual_review: 'susie' } }, constraints: ['No paid services'],
  maxAttempts: 2, maxRevisions: 2 };
const roles = ['susie_design', 'sam_implementation', 'quinn_functional', 'susie_visual'];
const rendered = { artifactId: 'artifact-46', destination: missionInput.destination,
  previewUrl: 'https://preview.invalid/mission-46', desktop: { passed: true, evidenceRef: 'browser-check://desktop' },
  narrow: { passed: true, evidenceRef: 'browser-check://narrow' }, screenshotRef: 'image://rendered-preview' };

async function fixture(t, input = missionInput) {
  const root = await mkdtemp(join(tmpdir(), 'village-missions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MissionStore(root);
  const mission = await store.create(input);
  const runner = new MissionRunner(store, { verifyRenderedEvidence: async ({ mission, rendered: evidence }) => ({
    verified: true, artifactId: mission.artifactId, destination: mission.destination,
    previewUrl: evidence.previewUrl, screenshotRef: evidence.screenshotRef,
  }) });
  return { root, store, mission, runner };
}

function successfulHandlers(overrides = {}) {
  return Object.fromEntries(roles.map(stage => [stage, async () => ({
    status: 'done', evidence: [`${stage} checked the assigned work`], artifactId: 'artifact-46',
    ...(stage === 'susie_visual' ? { rendered } : {}),
  })]).map(([stage, handler]) => [stage, overrides[stage] ?? handler]));
}

test('mission lifecycle records durable ordered evidence before accepting tested preview', async t => {
  const f = await fixture(t);
  const result = await f.runner.run(f.mission.id, successfulHandlers());
  assert.equal(result.status, 'accepted_preview');
  assert.deepEqual(result.events.filter(event => event.status === 'done').map(event => event.stage), roles);
  const reopened = new MissionStore(f.root);
  assert.deepEqual(await reopened.get(f.mission.id), result);
});

test('stage failure is checkpointed and retries only up to the configured attempt limit', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const handlers = successfulHandlers({ susie_design: async () => {
    attempts++;
    const error = new Error('designer runtime failed');
    error.retryable = true;
    throw error;
  } });
  const result = await f.runner.run(f.mission.id, handlers);
  assert.equal(result.status, 'failed');
  assert.equal(attempts, 2);
  assert.equal(result.events.filter(event => event.stage === 'susie_design').length, 2);
  assert.equal(result.events.at(-1).error, 'designer runtime failed');
});

test('non-retryable stage failure blocks ordinary resume from replaying uncertain work', async t => {
  const f = await fixture(t);
  let designs = 0;
  const first = successfulHandlers({ susie_design: async () => {
    designs++;
    throw new Error('uncertain stage failure');
  } });
  const paused = await f.runner.run(f.mission.id, first);
  assert.equal(paused.status, 'blocked');
  const resumed = await f.runner.run(f.mission.id, successfulHandlers(first));
  assert.equal(resumed.status, 'blocked');
  assert.equal(designs, 1);
  assert.match(resumed.error, /uncertain stage failure/);
});

test('visual review loops through implementation and functional checks within revision cap', async t => {
  const f = await fixture(t);
  const calls = [];
  const handlers = successfulHandlers({
    sam_implementation: async () => { calls.push('sam'); return { status: 'done', evidence: ['Build'], artifactId: 'artifact-46' }; },
    quinn_functional: async () => { calls.push('quinn'); return { status: 'done', evidence: ['Tests pass'], artifactId: 'artifact-46' }; },
    susie_visual: async ({ revision }) => {
      calls.push('susie');
      return revision === 0 ? { status: 'needs_revision', evidence: ['Improve mobile hierarchy'], artifactId: 'artifact-46', rendered } :
        { status: 'done', evidence: ['Rendered mobile and desktop reviewed'], artifactId: 'artifact-46', rendered };
    },
  });
  const result = await f.runner.run(f.mission.id, handlers);
  assert.equal(result.status, 'accepted_preview');
  assert.deepEqual(calls, ['sam', 'quinn', 'susie', 'sam', 'quinn', 'susie']);
  assert.equal(result.revisions, 1);
});

test('visual revisions cannot exceed the configured cap', async t => {
  const f = await fixture(t);
  const result = await f.runner.run(f.mission.id, successfulHandlers({
    susie_visual: async () => ({ status: 'needs_revision', evidence: ['Needs correction'], artifactId: 'artifact-46', rendered }),
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.revisions, 2);
  assert.match(result.error, /revision limit/);
});

test('cancellation is honored at a stage boundary and retained durably', async t => {
  const f = await fixture(t);
  const handlers = successfulHandlers({ susie_design: async () => {
    await f.store.cancel(f.mission.id);
    return { status: 'done', evidence: ['Guide saved'], artifactId: 'artifact-46' };
  } });
  const result = await f.runner.run(f.mission.id, handlers);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.events.filter(event => event.status === 'done').length, 1);
});

test('duplicate concurrent execution is rejected while a mission is active', async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const handlers = successfulHandlers({ susie_design: async () => {
    entered();
    await gate;
    return { status: 'done', evidence: ['Guide saved'], artifactId: 'artifact-46' };
  } });
  const first = f.runner.run(f.mission.id, handlers);
  await started;
  await assert.rejects(f.runner.run(f.mission.id, successfulHandlers()), /already running/);
  release();
  assert.equal((await first).status, 'accepted_preview');
});

test('existing stale lock is never reclaimed implicitly', async t => {
  const f = await fixture(t);
  const lockPath = join(f.root, 'mission-46.jsonl.lock');
  const contents = JSON.stringify({ token: 'stale-owner' });
  await writeFile(lockPath, contents);
  await assert.rejects(f.store.claim(f.mission.id), /manual recovery/);
  assert.equal(await readFile(lockPath, 'utf8'), contents);
});

test('cancellation requires an existing mission and cannot leave a ghost cancel marker', async t => {
  const f = await fixture(t);
  const futureId = 'future-mission';
  await assert.rejects(f.store.cancel(futureId), /mission not found/);
  assert.equal(await f.store.isCancelled(futureId), false);
  const future = await f.store.create({ ...missionInput, id: futureId });
  assert.equal(await f.store.isCancelled(future.id), false);
});

test('revision requests from design, build, or functional review are blocked', async t => {
  for (const stage of ['susie_design', 'sam_implementation', 'quinn_functional']) {
    const f = await fixture(t);
    const handlers = successfulHandlers({ [stage]: async () => ({ status: 'needs_revision',
      evidence: ['Request to revise'], artifactId: 'artifact-46' }) });
    const result = await f.runner.run(f.mission.id, handlers);
    assert.equal(result.status, 'blocked', stage);
    assert.match(result.error, /only visual review/);
    assert.equal(result.events.filter(event => event.status === 'needs_revision').length, 0);
  }
});

test('journal rejects forged out-of-order stages, revisions, attempts, and replayed running states', async t => {
  const corruptions = [
    state => ({ ...state, currentStage: 'sam_implementation' }),
    state => ({ ...state, currentStage: 'sam_implementation', revisions: 1 }),
    state => ({ ...state, attempts: { '0:susie_design': 1 } }),
    state => ({ ...state, status: 'accepted_preview' }),
  ];
  for (const corrupt of corruptions) {
    const f = await fixture(t);
    const altered = corrupt(await f.store.get(f.mission.id));
    await appendFile(join(f.root, 'mission-46.jsonl'), `${JSON.stringify(altered)}\n`);
    await assert.rejects(f.store.get(f.mission.id), /invalid mission checkpoint/);
  }

  const f = await fixture(t);
  const initial = await f.store.get(f.mission.id);
  const running = { ...initial, status: 'running', attempts: { '0:susie_design': 1 },
    inFlight: { stage: 'susie_design', attempt: 1 } };
  await appendFile(join(f.root, 'mission-46.jsonl'), `${JSON.stringify(running)}\n`);
  const outOfOrder = { ...running, status: 'ready', currentStage: 'quinn_functional', inFlight: null,
    events: [{ stage: 'susie_design', revision: 0, attempt: 1, status: 'done',
      evidence: ['Guide written'], artifactId: 'artifact-46' }] };
  await appendFile(join(f.root, 'mission-46.jsonl'), `${JSON.stringify(outOfOrder)}\n`);
  await assert.rejects(f.store.get(f.mission.id), /invalid mission checkpoint/);

  const revision = await fixture(t);
  const ready = await revision.store.get(revision.mission.id);
  const designRunning = { ...ready, status: 'running', attempts: { '0:susie_design': 1 },
    inFlight: { stage: 'susie_design', attempt: 1 } };
  await appendFile(join(revision.root, 'mission-46.jsonl'), `${JSON.stringify(designRunning)}\n`);
  const forgedRevision = { ...designRunning, status: 'ready', currentStage: 'sam_implementation', inFlight: null,
    events: [{ stage: 'susie_design', revision: 0, attempt: 1, status: 'needs_revision',
      evidence: ['Revise this design'], artifactId: 'artifact-46' }] };
  await appendFile(join(revision.root, 'mission-46.jsonl'), `${JSON.stringify(forgedRevision)}\n`);
  await assert.rejects(revision.store.get(revision.mission.id), /invalid mission checkpoint/);

  const replay = await fixture(t);
  const first = await replay.store.get(replay.mission.id);
  const inFlight = { ...first, status: 'running', attempts: { '0:susie_design': 1 },
    inFlight: { stage: 'susie_design', attempt: 1 } };
  await appendFile(join(replay.root, 'mission-46.jsonl'), `${JSON.stringify(inFlight)}\n`);
  await appendFile(join(replay.root, 'mission-46.jsonl'), `${JSON.stringify(inFlight)}\n`);
  await assert.rejects(replay.store.get(replay.mission.id), /invalid mission checkpoint/);
});

test('interrupted in-flight checkpoint recovers as blocked without replaying uncertain work', async t => {
  const f = await fixture(t);
  const state = await f.store.get(f.mission.id);
  state.status = 'running';
  state.inFlight = { stage: 'susie_design', attempt: 1 };
  state.attempts['0:susie_design'] = 1;
  await f.store.save(state);
  await writeFile(join(f.root, 'mission-46.jsonl.lock'), JSON.stringify({
    token: 'dead-process',
  }));
  let calls = 0;
  const handlers = Object.fromEntries(roles.map(stage => [stage, async () => {
    calls++;
    return { status: 'done', evidence: ['unexpected replay'], artifactId: 'artifact-46',
      ...(stage === 'susie_visual' ? { rendered } : {}) };
  }]));
  await assert.rejects(f.runner.run(f.mission.id, handlers), /manual recovery/);
  assert.equal(calls, 0);
  await unlink(join(f.root, 'mission-46.jsonl.lock'));
  const result = await f.runner.run(f.mission.id, handlers);
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /outcome is uncertain/);
  assert.equal(calls, 0);
});

test('an incomplete final journal append recovers to the last durable checkpoint', async t => {
  const f = await fixture(t);
  await appendFile(join(f.root, 'mission-46.jsonl'), '{"version":1,"id":"partial');
  const recovered = await f.store.get(f.mission.id);
  assert.deepEqual(recovered, f.mission);
  const saved = await f.store.save(recovered);
  assert.deepEqual(await f.store.get(f.mission.id), saved);
});

test('mismatched artifacts, missing acceptance evidence, and unknown checkpoint schemas fail closed', async t => {
  const f = await fixture(t);
  const changedArtifact = await f.runner.run(f.mission.id, successfulHandlers({ susie_design: async () => ({
    status: 'done', evidence: ['Guide saved'], artifactId: 'some-other-site',
  }) }));
  assert.equal(changedArtifact.status, 'blocked');
  assert.match(changedArtifact.error, /artifact identity/);

  const g = await fixture(t);
  const missingFunctional = await g.runner.run(g.mission.id, successfulHandlers({ quinn_functional: async () => ({
    status: 'done', evidence: [], artifactId: 'artifact-46',
  }) }));
  assert.equal(missingFunctional.status, 'blocked');
  assert.match(missingFunctional.error, /evidence/);

  const noVerifier = await fixture(t);
  noVerifier.runner = new MissionRunner(noVerifier.store);
  const unavailableReview = await noVerifier.runner.run(noVerifier.mission.id, successfulHandlers());
  assert.equal(unavailableReview.status, 'blocked');
  assert.match(unavailableReview.error, /verifier unavailable/);

  const h = await fixture(t);
  await writeFile(join(h.root, 'mission-46.jsonl'), '{"version":2,"status":"accepted_preview"}\n');
  await assert.rejects(h.runner.run(h.mission.id, successfulHandlers()), /invalid mission checkpoint/);
});

