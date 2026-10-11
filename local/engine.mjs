import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactDigest, renderArtifact, verifyStaticSite } from './artifact.mjs';
import { MAYA, PLAN, SAM, QUINN, validText, validPlan, validReview } from '../office/lib/project-roles.mjs';
import { readDomainProfile } from './domain.mjs';

function publicProject(project) { const { goal, answer, plan, status, events, id, createdAt, artifact, domainProfile } = project; return { id, goal, answer, plan, status, events, createdAt, artifact, domainProfile }; }

export class VillageEngine {
  constructor({ root = new URL('./.workspaces/', import.meta.url), provider, now = () => new Date().toISOString() }) {
    this.root = resolve(root instanceof URL ? fileURLToPath(root) : root);
    this.provider = provider;
    this.now = now;
    this.projects = new Map();
    this.running = new Map();
    this.saves = new Map();
    this.creates = new Map();
  }
  async save(project) {
    const previous = this.saves.get(project.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      const dir = join(this.root, project.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await this.checkedWorkspace(project.id);
      const temp = join(dir, `state-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(project), { mode: 0o600 });
      await rename(temp, join(dir, 'state.json'));
    });
    this.saves.set(project.id, current);
    try { await current; }
    finally { if (this.saves.get(project.id) === current) this.saves.delete(project.id); }
  }
  async checkedWorkspace(id) {
    const dir = join(this.root, id);
    const [rootPath, dirPath, details] = await Promise.all([realpath(this.root), realpath(dir), lstat(dir)]);
    if (details.isSymbolicLink() || !details.isDirectory() || dirPath !== join(rootPath, id)) throw new Error('Workspace path invalid');
    return dir;
  }
  event(project, agent, type, message, extra = {}) {
    const safe = this.provider.redact?.(message) ?? String(message);
    project.events.push({ at: this.now(), agent, type, message: safe.slice(0, 1200), ...extra });
  }
  async recordPublish(id, service, receipt) {
    const project = await this.getInternal(id);
    if (project.status !== 'reviewed' || project.artifact?.sha256 !== receipt.artifactSha256) throw new Error('Reviewed receipt changed before publishing');
    const receiptId = service === 'github' ? receipt.commitSha : receipt.deploymentId;
    if (project.events.some(event => event.type === 'publish' && event.receiptId === receiptId)) return publicProject(project);
    this.event(project, 'System', 'publish', service === 'github'
      ? `Published reviewed files to ${receipt.repository} branch ${receipt.branch} at commit ${receipt.commitSha}`
      : `Submitted reviewed files to Vercel Preview ${receipt.team}/${receipt.project}; deployment ${receipt.deploymentId} is ${receipt.state}`, { receiptId, url: receipt.url });
    await this.save(project);
    return publicProject(project);
  }
  async create(goal, requestId) {
    if (!validText(goal) || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId ?? '')) throw new Error('Goal and request ID required');
    if (this.provider.containsSecret?.(goal)) throw new Error('Do not put an API key in chat');
    if (this.creates.has(requestId)) return this.creates.get(requestId);
    const pending = this.createOnce(goal, requestId);
    this.creates.set(requestId, pending);
    try { return await pending; }
    finally { if (this.creates.get(requestId) === pending) this.creates.delete(requestId); }
  }
  async createOnce(goal, requestId) {
    const existing = [...this.projects.values()].find(item => item.requestId === requestId);
    if (existing) return publicProject(existing);
    let directories = [];
    try { directories = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of directories) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      let stored;
      try { stored = JSON.parse(await readFile(join(this.root, entry.name, 'state.json'), 'utf8')); }
      catch { continue; }
      if (stored.requestId === requestId) return publicProject(await this.getInternal(entry.name));
    }
    const domainProfile = await readDomainProfile(this.root);
    if (Object.values(domainProfile).some(value => this.provider.containsSecret?.(value))) throw new Error('Do not put an API key in domain answers');
    const project = { id: randomUUID(), requestId, goal: goal.trim(), answer: null, plan: null, status: 'clarifying', events: [], createdAt: this.now(), artifact: null, domainProfile };
    this.projects.set(project.id, project);
    if (Object.values(domainProfile).some(Boolean)) this.event(project, 'System', 'context', 'Saved domain answers attached to Maya, Sam, and Quinn for this project');
    this.event(project, 'Maya', 'start', 'Reading the project goal');
    await this.save(project);
    try {
      const { result, usage } = await this.provider.generate({ system: MAYA, input: JSON.stringify({ goal, domainProfile }), signal: undefined });
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
      const { result, usage } = await this.provider.generate({ system: PLAN, input: JSON.stringify({ goal: project.goal, answer: project.answer, domainProfile: project.domainProfile }) });
      if (!validPlan(result)) throw new Error('Maya returned an invalid plan');
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
    const controller = new AbortController();
    this.running.set(id, { controller, promise: null });
    try { await this.save(project); }
    catch (error) {
      this.running.delete(id);
      project.status = 'blocked';
      this.event(project, 'System', 'error', 'Could not persist the build start.');
      throw error;
    }
    if (controller.signal.aborted || project.status !== 'building') { this.running.delete(id); return publicProject(project); }
    const promise = this.runBuild(project, controller).catch(() => {
      project.status = 'blocked';
      this.event(project, 'System', 'error', 'Could not persist the build result.');
    });
    this.running.set(id, { controller, promise });
    promise.finally(() => { if (this.running.get(id)?.promise === promise) this.running.delete(id); });
    return publicProject(project);
  }
  async runBuild(project, controller) {
    try {
      const { result, usage } = await this.provider.generate({ system: SAM, input: JSON.stringify({ goal: project.goal, answer: project.answer, plan: project.plan, domainProfile: project.domainProfile }), signal: controller.signal });
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
      const actualSha = artifactDigest(html, css);
      if (actualSha !== artifact.sha256) throw new Error('Artifact changed before review');
      const checks = verifyStaticSite(html, css);
      project.artifact = { sha256: artifact.sha256, url: `/artifact/${project.id}/index.html`, checks };
      this.event(project, 'Sam', 'result', `Created index.html and styles.css; SHA-256 ${artifact.sha256}`, { usage, checks });
      project.status = 'reviewing';
      this.event(project, 'Quinn', 'start', `Reviewing the generated files at SHA-256 ${artifact.sha256}`);
      await this.save(project);
      if (controller.signal.aborted) return;
      const review = await this.provider.generate({ system: QUINN, input: JSON.stringify({ goal: project.goal, plan: project.plan, domainProfile: project.domainProfile, html, css, sha256: actualSha }), signal: controller.signal });
      if (controller.signal.aborted) return;
      const currentHtml = await readFile(join(dir, 'index.html'), 'utf8');
      const currentCss = await readFile(join(dir, 'styles.css'), 'utf8');
      if (controller.signal.aborted) return;
      if (artifactDigest(currentHtml, currentCss) !== actualSha) throw new Error('Artifact changed during review');
      const verdict = review.result;
      if (!validReview(verdict)) throw new Error('Quinn returned an invalid review');
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
    try { project = JSON.parse(await readFile(join(await this.checkedWorkspace(id), 'state.json'), 'utf8')); } catch { throw new Error('Project not found'); }
    if (project.id !== id) throw new Error('Project state mismatch');
    if (['building', 'reviewing', 'planning', 'clarifying'].includes(project.status)) {
      project.status = 'interrupted';
      this.event(project, 'Maya', 'error', 'The server restarted during work. Inspect the project before starting a new run.');
      await this.save(project);
    }
    this.projects.set(id, project);
    return project;
  }
  async verifyArtifact(project) {
    if (!project.artifact) return null;
    let html, css;
    try {
      const dir = await this.checkedWorkspace(project.id);
      [html, css] = await Promise.all(['index.html', 'styles.css'].map(async name => {
        const path = join(dir, name);
        const details = await lstat(path);
        if (!details.isFile() || details.isSymbolicLink()) throw new Error('Artifact path invalid');
        return readFile(path);
      }));
    }
    catch { /* missing files invalidate the receipt */ }
    const digest = html && css ? artifactDigest(html, css) : null;
    if (digest !== project.artifact.sha256) {
      project.status = 'blocked';
      project.artifact = null;
      this.event(project, 'System', 'error', 'Generated files changed after review; the artifact receipt is invalid.');
      await this.save(project);
      return null;
    }
    return { html, css };
  }
  async get(id) { const project = await this.getInternal(id); await this.verifyArtifact(project); return publicProject(project); }
  async artifact(id, name) {
    if (!['index.html', 'styles.css'].includes(name)) throw new Error('Artifact not found');
    const project = await this.getInternal(id);
    if (!project.artifact) throw new Error('Artifact not found');
    const verified = await this.verifyArtifact(project);
    if (!verified) throw new Error('Artifact not found');
    return verified[name === 'index.html' ? 'html' : 'css'];
  }
}
