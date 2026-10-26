import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { vercelPreviewDestination, validateVercelPreviewTarget } from './vercel-preview-deployer.mjs';

const REPO = 'startupsandcode/agent-village';
const schemaPath = fileURLToPath(new URL('./mission-intake.schema.json', import.meta.url));
const fixedRoles = { design: 'susie', build: 'sam', functional_review: 'quinn', visual_review: 'susie' };

export class MayaMissionIntake {
  constructor({ codex, workspacePath, timeoutSeconds = 300 }) {
    if (!codex || typeof codex.runStructured !== 'function') throw new Error('structured Codex runner required');
    if (!workspacePath) throw new Error('mission workspace path required');
    this.codex = codex;
    this.workspacePath = workspacePath;
    this.timeoutSeconds = timeoutSeconds;
    this.proposals = new Map();
  }

  async propose(input) {
    if (!input || input.repo !== REPO || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(input.id ?? '') ||
        typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 2000 ||
        typeof input.workspaceBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.workspaceBranch) ||
        typeof input.destination !== 'string' || !input.destination.trim() || input.destination.length > 2000 ||
        typeof input.artifactId !== 'string' || !input.artifactId.trim() || input.artifactId.length > 160) {
      throw new Error('complete bounded mission scope required');
    }
    const actualRoles = input.team?.roles;
    if (!input.team || !actualRoles || actualRoles.design !== fixedRoles.design || actualRoles.build !== fixedRoles.build ||
        actualRoles.functional_review !== fixedRoles.functional_review || actualRoles.visual_review !== fixedRoles.visual_review ||
        Object.keys(actualRoles).length !== 4) {
      throw new Error('approved single-team role map required');
    }
    if (input.previewTarget !== undefined) {
      validateVercelPreviewTarget(input.previewTarget, [input.previewTarget]);
      if (input.destination !== vercelPreviewDestination(input.previewTarget)) {
        throw new Error('Vercel preview destination must identify the approved project and team');
      }
    } else {
      let destination;
      try { destination = new URL(input.destination); } catch { throw new Error('preview destination must be an absolute HTTP URL'); }
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password ||
          destination.search || destination.hash) throw new Error('preview destination must not contain credentials, query, or fragment');
    }
    if (!Array.isArray(input.constraints) || input.constraints.length > 16 ||
        input.constraints.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) {
      throw new Error('mission constraints required');
    }
    const raw = await this.codex.runStructured({ cwd: this.workspacePath, prompt:
      `You are Maya, the engineering lead. Turn this one project goal into a bounded mission agreement. ` +
      `Do not change the requested repository, destination, artifact identity, constraints, team, or spend. ` +
      `If any scope, access, budget, or destructive-action condition is unclear, return needs_user and ask one concise question. ` +
      `If the request is clear and within scope, return agreed with a concise summary and at least three testable acceptance criteria. ` +
      `Never request new credentials or paid services.\nRepository: ${input.repo}\nGoal: ${input.goal}\n` +
      `Feature branch: ${input.workspaceBranch}\n` +
      `Destination: ${input.destination}\n` +
      (input.previewTarget ? `Approved Vercel target: ${JSON.stringify(input.previewTarget)}; preview-only static artifact deployment.\n` : '') +
      `Artifact: ${input.artifactId}\nConstraints: ${input.constraints.join('; ')}\n` +
      `Team: Maya intake, Susie design then Sam build, Quinn functional review, Susie rendered review.`,
      timeoutSeconds: this.timeoutSeconds, schemaPath, readOnly: true });
    if (!raw || !['agreed', 'needs_user', 'blocked'].includes(raw.status) ||
        typeof raw.summary !== 'string' || !Array.isArray(raw.acceptanceCriteria) || !Array.isArray(raw.questions)) {
      throw new Error('Maya returned an invalid mission intake result');
    }
    if (raw.status !== 'agreed') return { status: raw.status, summary: raw.summary, questions: raw.questions };
    if (raw.summary.trim().length < 10 || raw.questions.length || raw.acceptanceCriteria.length < 3 || raw.acceptanceCriteria.length > 12 ||
        raw.acceptanceCriteria.some(item => typeof item !== 'string' || item.trim().length < 10)) {
      throw new Error('Maya agreement must have clear criteria and no unresolved questions');
    }
    const proposalId = randomUUID();
    const proposal = Object.freeze({ proposalId, status: 'agreed', summary: raw.summary,
      acceptanceCriteria: Object.freeze([...raw.acceptanceCriteria]) });
    this.proposals.set(proposalId, { proposal, input: structuredClone(input) });
    return proposal;
  }

  accept(proposalId, confirmation) {
    const pending = this.proposals.get(proposalId);
    if (!pending || confirmation !== `I agree to mission ${proposalId}`) {
      throw new Error('the exact Maya proposal must be accepted before mission creation');
    }
    this.proposals.delete(proposalId);
    const { input } = pending;
    const acceptedAt = new Date().toISOString();
    const mayaAgreement = { proposalId, summary: pending.proposal.summary, acceptedByUser: true, acceptedAt,
      repo: input.repo, goal: input.goal.trim(), acceptanceCriteria: [...pending.proposal.acceptanceCriteria],
      workspaceBranch: input.workspaceBranch,
      destination: input.destination.trim(), artifactId: input.artifactId.trim(),
      constraints: [...input.constraints], team: structuredClone(input.team),
      ...(input.previewTarget ? { previewTarget: structuredClone(input.previewTarget) } : {}) };
    return { ...input, goal: input.goal.trim(), destination: input.destination.trim(),
      artifactId: input.artifactId.trim(), acceptanceCriteria: [...pending.proposal.acceptanceCriteria], mayaAgreement };
  }
}
