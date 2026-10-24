import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(new URL('./mission-stage.schema.json', import.meta.url));
const roleForStage = {
  susie_design: 'susie',
  sam_implementation: 'sam',
  quinn_functional: 'quinn',
  susie_visual: 'susie',
};

function requireStage(result, stage, mission) {
  if (!result || result.stage !== stage || result.artifactId !== mission.artifactId ||
      !Array.isArray(result.evidence) || result.evidence.length === 0 ||
      result.evidence.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Codex ${stage} result did not match the approved artifact`);
  }
  return result;
}

function designGuideFrom(mission) {
  const design = mission.events.find(event => event.stage === 'susie_design' && event.status === 'done');
  if (!design?.output?.guide) throw new Error('Susie design guide checkpoint required before implementation');
  return design.output.guide;
}

function latestOutput(mission, stage) {
  return mission.events.findLast(event => event.stage === stage && event.status === 'done' &&
    event.revision === mission.revisions)?.output;
}

export class MissionCodexHandlers {
  constructor({ codex, workspacePath, browserVerifier = null, previewDeployer = null, timeoutSeconds = 900 }) {
    if (!codex || typeof codex.runStructured !== 'function') throw new Error('structured Codex runner required');
    if (!workspacePath) throw new Error('mission workspace path required');
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900) {
      throw new Error('mission role timeout must be 30-900 seconds');
    }
    this.codex = codex;
    this.workspacePath = resolve(workspacePath);
    this.browserVerifier = browserVerifier;
    this.previewDeployer = previewDeployer;
    this.timeoutSeconds = timeoutSeconds;
  }

  handlers() {
    return Object.fromEntries(Object.keys(roleForStage).map(stage => [stage, context => this.runStage(context)]));
  }

  async runStage({ mission, stage, revision, attempt, isCancelled = async () => false }) {
    if (!roleForStage[stage]) throw new Error('unsupported mission stage');
    if (await isCancelled()) throw new Error('mission cancelled before role launch');
    let prompt;
    let images = [];
    let rendered = null;
    if (stage === 'susie_design') {
      prompt = this.designPrompt(mission);
    } else if (stage === 'sam_implementation') {
      const guide = designGuideFrom(mission);
      const findings = mission.events.findLast(event => event.stage === 'susie_visual' &&
        event.status === 'needs_revision')?.output?.findings ?? [];
      prompt = this.buildPrompt(mission, guide, findings, revision);
    } else if (stage === 'quinn_functional') {
      const implementation = latestOutput(mission, 'sam_implementation');
      if (!implementation?.previewUrl) throw new Error('Sam implementation checkpoint required before functional review');
      prompt = this.functionalPrompt(mission, implementation, revision);
    } else {
      if (!this.browserVerifier) throw new Error('Playwright preview verifier unavailable');
      const implementation = latestOutput(mission, 'sam_implementation');
      if (!implementation?.previewUrl) throw new Error('Sam implementation checkpoint required before visual review');
      const capture = await this.browserVerifier.capture({ mission, previewUrl: implementation.previewUrl });
      rendered = capture.rendered;
      images = [capture.captures.desktop.screenshotPath, capture.captures.narrow.screenshotPath];
      prompt = this.visualPrompt(mission, rendered, capture.captures, revision);
    }

    const raw = await this.codex.runStructured({ cwd: this.workspacePath, prompt,
      timeoutSeconds: this.timeoutSeconds, schemaPath, readOnly: stage !== 'sam_implementation', images });
    const result = requireStage(raw, stage, mission);
    if (stage === 'susie_design') {
      if (result.status !== 'done' || !result.designGuide) throw new Error('Susie must complete a concrete design guide before Sam starts');
      return { status: 'done', evidence: result.evidence, artifactId: mission.artifactId,
        output: { kind: 'design_guide', guide: result.designGuide } };
    }
    if (stage === 'sam_implementation') {
      if (result.status !== 'done') throw new Error('Sam must complete the implementation');
      if (mission.previewTarget) {
        if (!this.previewDeployer) throw new Error('Vercel preview deployment is not configured for this mission');
        if (result.previewUrl !== null || typeof result.artifactPath !== 'string' || !result.artifactPath.trim() ||
            isAbsolute(result.artifactPath) || win32.isAbsolute(result.artifactPath)) {
          throw new Error('Sam must return a relative static artifact path for the approved Vercel preview');
        }
        const artifactRoot = resolve(this.workspacePath, result.artifactPath);
        const artifactRelative = relative(this.workspacePath, artifactRoot);
        if (!artifactRelative || artifactRelative === '..' || artifactRelative.startsWith(`..${sep}`)) {
          throw new Error('Sam artifact path must stay inside the approved workspace');
        }
        const deployed = await this.previewDeployer.deploy({ mission, artifactRoot, isCancelled });
        return { status: 'done', evidence: [...result.evidence,
          `Vercel preview ${deployed.deploymentId} reached READY for the accepted static artifact.`],
        artifactId: mission.artifactId, output: { kind: 'implementation', previewUrl: deployed.url,
          deploymentId: deployed.deploymentId, artifactFingerprint: deployed.artifactFingerprint } };
      }
      if (!result.previewUrl) throw new Error('Sam must provide the tested preview candidate');
      return { status: 'done', evidence: result.evidence, artifactId: mission.artifactId,
        output: { kind: 'implementation', previewUrl: result.previewUrl } };
    }
    if (stage === 'quinn_functional') {
      if (result.status !== 'done' || !result.functionalChecks.length) throw new Error('Quinn must record functional checks');
      return { status: 'done', evidence: result.evidence, artifactId: mission.artifactId,
        output: { kind: 'functional_review', checks: result.functionalChecks } };
    }
    if (!['done', 'needs_revision'].includes(result.status)) throw new Error('Susie visual review must approve or request a bounded revision');
    const decision = result.status === 'done' ? 'approved' : 'revise';
    return { status: result.status, evidence: result.evidence, artifactId: mission.artifactId, rendered,
      output: { kind: 'visual_review', decision, findings: result.visualFindings } };
  }

  designPrompt(mission) {
    return `You are Susie, the product designer. Produce the concrete design guide before implementation starts.\n` +
      `Return the JSON designGuide fields required by the attached schema: a distinct visual concept, at least three ordered sections, a usable type scale, a spacing scale, wide and narrow responsive behavior, imagery/source/alt guidance, interaction guidance and references. Set artifactPath to null. Avoid dated generic templates.\n` +
      `Approved goal: ${mission.goal}\nAcceptance criteria: ${mission.acceptanceCriteria?.join('\n') ?? 'Use the approved goal.'}\n` +
      `Constraints: ${mission.constraints.join('; ')}\n` +
      `Repository: ${mission.repo}\nArtifact identity: ${mission.artifactId}\nDestination: ${mission.destination}\n` +
      `Do not edit files, add dependencies, spend money, deploy, contact anyone, or change scope. Return evidence from what you actually inspected.`;
  }

  buildPrompt(mission, guide, findings, revision) {
    return `You are Sam, implementing one approved mission. Implement only this goal in the configured workspace.\n` +
      `Goal: ${mission.goal}\nAcceptance criteria:\n${(mission.acceptanceCriteria ?? []).map(item => `- ${item}`).join('\n')}\n` +
      `Constraints:\n${mission.constraints.map(item => `- ${item}`).join('\n')}\n` +
      `Design guide from Susie (must follow):\n${JSON.stringify(guide)}\n` +
      (findings.length ? `Susie's requested visual revisions:\n${findings.map(item => `- ${item}`).join('\n')}\n` : '') +
      `Revision ${revision}. Approved artifact: ${mission.artifactId}. Preview destination: ${mission.destination}.\n` +
      (mission.previewTarget ? `Accepted Vercel project/team target: ${JSON.stringify(mission.previewTarget)}. Implement a static site only. Create its complete static output inside the workspace (for example, dist/), include the exact <meta name="village-artifact-id" content="${mission.artifactId}"> marker in root index.html, and return that relative artifactPath with previewUrl null. Runtime will submit this output through the bounded preview-only adapter. Do not deploy yourself, invoke Vercel, or add credentials.\n` :
        'Return the preview URL that is already available at that exact destination. Do not publish, deploy, merge, provision, add credentials, or alter unrelated files.\n') +
      `Do not exceed the agreed goal. Report files changed and checks actually run.`;
  }

  functionalPrompt(mission, implementation, revision) {
    return `You are Quinn, an independent read-only functional reviewer. Do not modify files.\n` +
      `Review only artifact ${mission.artifactId} for goal: ${mission.goal}\n` +
      `Inspect the accepted local source in validation/${mission.id}/ and its static output in validation/${mission.id}/dist/. Review the actual HTML, CSS, and JavaScript files directly; do not rely on public unauthenticated retrieval of a protected preview.\n` +
      `Acceptance criteria:\n${(mission.acceptanceCriteria ?? []).map(item => `- ${item}`).join('\n')}\n` +
      `Sam's preview candidate: ${implementation.previewUrl}\nRevision: ${revision}\n` +
      (mission.functionalReviewRecovery?.status === 'consumed' ?
        `A previous Quinn attempt was blocked for missing evidence and remains in the audit trail. New independently captured Chromium evidence is available: ${JSON.stringify(mission.functionalReviewRecovery.functionalChecks)}. Treat it as evidence to inspect, not as a result to copy; independently verify whether the local interaction and implementation satisfy the acceptance criteria.\n` : '') +
      `Run relevant existing tests if safe within this read-only workspace. Return concrete functionalChecks and evidence, and set artifactPath to null. ` +
      `Do not claim a test passed unless its command result was observed.`;
  }

  visualPrompt(mission, rendered, captures, revision) {
    return `You are Susie, reviewing the actual rendered screenshots attached from Chromium. This is a visual review, not a source-only review.\n` +
      `Goal: ${mission.goal}\nDesign guide: ${JSON.stringify(designGuideFrom(mission))}\n` +
      `Artifact ${mission.artifactId}; destination ${rendered.destination}; preview ${rendered.previewUrl}; revision ${revision}.\n` +
      `Desktop evidence: ${captures.desktop.evidenceRef} (${captures.desktop.metrics.width}px). ` +
      `Narrow evidence: ${captures.narrow.evidenceRef} (${captures.narrow.metrics.width}px).\n` +
      `Assess hierarchy, typography, spacing, responsive behavior, imagery, and interactions against the guide. ` +
      `Return done only if the screenshots meet the goal; otherwise return needs_revision with specific visualFindings. Set artifactPath to null. Do not edit files or deploy.`;
  }
}
