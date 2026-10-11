import { randomUUID } from 'node:crypto';
import { artifactDigest, renderArtifact, verifyStaticSite } from './static-site.mjs';
import { MAYA, PLAN, SAM, QUINN, validPlan, validReview, validText } from './project-roles.mjs';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_PROJECTS = 20;
const MAX_CALLS = 80;
const MAX_RESERVED_MICROS = 100_000_000; // $100 per owner/month, deliberately above default-model estimate
const RESERVED_CALL_MICROS = 1_000_000; // $1 pessimistic allowance per call, not a provider bill
const STALE_MS = 90_000;

function event(project, agent, type, message, usage) {
  project.events.push({ at: new Date().toISOString(), agent, type, message: String(message).slice(0, 1200), ...(usage ? { usage } : {}) });
}
function visible(record) {
  const { files, ...project } = record.snapshot;
  return { ...project, version: record.version };
}
function requireRequestId(value) { if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new Error('Request ID required'); }
function requireProject(record) { if (!record) throw new Error('Project not found'); return record; }

export function createHostedCoordinator({ access, budget, provider, usage = null, domain = null, now = Date.now }) {
  if (!access || !budget || !provider) throw new Error('Hosted coordinator dependencies required');
  async function read(cookie, id) {
    const record = requireProject(await access.read(cookie, id));
    const project = record.snapshot;
    if (project.files && artifactDigest(project.files.html, project.files.css) !== project.artifact?.sha256) {
      const changed = structuredClone(project);
      changed.status = 'blocked'; changed.files = null; changed.artifact = null;
      event(changed, 'System', 'error', 'Stored artifact receipt failed verification.');
      return visible(await access.update(cookie, { id, expectedVersion: record.version, snapshot: changed }) || requireProject(await access.read(cookie, id)));
    }
    if (['clarifying', 'planning', 'building', 'reviewing'].includes(project.status) && now() - Date.parse(project.stageStartedAt) > STALE_MS) {
      const stale = structuredClone(project); stale.status = 'interrupted';
      event(stale, 'System', 'error', 'A hosted request stopped before it recorded a result. Inspect before starting another project.');
      return visible(await access.update(cookie, { id, expectedVersion: record.version, snapshot: stale }) || requireProject(await access.read(cookie, id)));
    }
    return visible(record);
  }
  async function reserve(cookie, id, kind) {
    const ok = await budget.reserve(cookie, { id, kind, month: new Date(now()).toISOString().slice(0, 7), maxProjects: MAX_PROJECTS, maxCalls: MAX_CALLS,
      maxReservedMicros: MAX_RESERVED_MICROS, reservedMicros: kind === 'project' ? 0 : RESERVED_CALL_MICROS });
    if (!ok) throw new Error('Monthly project or provider budget reached');
  }
  async function finish(cookie, id, expectedVersion, makeResult) {
    const fresh = requireProject(await access.read(cookie, id));
    if (fresh.version !== expectedVersion || fresh.snapshot.status === 'cancelled') return visible(fresh);
    const next = structuredClone(fresh.snapshot);
    makeResult(next);
    const saved = await access.update(cookie, { id, expectedVersion, snapshot: next });
    return visible(saved || requireProject(await access.read(cookie, id)));
  }
  async function generate(cookie, id, expectedVersion, system, input, done, agent, callId) {
    const controller = new AbortController();
    // Cancellation is durable across function instances. Polling aborts an in-flight call best-effort.
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      access.read(cookie, id).then(record => {
        if (record?.snapshot.status === 'cancelled') controller.abort();
      }).catch(() => controller.abort()).finally(() => { polling = false; });
    }, 2000);
    timer.unref?.();
    let reply, failure, began = false;
    try {
      if (usage) {
        await usage.begin(cookie, { callId, projectId: id, agent, provider: provider.name, model: provider.model,
          month: new Date(now()).toISOString().slice(0, 7) });
        began = true;
      }
      reply = await provider.generate({ system, input: JSON.stringify(input), signal: controller.signal });
    } catch (error) { failure = error; }
    try {
      if (began) await usage.complete(cookie, callId, provider.name, provider.model, reply?.usage ?? failure?.usage);
      try {
        if (failure) throw failure;
        return await finish(cookie, id, expectedVersion, project => done(project, reply));
      } catch (error) {
        return await finish(cookie, id, expectedVersion, project => {
          project.status = 'blocked';
          event(project, agent, 'error', provider.redact?.(error.message) ?? 'Provider request failed');
        });
      }
    } finally { clearInterval(timer); }
  }
  async function advance(cookie, id, requestId, from, to, agent, message, kind, prepare = () => {}) {
    requireRequestId(requestId);
    const record = requireProject(await access.read(cookie, id));
    const project = record.snapshot;
    if (project[`${kind}RequestId`] === requestId) return { duplicate: true, record };
    if (project.status !== from) throw new Error('Action not expected');
    await reserve(cookie, id, kind);
    const next = structuredClone(project);
    next.status = to; next.stageStartedAt = new Date(now()).toISOString(); next[`${kind}RequestId`] = requestId;
    prepare(next);
    event(next, agent, 'start', message);
    const saved = await access.update(cookie, { id, expectedVersion: record.version, snapshot: next });
    if (!saved) return { duplicate: true, record: requireProject(await access.read(cookie, id)) };
    return { duplicate: false, record: saved };
  }
  return {
    read,
    async start(cookie, goal, requestId) {
      requireRequestId(requestId);
      if (!validText(goal) || provider.containsSecret?.(goal)) throw new Error('Goal invalid or contains a provider key');
      const id = randomUUID();
      await reserve(cookie, requestId, 'project');
      const domainProfile = domain ? await domain.read(cookie) : { audience: '', expertise: '', rules: '' };
      const project = { id, goal: goal.trim(), domainProfile, answer: null, plan: null, artifact: null, files: null, status: 'clarifying', events: [], createdAt: new Date(now()).toISOString(), stageStartedAt: new Date(now()).toISOString(), createRequestId: requestId };
      if (Object.values(domainProfile).some(Boolean)) event(project, 'System', 'context', 'Saved domain answers attached to Maya, Sam, and Quinn for this project');
      event(project, 'Maya', 'start', 'Reading the project goal');
      const stored = await access.create(cookie, { id, requestId, snapshot: project });
      return visible(stored);
    },
    async clarify(cookie, id) {
      const current = await read(cookie, id);
      if (current.status !== 'clarifying' || current.clarifyRunId) return current;
      // Charge the month in which a provider call actually starts, not the
      // month in which a user created a project that might wait overnight.
      await reserve(cookie, id, 'clarify');
      const record = requireProject(await access.read(cookie, id));
      if (record.snapshot.status !== 'clarifying' || record.snapshot.clarifyRunId) return visible(record);
      const next = structuredClone(record.snapshot);
      next.clarifyRunId = randomUUID(); next.stageStartedAt = new Date(now()).toISOString();
      const claimed = await access.update(cookie, { id, expectedVersion: record.version, snapshot: next });
      if (!claimed) return visible(requireProject(await access.read(cookie, id)));
      return generate(cookie, id, claimed.version, MAYA, { goal: next.goal, domainProfile: next.domainProfile }, (updated, reply) => {
        if (!validText(reply.result?.question, 300)) throw new Error('Maya returned an invalid question');
        updated.status = 'needs_answer'; event(updated, 'Maya', 'question', reply.result.question, reply.usage);
      }, 'Maya', `${id}:clarify:${next.clarifyRunId}`);
    },
    async create(cookie, goal, requestId) {
      const started = await this.start(cookie, goal, requestId);
      return started.status === 'clarifying' ? this.clarify(cookie, started.id) : started;
    },
    async answer(cookie, id, answer, requestId) {
      if (!validText(answer) || provider.containsSecret?.(answer)) throw new Error('Answer invalid or contains a provider key');
      const step = await advance(cookie, id, requestId, 'needs_answer', 'planning', 'Maya', 'Planning from the answer', 'answer', next => {
        next.answer = answer.trim(); event(next, 'User', 'answer', next.answer);
      });
      if (step.duplicate) return visible(step.record);
      const current = step.record.snapshot;
      return generate(cookie, id, step.record.version, PLAN, { goal: current.goal, answer, domainProfile: current.domainProfile }, (next, reply) => {
        if (!validPlan(reply.result)) throw new Error('Maya returned an invalid plan');
        next.plan = reply.result; next.status = 'ready';
        event(next, 'Maya', 'decision', next.plan.decision, reply.usage); event(next, 'Maya', 'plan', next.plan.summary);
      }, 'Maya', `${id}:answer:${requestId}`);
    },
    async build(cookie, id, requestId) {
      const step = await advance(cookie, id, requestId, 'ready', 'building', 'Sam', 'Creating a bounded static website', 'build');
      if (step.duplicate) return visible(step.record);
      const current = step.record.snapshot;
      return generate(cookie, id, step.record.version, SAM, { goal: current.goal, answer: current.answer, plan: current.plan, domainProfile: current.domainProfile }, (next, reply) => {
        const artifact = renderArtifact(reply.result);
        next.files = { html: artifact.html, css: artifact.css };
        next.artifact = { sha256: artifact.sha256, checks: artifact.checks };
        next.status = 'awaiting_review';
        event(next, 'Sam', 'result', `Created index.html and styles.css; SHA-256 ${artifact.sha256}`, reply.usage);
      }, 'Sam', `${id}:build:${requestId}`);
    },
    async review(cookie, id, requestId) {
      const step = await advance(cookie, id, requestId, 'awaiting_review', 'reviewing', 'Quinn', 'Reviewing the exact generated files', 'review');
      if (step.duplicate) return visible(step.record);
      const current = step.record.snapshot;
      if (!current.files || artifactDigest(current.files.html, current.files.css) !== current.artifact?.sha256) throw new Error('Artifact receipt invalid');
      return generate(cookie, id, step.record.version, QUINN, { goal: current.goal, plan: current.plan, domainProfile: current.domainProfile, ...current.files, sha256: current.artifact.sha256 }, (next, reply) => {
        if (!validReview(reply.result)) throw new Error('Quinn returned an invalid review');
        if (artifactDigest(next.files.html, next.files.css) !== next.artifact.sha256) throw new Error('Artifact receipt invalid');
        next.status = reply.result.approved ? 'reviewed' : 'changes_requested';
        event(next, 'Quinn', reply.result.approved ? 'review' : 'blocked', reply.result.summary, reply.usage);
        next.events.at(-1).reviewedSha256 = next.artifact.sha256;
        next.events.at(-1).findings = reply.result.findings;
      }, 'Quinn', `${id}:review:${requestId}`);
    },
    async cancel(cookie, id) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const record = requireProject(await access.read(cookie, id));
        if (record.snapshot.status === 'cancelled') return visible(record);
        if (!['clarifying', 'planning', 'building', 'reviewing'].includes(record.snapshot.status)) throw new Error('Cancellation not expected');
        const next = structuredClone(record.snapshot); next.status = 'cancelled';
        event(next, 'User', 'cancelled', 'Cancelled this stage. An in-flight provider request may still incur usage.');
        const saved = await access.update(cookie, { id, expectedVersion: record.version, snapshot: next });
        if (saved) return visible(saved);
      }
      throw new Error('Project changed during cancellation');
    },
    async artifact(cookie, id, name) {
      if (!['index.html', 'styles.css'].includes(name)) throw new Error('Artifact not found');
      const record = requireProject(await access.read(cookie, id));
      const { artifact, files, status } = record.snapshot;
      if (!['reviewed', 'changes_requested', 'awaiting_review', 'reviewing'].includes(status) || !files || artifactDigest(files.html, files.css) !== artifact?.sha256) throw new Error('Artifact not found');
      verifyStaticSite(files.html, files.css);
      return { content: files[name === 'index.html' ? 'html' : 'css'], sha256: artifact.sha256 };
    },
  };
}
