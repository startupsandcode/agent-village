import { CodexRunner } from './codex-runner.mjs';
import { MissionRunner, MissionStore } from './mission-runner.mjs';
import { MissionCodexHandlers } from './mission-codex.mjs';
import { BrowserPreviewVerifier } from './browser-verifier.mjs';

export function createMissionRuntime({ storeRoot, evidenceRoot, workspacePath, codex = new CodexRunner(),
  browserVerifier = new BrowserPreviewVerifier({ evidenceRoot }) }) {
  if (!storeRoot || !workspacePath || !browserVerifier) throw new Error('mission store, workspace, and browser verifier are required');
  const store = new MissionStore(storeRoot);
  const handlers = new MissionCodexHandlers({ codex, workspacePath, browserVerifier }).handlers();
  const runner = new MissionRunner(store, { verifyRenderedEvidence: evidence => browserVerifier.verifyRenderedEvidence(evidence) });
  return { store, handlers, runner, browserVerifier };
}
