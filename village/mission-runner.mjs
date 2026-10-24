import { mkdir, open, readFile, readdir, truncate, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const REPO = 'startupsandcode/agent-village';
const stages = ['susie_design', 'sam_implementation', 'quinn_functional', 'susie_visual'];
const stageNames = new Set(stages);
const terminal = new Set(['accepted_preview', 'cancelled', 'blocked']);
const idPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;
export const MAX_MISSION_ROLE_CALLS = 8;

function roleCallsUsed(state) {
  return (state.mayaIntakeCalls ?? 1) + Object.values(state.attempts).reduce((total, attempt) => total + attempt, 0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateEvidence(evidence) {
  assert(Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 24 &&
    evidence.every(item => typeof item === 'string' && item.trim() && item.length <= 1000), 'stage evidence required');
  return evidence.map(item => item.trim());
}

function validateStageOutput(stage, status, output) {
  assert(output && typeof output === 'object' && !Array.isArray(output), 'stage deliverable required');
  if (stage === 'susie_design') {
    const guide = output.kind === 'design_guide' && output.guide;
    assert(guide && typeof guide === 'object' && typeof guide.concept === 'string' && guide.concept.trim().length >= 30 &&
      Array.isArray(guide.sections) && guide.sections.length >= 3 && guide.sections.every(item => typeof item === 'string' && item.trim()) &&
      Array.isArray(guide.typeScale) && guide.typeScale.length >= 3 && guide.typeScale.every(item => typeof item === 'string' && item.trim()) &&
      Array.isArray(guide.spacing) && guide.spacing.length >= 4 && guide.spacing.every(item => Number.isSafeInteger(item) && item > 0) &&
      Array.isArray(guide.responsiveStates) && guide.responsiveStates.length >= 2 && guide.responsiveStates.every(item => typeof item === 'string' && item.trim()) &&
      typeof guide.imagery?.direction === 'string' && guide.imagery.direction.trim() &&
      typeof guide.imagery?.sourceRequirements === 'string' && guide.imagery.sourceRequirements.trim() &&
      typeof guide.imagery?.altStrategy === 'string' && guide.imagery.altStrategy.trim() &&
      Array.isArray(guide.interactions) && guide.interactions.length >= 2 && guide.interactions.every(item => typeof item === 'string' && item.trim()) &&
      Array.isArray(guide.references) && guide.references.every(item => typeof item === 'string' && item.trim()),
    'Susie design guide is incomplete');
    assert(JSON.stringify(output).length <= 24000, 'design guide exceeds the mission limit');
  } else if (stage === 'sam_implementation') {
    assert(output.kind === 'implementation' && typeof output.previewUrl === 'string' &&
      /^https?:\/\//.test(output.previewUrl), 'Sam must provide a preview URL');
  } else if (stage === 'quinn_functional') {
    assert(output.kind === 'functional_review' && Array.isArray(output.checks) && output.checks.length > 0 &&
      output.checks.every(check => typeof check === 'string' && check.trim()), 'Quinn functional checks required');
  } else {
    assert(output.kind === 'visual_review' &&
      output.decision === (status === 'done' ? 'approved' : 'revise') &&
      Array.isArray(output.findings) && output.findings.every(item => typeof item === 'string'),
    'Susie visual decision does not match the mission stage outcome');
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateTransition(previous, next) {
  const immutable = ['version', 'id', 'repo', 'goal', 'acceptanceCriteria', 'mayaAgreement', 'destination',
    'artifactId', 'team', 'constraints', 'maxAttempts', 'maxRevisions', 'createdAt', 'mayaIntakeCalls'];
  if (previous.version >= 3) immutable.push('workspaceBranch');
  assert(immutable.every(key => same(previous[key], next[key])), 'invalid mission checkpoint transition');
  const unchanged = ['currentStage', 'revisions', 'events', 'attempts', 'inFlight', 'error'];
  const stageKey = `${previous.revisions}:${previous.currentStage}`;
  const prevAttempt = previous.attempts[stageKey] ?? 0;
  const nextAttempt = next.attempts[stageKey] ?? 0;
  const attemptDelta = nextAttempt - prevAttempt;
  const attemptKeys = new Set([...Object.keys(previous.attempts), ...Object.keys(next.attempts)]);
  assert([...attemptKeys].every(key => key === stageKey ||
    (previous.attempts[key] ?? 0) === (next.attempts[key] ?? 0)), 'invalid mission checkpoint transition');

  if (attemptDelta === 1) {
    assert(['ready', 'failed'].includes(previous.status) && previous.inFlight === null &&
      next.status === 'running' && next.currentStage === previous.currentStage &&
      next.revisions === previous.revisions && same(next.events, previous.events) &&
      next.inFlight?.stage === previous.currentStage && next.inFlight.attempt === nextAttempt &&
      nextAttempt <= previous.maxAttempts && next.error === previous.error,
    'invalid mission checkpoint transition');
    return;
  }
  assert(attemptDelta === 0, 'invalid mission checkpoint transition');

  const eventDelta = next.events.length - previous.events.length;
  assert(eventDelta === 0 || eventDelta === 1, 'invalid mission checkpoint transition');
  if (eventDelta === 1) {
    assert(previous.status === 'running' && previous.inFlight?.stage === previous.currentStage &&
      previous.inFlight.attempt === prevAttempt && nextAttempt === prevAttempt &&
      same(next.events.slice(0, -1), previous.events), 'invalid mission checkpoint transition');
    const event = next.events.at(-1);
    assert(event.stage === previous.currentStage && event.revision === previous.revisions &&
      event.attempt === prevAttempt, 'invalid mission checkpoint transition');
    if (event.status === 'failed') {
      assert(typeof event.retryable === 'boolean' && next.currentStage === previous.currentStage &&
        next.revisions === previous.revisions &&
        (event.retryable && next.status === 'failed' && next.inFlight === null ||
          !event.retryable && next.status === 'blocked' && same(next.inFlight, previous.inFlight)) && next.error === event.error,
      'invalid mission checkpoint transition');
      return;
    }
    if (next.status === 'cancelled') {
      assert(next.currentStage === previous.currentStage && next.revisions === previous.revisions &&
        next.inFlight === null, 'invalid mission checkpoint transition');
      return;
    }
    assert(next.inFlight === null, 'invalid mission checkpoint transition');
    if (event.status === 'needs_revision') {
      assert(event.stage === 'susie_visual', 'invalid mission checkpoint transition');
      if (previous.revisions < previous.maxRevisions) {
        assert(next.status === 'ready' && next.currentStage === 'sam_implementation' &&
          next.revisions === previous.revisions + 1 && next.error === null,
        'invalid mission checkpoint transition');
      } else {
        assert(next.status === 'failed' && next.currentStage === previous.currentStage &&
          next.revisions === previous.revisions && next.error === 'revision limit reached',
        'invalid mission checkpoint transition');
      }
      return;
    }
    if (previous.currentStage === 'susie_visual') {
      assert(next.status === 'accepted_preview' && next.error === null && next.currentStage === previous.currentStage &&
        next.revisions === previous.revisions && acceptsPreview(next), 'invalid mission checkpoint transition');
    } else {
      assert(next.status === 'ready' && next.error === null &&
        next.currentStage === stages[stages.indexOf(previous.currentStage) + 1] &&
        next.revisions === previous.revisions, 'invalid mission checkpoint transition');
    }
    return;
  }

  if (previous.status === 'running' && next.status === 'cancelled') {
    assert(next.currentStage === previous.currentStage && next.revisions === previous.revisions &&
      same(next.events, previous.events) && same(next.attempts, previous.attempts) &&
      previous.inFlight && next.inFlight === null && next.error === null,
    'invalid mission checkpoint transition');
    return;
  }

  if (previous.status === 'running') {
    assert(next.status === 'blocked' && next.currentStage === previous.currentStage &&
      next.revisions === previous.revisions && same(next.events, previous.events) &&
      same(next.attempts, previous.attempts) && previous.inFlight && next.inFlight === null &&
      typeof next.error === 'string', 'invalid mission checkpoint transition');
    return;
  }
  if (previous.status === 'ready' && next.status === 'cancelled') {
    assert(unchanged.every(key => same(previous[key], next[key])), 'invalid mission checkpoint transition');
    return;
  }
  if (previous.status === 'ready' && next.status === 'blocked') {
    assert(next.currentStage === previous.currentStage && next.revisions === previous.revisions &&
      same(next.events, previous.events) && same(next.attempts, previous.attempts) && next.inFlight === null &&
      next.error === `mission reached the ${MAX_MISSION_ROLE_CALLS}-call Codex CLI limit`,
    'invalid mission checkpoint transition');
    return;
  }
  if (previous.status === 'failed' && next.status === 'ready') {
    assert(next.currentStage === previous.currentStage && next.revisions === previous.revisions &&
      same(next.events, previous.events) && same(next.attempts, previous.attempts) &&
      next.inFlight === null && next.error === null, 'invalid mission checkpoint transition');
    return;
  }
  if (previous.status === 'failed' && next.status === 'failed') {
    assert(next.currentStage === previous.currentStage && next.revisions === previous.revisions &&
      same(next.events, previous.events) && same(next.attempts, previous.attempts) &&
      next.inFlight === null && next.error === `attempt limit reached for ${previous.currentStage}`,
    'invalid mission checkpoint transition');
    return;
  }
  assert(unchanged.every(key => same(previous[key], next[key])) && previous.status === next.status,
    'invalid mission checkpoint transition');
}

function validateState(value, id) {
  const stateKeys = ['version', 'id', 'repo', 'goal', 'acceptanceCriteria', 'mayaAgreement', 'destination', 'artifactId', 'team', 'constraints',
    'maxAttempts', 'maxRevisions', 'revisions', 'status', 'currentStage', 'events', 'attempts', 'inFlight',
    'error', 'createdAt', 'updatedAt'];
  if (value?.version === 3) stateKeys.push('workspaceBranch');
  if (value?.version === 4) stateKeys.push('workspaceBranch', 'mayaIntakeCalls');
  assert(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === stateKeys.length && stateKeys.every(key => Object.hasOwn(value, key)) &&
    [2, 3, 4].includes(value.version) && value.id === id && value.repo === REPO &&
    typeof value.goal === 'string' && value.goal.trim() &&
    Array.isArray(value.acceptanceCriteria) && value.acceptanceCriteria.length >= 3 &&
    value.acceptanceCriteria.every(item => typeof item === 'string' && item.trim()) &&
    value.mayaAgreement && value.mayaAgreement.acceptedByUser === true &&
    typeof value.mayaAgreement.proposalId === 'string' && value.mayaAgreement.proposalId.trim() &&
    typeof value.mayaAgreement.acceptedAt === 'string' && typeof value.mayaAgreement.summary === 'string' &&
    value.mayaAgreement.goal === value.goal &&
    same(value.mayaAgreement.acceptanceCriteria, value.acceptanceCriteria) &&
    value.mayaAgreement.repo === value.repo && same(value.mayaAgreement.constraints, value.constraints) &&
    same(value.mayaAgreement.team, value.team) && value.mayaAgreement.destination === value.destination &&
    value.mayaAgreement.artifactId === value.artifactId &&
    (value.version === 2 || typeof value.workspaceBranch === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value.workspaceBranch) &&
      value.mayaAgreement.workspaceBranch === value.workspaceBranch) &&
    typeof value.destination === 'string' && value.destination.trim() &&
    typeof value.artifactId === 'string' && value.artifactId.trim() &&
    value.team && Object.keys(value.team).length === 2 && Object.hasOwn(value.team, 'id') &&
    Object.hasOwn(value.team, 'roles') && typeof value.team.id === 'string' && value.team.id.trim() &&
    value.team.roles &&
    Object.keys(value.team.roles).length === 4 &&
    value.team.roles.design === 'susie' && value.team.roles.build === 'sam' &&
    value.team.roles.functional_review === 'quinn' && value.team.roles.visual_review === 'susie' &&
    ['ready', 'running', 'failed', 'accepted_preview', 'cancelled', 'blocked'].includes(value.status) &&
    stageNames.has(value.currentStage) && Number.isSafeInteger(value.revisions) && value.revisions >= 0 &&
    Number.isSafeInteger(value.maxRevisions) && value.maxRevisions >= 0 &&
    Number.isSafeInteger(value.maxAttempts) && value.maxAttempts >= 1 && value.maxAttempts <= 5 &&
    (value.version !== 4 || Number.isSafeInteger(value.mayaIntakeCalls) && value.mayaIntakeCalls >= 1 &&
      value.mayaIntakeCalls <= MAX_MISSION_ROLE_CALLS) &&
    Array.isArray(value.constraints) && value.constraints.every(item => typeof item === 'string') &&
    Array.isArray(value.events) && value.events.every(event => event && stageNames.has(event.stage) &&
      Number.isSafeInteger(event.revision) && Number.isSafeInteger(event.attempt) &&
      ['done', 'needs_revision', 'failed'].includes(event.status) && Array.isArray(event.evidence)) &&
    value.attempts && typeof value.attempts === 'object' && !Array.isArray(value.attempts) &&
    Object.entries(value.attempts).every(([key, attempt]) => {
      const match = /^(\d+):([a-z_]+)$/.exec(key);
      return match && stageNames.has(match[2]) && Number(match[1]) <= value.maxRevisions &&
        Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= value.maxAttempts;
    }) &&
    (value.inFlight === null || value.inFlight && Object.keys(value.inFlight).length === 2 &&
      stageNames.has(value.inFlight.stage) && Number.isSafeInteger(value.inFlight.attempt)) &&
    (value.error === null || typeof value.error === 'string') &&
    typeof value.createdAt === 'string' && typeof value.updatedAt === 'string', 'invalid mission checkpoint');
  assert(value.events.every(event => {
    if (!event || !stageNames.has(event.stage) || !Number.isSafeInteger(event.revision) ||
        !Number.isSafeInteger(event.attempt) || !['done', 'needs_revision', 'failed'].includes(event.status) ||
        !Array.isArray(event.evidence)) return false;
    if (event.status === 'failed') return Object.keys(event).length === 7 &&
      Object.keys(event).every(key => ['stage', 'revision', 'attempt', 'status', 'evidence', 'error', 'retryable'].includes(key)) &&
      typeof event.error === 'string' && typeof event.retryable === 'boolean' && event.evidence.length === 0;
    if (event.status === 'needs_revision' && event.stage !== 'susie_visual') return false;
    if (event.evidence.length === 0 || event.evidence.length > 24 ||
        event.evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000) ||
        event.artifactId !== value.artifactId) return false;
    if (event.stage !== 'susie_visual') return Object.keys(event).length === 7 &&
      (() => { try { validateStageOutput(event.stage, event.status, event.output); return true; } catch { return false; } })();
    try { validateStageOutput(event.stage, event.status, event.output); } catch { return false; }
    return Object.keys(event).length === 9 && event.rendered?.artifactId === value.artifactId &&
      event.rendered?.destination === value.destination && typeof event.rendered?.previewUrl === 'string' &&
      event.rendered.desktop?.passed === true && typeof event.rendered.desktop.evidenceRef === 'string' &&
      event.rendered.narrow?.passed === true && typeof event.rendered.narrow.evidenceRef === 'string' &&
      typeof event.rendered.screenshotRef === 'string' && event.renderVerification?.verified === true &&
      event.renderVerification.artifactId === value.artifactId &&
      event.renderVerification.destination === value.destination &&
      event.renderVerification.previewUrl === event.rendered.previewUrl &&
      event.renderVerification.screenshotRef === event.rendered.screenshotRef;
  }), 'invalid mission checkpoint');
  assert(value.events.filter(event => event.stage === 'susie_design' && event.status === 'done').length <= 1,
    'invalid mission checkpoint');
  if (value.status === 'accepted_preview') assert(acceptsPreview(value), 'invalid mission checkpoint');
  return value;
}

export class MissionStore {
  constructor(root) {
    if (!root) throw new Error('mission store path required');
    this.root = resolve(root);
  }

  path(id) {
    if (!idPattern.test(id)) throw new Error('invalid mission id');
    return join(this.root, `${id}.jsonl`);
  }

  async create(input) {
    assert(input && input.repo === REPO, 'mission must target startupsandcode/agent-village');
    const id = input.id;
    const path = this.path(id);
    assert(typeof input.goal === 'string' && input.goal.trim(), 'mission goal required');
    const acceptanceCriteria = input.acceptanceCriteria;
    assert(Array.isArray(acceptanceCriteria) && acceptanceCriteria.length >= 3 &&
      acceptanceCriteria.every(item => typeof item === 'string' && item.trim()), 'Maya acceptance criteria required');
    assert(typeof input.destination === 'string' && input.destination.trim(), 'preview destination required');
    let destinationUrl;
    try { destinationUrl = new URL(input.destination.trim()); } catch { throw new Error('preview destination must be an absolute HTTP URL'); }
    assert(['http:', 'https:'].includes(destinationUrl.protocol) && !destinationUrl.username && !destinationUrl.password &&
      !destinationUrl.search && !destinationUrl.hash,
    'preview destination must be an HTTP URL without credentials, query, or fragment');
    assert(typeof input.artifactId === 'string' && input.artifactId.trim(), 'artifact identity required');
    const maxAttempts = input.maxAttempts ?? 2;
    const maxRevisions = input.maxRevisions ?? 2;
    const mayaIntakeCalls = input.mayaIntakeCalls ?? 1;
    assert(Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 5, 'maxAttempts must be 1-5');
    assert(Number.isSafeInteger(maxRevisions) && maxRevisions >= 0 && maxRevisions <= 3, 'maxRevisions must be 0-3');
    assert(Number.isSafeInteger(mayaIntakeCalls) && mayaIntakeCalls >= 1 && mayaIntakeCalls <= MAX_MISSION_ROLE_CALLS,
      `Maya intake calls must be 1-${MAX_MISSION_ROLE_CALLS}`);
    const constraints = input.constraints ?? [];
    assert(Array.isArray(constraints) && constraints.every(item => typeof item === 'string'), 'invalid mission constraints');
    const team = input.team;
    assert(team && typeof team.id === 'string' && team.id.trim() && team.roles &&
      Object.keys(team).length === 2 && Object.keys(team.roles).length === 4 &&
      team.roles.design === 'susie' && team.roles.build === 'sam' &&
      team.roles.functional_review === 'quinn' && team.roles.visual_review === 'susie',
    'mission team role configuration required');
    const agreement = input.mayaAgreement;
    assert(agreement && agreement.acceptedByUser === true && typeof agreement.proposalId === 'string' &&
      agreement.proposalId.trim() && typeof agreement.summary === 'string' && agreement.summary.trim() &&
      agreement.goal === input.goal.trim() && same(agreement.acceptanceCriteria, acceptanceCriteria) &&
      agreement.destination === input.destination.trim() && agreement.artifactId === input.artifactId.trim() &&
      agreement.repo === input.repo && same(agreement.constraints, input.constraints ?? []) && same(agreement.team, team) &&
      typeof input.workspaceBranch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.workspaceBranch) &&
      agreement.workspaceBranch === input.workspaceBranch &&
      typeof agreement.acceptedAt === 'string' && Number.isFinite(Date.parse(agreement.acceptedAt)),
    'a user-accepted Maya agreement for this exact mission is required');
    const state = { version: 4, workspaceBranch: input.workspaceBranch, mayaIntakeCalls,
      id, repo: REPO, goal: input.goal.trim(), acceptanceCriteria: [...acceptanceCriteria],
      mayaAgreement: structuredClone(agreement), destination: input.destination.trim(),
      artifactId: input.artifactId.trim(), team: structuredClone(team), constraints: [...constraints], maxAttempts, maxRevisions,
      revisions: 0, status: 'ready', currentStage: 'susie_design', events: [], attempts: {}, inFlight: null,
      error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await mkdir(this.root, { recursive: true });
    try {
      const handle = await open(path, 'wx');
      try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('mission already exists');
      throw error;
    }
    return state;
  }

  async get(id) {
    let source;
    try { source = await readFile(this.path(id), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('mission not found');
      throw error;
    }
    const lines = source.split(/\r?\n/);
    if (!source.endsWith('\n')) lines.pop();
    const completed = lines.filter(Boolean);
    if (!completed.length) throw new Error('invalid mission checkpoint');
    let value;
    let previous = null;
    for (const line of completed) {
      try { value = JSON.parse(line); }
      catch { throw new Error('invalid mission checkpoint'); }
      validateState(value, id);
      if (previous) {
        const immutableKeys = ['version', 'id', 'repo', 'goal', 'acceptanceCriteria', 'mayaAgreement', 'destination', 'artifactId', 'team',
          'constraints', 'maxAttempts', 'maxRevisions', 'createdAt'];
        if (previous.version >= 3) immutableKeys.push('workspaceBranch');
        for (const key of immutableKeys) {
          if (JSON.stringify(value[key]) !== JSON.stringify(previous[key])) throw new Error('invalid mission checkpoint');
        }
        if (value.events.length < previous.events.length ||
            previous.events.some((event, index) => JSON.stringify(value.events[index]) !== JSON.stringify(event))) {
          throw new Error('invalid mission checkpoint');
        }
        validateTransition(previous, value);
      } else {
        assert(value.status === 'ready' && value.currentStage === 'susie_design' &&
          value.revisions === 0 && value.events.length === 0 && Object.keys(value.attempts).length === 0 &&
          value.inFlight === null && value.error === null, 'invalid mission checkpoint');
      }
      previous = value;
    }
    return value;
  }

  async list() {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const ids = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(entry => entry.name.slice(0, -6)).filter(id => idPattern.test(id)).sort();
    const states = [];
    for (const id of ids) states.push(await this.get(id));
    return states.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async save(state) {
    validateState(state, state.id);
    await mkdir(this.root, { recursive: true });
    const path = this.path(state.id);
    const previous = await this.get(state.id);
    validateTransition(previous, state);
    let journal = await readFile(path, 'utf8');
    if (!journal.endsWith('\n')) {
      const end = journal.lastIndexOf('\n');
      if (end < 0) throw new Error('invalid mission checkpoint');
      await truncate(path, Buffer.byteLength(journal.slice(0, end + 1), 'utf8'));
    }
    const next = { ...state, updatedAt: new Date().toISOString() };
    const handle = await open(path, 'a');
    try { await handle.write(`${JSON.stringify(next)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    return next;
  }

  async cancel(id) {
    await this.get(id);
    await mkdir(this.root, { recursive: true });
    const path = `${this.path(id)}.cancel`;
    try { const handle = await open(path, 'wx'); await handle.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  async isCancelled(id) {
    try { await readFile(`${this.path(id)}.cancel`); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async claim(id) {
    await mkdir(this.root, { recursive: true });
    const path = `${this.path(id)}.lock`;
    const token = randomUUID();
    let handle;
    try { handle = await open(path, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error('mission already running; stale locks require manual recovery after confirming the owner exited');
      }
      throw error;
    }
    try { await handle.writeFile(JSON.stringify({ token })); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
    return { handle, path, token };
  }
}

function nextStage(stage) {
  return stages[stages.indexOf(stage) + 1] ?? null;
}

function latestDoneFor(state, stage) {
  return state.events.findLast(event => event.stage === stage && event.revision === state.revisions && event.status === 'done');
}

function acceptsPreview(state) {
  const design = state.events.find(event => event.stage === 'susie_design' && event.status === 'done');
  const visual = latestDoneFor(state, 'susie_visual');
  return Boolean(design && latestDoneFor(state, 'sam_implementation') &&
    latestDoneFor(state, 'quinn_functional') && visual?.renderVerification?.verified === true &&
    visual.renderVerification.artifactId === state.artifactId &&
    visual.renderVerification.destination === state.destination && visual.rendered?.screenshotRef);
}

export class MissionRunner {
  constructor(store, { verifyRenderedEvidence = null } = {}) {
    this.store = store;
    this.verifyRenderedEvidence = verifyRenderedEvidence;
  }

  async run(id, handlers) {
    const lock = await this.store.claim(id);
    try {
      let state = await this.store.get(id);
      if (terminal.has(state.status)) return state;
      if (state.status === 'failed') {
        const lastFailure = state.events.findLast(event => event.stage === state.currentStage &&
          event.revision === state.revisions && event.status === 'failed');
        const key = `${state.revisions}:${state.currentStage}`;
        if (!lastFailure?.retryable || (state.attempts[key] ?? 0) >= state.maxAttempts) return state;
        state.status = 'ready';
        state.error = null;
        state = await this.store.save(state);
      }
      if (state.status === 'running' || state.inFlight) {
        state.status = 'blocked';
        state.error = 'previous stage outcome is uncertain; reconcile before resuming';
        state.inFlight = null;
        return await this.store.save(state);
      }
      if (await this.store.isCancelled(id)) {
        state.status = 'cancelled';
        return await this.store.save(state);
      }
      assert(handlers && typeof handlers === 'object', 'mission handlers required');

      for (;;) {
        if (await this.store.isCancelled(id)) {
          state.status = 'cancelled';
          state.inFlight = null;
          return await this.store.save(state);
        }
        if (roleCallsUsed(state) >= MAX_MISSION_ROLE_CALLS) {
          state.status = 'blocked';
          state.error = `mission reached the ${MAX_MISSION_ROLE_CALLS}-call Codex CLI limit`;
          return await this.store.save(state);
        }
        const stage = state.currentStage;
        const key = `${state.revisions}:${stage}`;
        const attempt = (state.attempts[key] ?? 0) + 1;
        if (attempt > state.maxAttempts) {
          state.status = 'failed';
          state.error = `attempt limit reached for ${stage}`;
          return await this.store.save(state);
        }
        assert(typeof handlers[stage] === 'function', `handler required for ${stage}`);
        state.status = 'running';
        state.attempts[key] = attempt;
        state.inFlight = { stage, attempt };
        state = await this.store.save(state);
        let outcome;
        let renderVerification = null;
        try {
          outcome = await handlers[stage]({ mission: structuredClone(state), stage,
            revision: state.revisions, attempt, isCancelled: () => this.store.isCancelled(id) });
          assert(outcome && ['done', 'needs_revision'].includes(outcome.status), 'invalid stage outcome');
          assert(outcome.status !== 'needs_revision' || stage === 'susie_visual',
            'only visual review may request a revision');
          assert(outcome.artifactId === state.artifactId, 'stage artifact identity does not match the approved mission');
          validateStageOutput(stage, outcome.status, outcome.output);
          if (stage === 'susie_visual') {
            assert(outcome.rendered && outcome.rendered.artifactId === state.artifactId &&
              outcome.rendered.destination === state.destination &&
              typeof outcome.rendered.previewUrl === 'string' && /^https?:\/\//.test(outcome.rendered.previewUrl) &&
              outcome.rendered.desktop?.passed === true && typeof outcome.rendered.desktop.evidenceRef === 'string' &&
              outcome.rendered.desktop.evidenceRef.trim() &&
              outcome.rendered.narrow?.passed === true && typeof outcome.rendered.narrow.evidenceRef === 'string' &&
              outcome.rendered.narrow.evidenceRef.trim() && typeof outcome.rendered.screenshotRef === 'string' &&
              outcome.rendered.screenshotRef.trim(), 'rendered preview evidence required for desktop and narrow viewports');
            assert(typeof this.verifyRenderedEvidence === 'function', 'rendered preview evidence verifier unavailable');
            renderVerification = await this.verifyRenderedEvidence({ mission: structuredClone(state),
              rendered: structuredClone(outcome.rendered) });
            assert(renderVerification?.verified === true && renderVerification.artifactId === state.artifactId &&
              renderVerification.destination === state.destination && renderVerification.previewUrl === outcome.rendered.previewUrl &&
              renderVerification.screenshotRef === outcome.rendered.screenshotRef,
            'rendered preview evidence verifier rejected the artifact');
          }
          outcome = { status: outcome.status, evidence: validateEvidence(outcome.evidence),
            output: structuredClone(outcome.output),
            ...(stage === 'susie_visual' ? { rendered: structuredClone(outcome.rendered) } : {}) };
        } catch (error) {
          if (await this.store.isCancelled(id)) {
            state.status = 'cancelled';
            state.inFlight = null;
            state.error = null;
            return await this.store.save(state);
          }
          const message = error instanceof Error ? error.message.slice(0, 500) : 'stage failed';
          const retryable = error?.retryable === true;
          state.events.push({ stage, revision: state.revisions, attempt, status: 'failed', evidence: [], error: message, retryable });
          if (retryable) state.inFlight = null;
          state.status = retryable ? 'failed' : 'blocked';
          state.error = message;
          state = await this.store.save(state);
          if (retryable && attempt < state.maxAttempts && !(await this.store.isCancelled(id))) {
            state.status = 'ready';
            state.error = null;
            state = await this.store.save(state);
            continue;
          }
          return state;
        }

        state.events.push({ stage, revision: state.revisions, attempt, status: outcome.status,
          evidence: outcome.evidence, artifactId: state.artifactId, output: structuredClone(outcome.output),
          ...(stage === 'susie_visual' ? { rendered: structuredClone(outcome.rendered), renderVerification } : {}) });
        state.inFlight = null;
        state.error = null;
        if (await this.store.isCancelled(id)) {
          state.status = 'cancelled';
          return await this.store.save(state);
        }
        if (stage === 'susie_visual' && outcome.status === 'needs_revision') {
          if (state.revisions >= state.maxRevisions) {
            state.status = 'failed';
            state.error = 'revision limit reached';
            return await this.store.save(state);
          }
          state.revisions += 1;
          state.currentStage = 'sam_implementation';
          state.status = 'ready';
          state = await this.store.save(state);
          continue;
        }
        if (stage === 'susie_visual' && outcome.status === 'done') {
          assert(acceptsPreview(state), 'preview acceptance requires design, implementation, functional and rendered review evidence');
          state.status = 'accepted_preview';
          return await this.store.save(state);
        }
        state.currentStage = nextStage(stage);
        state.status = 'ready';
        state = await this.store.save(state);
      }
    } finally {
      await lock.handle.close();
      try {
        const owner = JSON.parse(await readFile(lock.path, 'utf8'));
        if (owner.token === lock.token) await unlink(lock.path);
      } catch {}
    }
  }
}

