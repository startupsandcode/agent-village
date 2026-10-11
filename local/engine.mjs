import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArtifact } from './artifact.mjs';

const MAYA = 'You are Maya, an engineering lead. Return only JSON. Ask one focused clarification before planning. The delivery is a small static website with a useful, concrete purpose. Do not claim work has happened.';
const PLAN = 'You are Maya. Return only JSON with keys summary, audience, acceptance (array of 2-4 short strings), and decision. Plan one small static website. Incorporate the stated answer. Do not claim build or review has occurred.';
const SAM = 'You are Sam, a builder. Return only JSON with title, headline, summary, cta, features (array of 2-4 objects with title and description). Produce a useful static website from the approved plan. No code, links, scripts, secrets, or claims of tests.';
const QUINN = 'You are Quinn, an independent reviewer. Review the actual generated HTML and CSS against the plan. Return only JSON with approved (boolean), summary (string), findings (array of short strings). Do not approve if the artifact misses the goal. Never claim you ran a browser or tests.';

function validText(value, max = 1000) { return typeof value === 'string' && value.trim() && value.length <= max; }
function publicProject(project) { const { goal, answer, plan, status, events, id, createdAt, artifact } = project; return { id, goal, answer, plan, status, events, createdAt, artifact }; }

export class VillageEngine {
  constructor({ root = new URL('./.workspaces/', import.meta.url), provider, now = () => new Date().toISOString() }) {
    this.root = resolve(root instanceof URL ? fileURLToPath(root) : root);
    this.provider = provider;
    this.now = now;
    this.projects = new Map();
    this.running = new Map();
  }
  async save(project) {
    const dir = join(this.root, project.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `state-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(project), { mode: 0o600 });
    await rename(temp, join(dir, 'state.json'));
  }
  event(project, agent, type, message, extra = {}) {
    const safe = this.provider.redact?.(message) ?? String(message);
    project.events.push({ at: this.now(), agent, type, message: safe.slice(0, 1200), ...extra });
  }
  async create(goal, requestId) {
    if (!validText(goal) || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId ?? '')) throw new Error('Goal and request ID required');
    if (this.provider.containsSecret?.(goal)) throw new Error('Do not put an API key in chat');
    const existing = [...this.projects.values()].find(item => item.requestId === requestId);
    if (existing) return publicProject(existing);
    const project = { id: randomUUID(), requestId, goal: goal.trim(), answer: null, plan: null, status: 'clarifying', events: [], createdAt: this.now(), artifact: null };
    this.projects.set(project.id, project);
    this.event(project, 'Maya', 'start', 'Reading the project goal');
    await this.save(project);
    try {
      const { result, usage } = await this.provider.generate({ system: MAYA, input: JSON.stringify({ goal }), signal: undefined });
      if (!validText(result.question, 300)) throw new Error('Maya returned an invalid question');
      project.status = 'needs_answer';
      this.event(project, 'Maya', 'question', result.question, { usage });
    } catch (error) {
      project.status = 'blocked';
      this.event(project, 'Maya', 'error', error.message);
    }
    await this.save(project);
    return publicProject(project);
  }
  async answer(id, answer, requestId) {
    const project = await this.getInternal(id);
    if (project.answerRequestId === requestId && requestId) return publicProject(project);
    if (project.status !== 'needs_answer' || !validText(answer) || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId ?? '')) throw new Error('Answer not expected');
    if (this.provider.containsSecret?.(answer)) throw new Error('Do not put an API key in chat');
    project.answer = answer.trim(); project.answerRequestId = requestId; project.status = 'planning';
    this.event(project, 'User', 'answer', project.answer);
    await this.save(project);
    try {
      const { result, usage } = await this.provider.generate({ system: PLAN, input: JSON.stringify({ goal: project.goal, answer: project.answer }) });
      if (!validText(result.summary, 500) || !validText(result.audience, 200) || !Array.isArray(result.acceptance) || result.acceptance.length < 2 || result.acceptance.length > 4 || result.acceptance.some(value => !validText(value, 200)) || !validText(result.decision, 300)) throw new Error('Maya returned an invalid plan');
      project.plan = { summary: result.summary, audience: result.audience,
        acceptance: [...result.acceptance], decision: result.decision };
      project.status = 'ready';
      this.event(project, 'Maya', 'decision', result.decision, { usage });
      this.event(project, 'Maya', 'plan', result.summary);
    } catch (error) { project.status = 'blocked'; this.event(project, 'Maya', 'error', error.message); }
    await this.save(project);
    return publicProject(project);
  }
  async build(id, requestId) {
    const project = await this.getInternal(id);
    if (project.buildRequestId === requestId && requestId) return publicProject(project);
    if (project.status !== 'ready' || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId ?? '')) throw new Error('Build not expected');
    project.buildRequestId = requestId; project.status = 'building';
    this.event(project, 'Sam', 'start', 'Creating a bounded static website');
    await this.save(project);
    const controller = new AbortController();
    const promise = this.runBuild(project, controller);
    this.running.set(id, { controller, promise });
    promise.finally(() => { if (this.running.get(id)?.promise === promise) this.running.delete(id); });
    return publicProject(project);
  }
  async runBuild(project, controller) {
    try {
      const { result, usage } = await this.provider.generate({ system: SAM, input: JSON.stringify({ goal: project.goal, answer: project.answer, plan: project.plan }), signal: controller.signal });
      if (controller.signal.aborted) return;
      const artifact = renderArtifact(result);
      const dir = join(this.root, project.id);
      await writeFile(join(dir, 'index.html'), artifact.html, { flag: 'wx', mode: 0o600 });
      if (controller.signal.aborted) return;
      await writeFile(join(dir, 'styles.css'), artifact.css, { flag: 'wx', mode: 0o600 });
      if (controller.signal.aborted) return;
      const html = await readFile(join(dir, 'index.html'), 'utf8');
      const css = await readFile(join(dir, 'styles.css'), 'utf8');
      if (controller.signal.aborted) return;
      const actualSha = createHash('sha256').update(html).update(css).digest('hex');
      if (actualSha !== artifact.sha256) throw new Error('Artifact changed before review');
      project.artifact = { sha256: artifact.sha256, url: `/artifact/${project.id}/index.html` };
      this.event(project, 'Sam', 'result', `Created index.html and styles.css; SHA-256 ${artifact.sha256}`, { usage });
      project.status = 'reviewing';
      this.event(project, 'Quinn', 'start', `Reviewing the generated files at SHA-256 ${artifact.sha256}`);
      await this.save(project);
      const review = await this.provider.generate({ system: QUINN, input: JSON.stringify({ goal: project.goal, plan: project.plan, html, css, sha256: actualSha }), signal: controller.signal });
      if (controller.signal.aborted) return;
      const currentHtml = await readFile(join(dir, 'index.html'), 'utf8');
      const currentCss = await readFile(join(dir, 'styles.css'), 'utf8');
      if (controller.signal.aborted) return;
      if (createHash('sha256').update(currentHtml).update(currentCss).digest('hex') !== actualSha) throw new Error('Artifact changed during review');
      const verdict = review.result;
      if (typeof verdict.approved !== 'boolean' || !validText(verdict.summary, 500) || !Array.isArray(verdict.findings) || verdict.findings.length > 6 || verdict.findings.some(value => !validText(value, 300))) throw new Error('Quinn returned an invalid review');
      project.status = verdict.approved ? 'reviewed' : 'changes_requested';
      this.event(project, 'Quinn', verdict.approved ? 'review' : 'blocked', verdict.summary, { findings: verdict.findings, reviewedSha256: artifact.sha256, usage: review.usage });
    } catch (error) {
      if (!controller.signal.aborted) { project.status = 'blocked'; this.event(project, project.artifact ? 'Quinn' : 'Sam', 'error', error.message); }
    } finally {
      if (controller.signal.aborted && !project.artifact) {
        await Promise.all(['index.html', 'styles.css'].map(name => rm(join(this.root, project.id, name), { force: true })));
      }
      await this.save(project);
    }
  }
  async cancel(id) {
    const project = await this.getInternal(id);
    if (!['building', 'reviewing'].includes(project.status)) return publicProject(project);
    this.running.get(id)?.controller.abort();
    project.status = 'cancelled';
    this.event(project, 'Maya', 'cancelled', 'Build cancelled by user');
    await this.save(project);
    return publicProject(project);
  }
  async getInternal(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Project not found');
    if (this.projects.has(id)) return this.projects.get(id);
    let project;
    try { project = JSON.parse(await readFile(join(this.root, id, 'state.json'), 'utf8')); } catch { throw new Error('Project not found'); }
    if (['building', 'reviewing', 'planning', 'clarifying'].includes(project.status)) {
      project.status = 'interrupted';
      this.event(project, 'Maya', 'error', 'The server restarted during work. Inspect the project before starting a new run.');
      await this.save(project);
    }
    this.projects.set(id, project);
    return project;
  }
  async get(id) { return publicProject(await this.getInternal(id)); }
  async artifact(id, name) {
    if (!['index.html', 'styles.css'].includes(name)) throw new Error('Artifact not found');
    const project = await this.getInternal(id);
    if (!project.artifact) throw new Error('Artifact not found');
    return await readFile(join(this.root, project.id, name));
  }
}
