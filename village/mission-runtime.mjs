import { CodexRunner } from './codex-runner.mjs';
import { MissionRunner, MissionStore } from './mission-runner.mjs';
import { MissionCodexHandlers } from './mission-codex.mjs';
import { BrowserPreviewVerifier } from './browser-verifier.mjs';
import { configuredVercelPreviewTargets, VercelCliClient, VercelPreviewDeployer } from './vercel-preview-deployer.mjs';
import { join } from 'node:path';

export function createMissionRuntime({ storeRoot, evidenceRoot, workspacePath, codex = new CodexRunner(),
  browserVerifier = null, previewDeployer = null, env = process.env }) {
  if (!storeRoot || !workspacePath || !evidenceRoot) throw new Error('mission store, workspace, and evidence path are required');
  const targets = configuredVercelPreviewTargets(env);
  const vercelCli = new VercelCliClient();
  const resolvedBrowserVerifier = browserVerifier ?? new BrowserPreviewVerifier({ evidenceRoot,
    oidcTokenProvider: async ({ target }) => await vercelCli.getDevelopmentOidcToken({
      projectId: target.projectId, teamSlug: target.teamSlug, cwd: workspacePath,
    }) });
  const resolvedPreviewDeployer = previewDeployer ?? (targets.length ? new VercelPreviewDeployer({
    workspaceRoot: workspacePath, stateRoot: join(storeRoot, '.preview-deployments'), targets, cli: vercelCli,
  }) : null);
  const store = new MissionStore(storeRoot);
  const handlers = new MissionCodexHandlers({ codex, workspacePath, browserVerifier: resolvedBrowserVerifier,
    previewDeployer: resolvedPreviewDeployer }).handlers();
  const runner = new MissionRunner(store, { verifyRenderedEvidence: evidence => resolvedBrowserVerifier.verifyRenderedEvidence(evidence) });
  return { store, handlers, runner, browserVerifier: resolvedBrowserVerifier, previewDeployer: resolvedPreviewDeployer };
}
