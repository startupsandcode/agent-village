import { artifactDigest } from './static-site.mjs';

const API = 'https://api.vercel.com';
const namePattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const deploymentIdPattern = /^dpl_[A-Za-z0-9_-]{4,80}$/;

export class UnsafeVercelDeploymentError extends Error {
  constructor(receipt) {
    super('Vercel returned a non-Preview deployment; inspect the recorded deployment before retrying');
    this.receipt = receipt;
  }
}

async function request(fetchImpl, path, token, options = {}) {
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error('Vercel connection or timeout failure; check deployment status before retrying'); }
  if (!response.ok) throw new Error(`Vercel request failed (${response.status}); no response body was logged`);
  try { return await response.json(); } catch { throw new Error('Vercel returned an invalid response'); }
}

async function verifySoleBaseline(fetchImpl, token, team, projectId, baselineDeploymentId) {
  const history = await request(fetchImpl,
    `/v7/deployments?projectId=${encodeURIComponent(projectId)}&limit=100&slug=${encodeURIComponent(team)}`, token);
  const deployments = history?.deployments;
  if (!Array.isArray(deployments) || deployments.length !== 1 || history?.pagination?.count !== 1 ||
      (deployments[0].uid ?? deployments[0].id) !== baselineDeploymentId || deployments[0].projectId !== projectId ||
      deployments[0].target !== 'production' || (deployments[0].readyState ?? deployments[0].state) !== 'READY') {
    throw new Error('Vercel deployment inventory changed; manual inspection required');
  }
}

export async function deployReviewedPreview({ engine, id, team, project, token, fetchImpl = fetch, onBeforeSubmit = async () => {},
  expectedSoleBaselineId = null }) {
  if (!namePattern.test(team ?? '') || !namePattern.test(project ?? '')) throw new Error('Exact Vercel team and project names required');
  if (typeof token !== 'string' || !token.trim()) throw new Error('Vercel publishing token missing on the server');
  const record = await engine.get(id);
  if (record.status !== 'reviewed' || !record.artifact) throw new Error('Only a reviewed project can be deployed');
  const [html, css] = await Promise.all(['index.html', 'styles.css'].map(name => engine.artifact(id, name)));
  if (artifactDigest(html, css) !== record.artifact.sha256) throw new Error('Reviewed files changed before Preview upload');
  if (Buffer.byteLength(html) > 32_768 || Buffer.byteLength(css) > 32_768) throw new Error('Reviewed files exceed preview upload limit');
  const query = `?slug=${encodeURIComponent(team)}`;
  const selected = await request(fetchImpl, `/v9/projects/${encodeURIComponent(project)}${query}`, token);
  if (!selected || selected.name !== project || !/^prj_[A-Za-z0-9_-]{4,80}$/.test(selected.id ?? '') || selected.link != null ||
      (selected.framework !== null && selected.framework !== undefined) ||
      ['rootDirectory', 'buildCommand', 'installCommand', 'outputDirectory', 'devCommand', 'commandForIgnoringBuildStep', 'ignoreCommand']
        .some(key => selected[key] != null && selected[key] !== '')) throw new Error('Vercel target must be an existing static project at its root with no Git link or custom build settings');
  if (selected.ssoProtection?.deploymentType !== 'all' ||
      (selected.protectionBypass != null &&
        (typeof selected.protectionBypass !== 'object' || Array.isArray(selected.protectionBypass) ||
          Object.keys(selected.protectionBypass).length > 0))) {
    throw new Error('Vercel Preview requires All Deployments protection without configured bypasses; no upload was attempted');
  }
  // Vercel assigns a project's first deployment to production even when target is omitted.
  const history = await request(fetchImpl,
    `/v7/deployments?projectId=${encodeURIComponent(selected.id)}&target=production&limit=1&slug=${encodeURIComponent(team)}`, token);
  const prior = history?.deployments?.[0];
  if (prior?.projectId !== selected.id || prior?.target !== 'production' ||
      (prior?.readyState ?? prior?.state) !== 'READY') {
    throw new Error('Vercel Preview requires an existing production deployment; no upload was attempted');
  }
  if (expectedSoleBaselineId != null) {
    if (!deploymentIdPattern.test(expectedSoleBaselineId)) throw new Error('Invalid reconciliation baseline');
    await verifySoleBaseline(fetchImpl, token, team, selected.id, expectedSoleBaselineId);
  }
  await onBeforeSubmit({ team, project, projectId: selected.id, artifactSha256: record.artifact.sha256 });
  const deployment = await request(fetchImpl, `/v13/deployments${query}`, token, { method: 'POST', body: JSON.stringify({
    name: project,
    project: selected.id,
    files: [
      { file: 'index.html', data: Buffer.from(html).toString('base64'), encoding: 'base64' },
      { file: 'styles.css', data: Buffer.from(css).toString('base64'), encoding: 'base64' },
    ],
    autoAssignCustomDomains: false,
    projectSettings: { framework: null, buildCommand: '' },
    meta: { villageProjectId: id, villageArtifactSha256: record.artifact.sha256 },
  }) });
  if (/^dpl_[A-Za-z0-9_-]{4,80}$/.test(deployment?.id ?? '') && deployment.target != null) {
    const receipt = { team, project, projectId: selected.id, deploymentId: deployment.id,
      target: typeof deployment.target === 'string' && /^[a-z0-9_-]{1,80}$/.test(deployment.target) ? deployment.target : 'unknown',
      state: typeof deployment.readyState === 'string' && /^[A-Z_]{1,32}$/.test(deployment.readyState) ? deployment.readyState : 'UNKNOWN',
      artifactSha256: record.artifact.sha256 };
    if (/^[a-z0-9.-]+\.vercel\.app$/.test(deployment.url ?? '')) receipt.url = `https://${deployment.url}`;
    throw new UnsafeVercelDeploymentError(receipt);
  }
  if (!/^dpl_[A-Za-z0-9_-]{4,80}$/.test(deployment?.id ?? '') ||
      !/^[a-z0-9.-]+\.vercel\.app$/.test(deployment?.url ?? '') || deployment.target != null) {
    throw new Error('Vercel returned an unexpected deployment receipt; inspect Vercel before retrying');
  }
  return { team, project, projectId: selected.id, deploymentId: deployment.id,
    url: `https://${deployment.url}`, state: deployment.readyState ?? 'QUEUED', artifactSha256: record.artifact.sha256 };
}

export async function inspectPreviewDeployment({ receipt, token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Vercel publishing token missing on the server');
  if (!/^dpl_[A-Za-z0-9_-]{4,80}$/.test(receipt?.deploymentId ?? '') || !namePattern.test(receipt?.team ?? '')) throw new Error('Invalid preview receipt');
  const value = await request(fetchImpl, `/v13/deployments/${receipt.deploymentId}?slug=${encodeURIComponent(receipt.team)}`, token);
  if (value.id !== receipt.deploymentId || value.target != null || (value.projectId && value.projectId !== receipt.projectId)) throw new Error('Vercel deployment identity changed');
  return { ...receipt, state: value.readyState, url: value.url && /^[a-z0-9.-]+\.vercel\.app$/.test(value.url) ? `https://${value.url}` : receipt.url };
}

// Operator-only recovery for an old submitting claim after an uncertain POST.
// The destination must contain exactly the known inert baseline, with no other
// deployment that could be a duplicate of the reviewed artifact.
export async function verifyDeletedVercelAttempt({ team, project, token, deletedDeploymentId,
  baselineDeploymentId, fetchImpl = fetch }) {
  if (!namePattern.test(team ?? '') || !namePattern.test(project ?? '') ||
      !deploymentIdPattern.test(deletedDeploymentId ?? '') || !deploymentIdPattern.test(baselineDeploymentId ?? '') ||
      deletedDeploymentId === baselineDeploymentId || typeof token !== 'string' || !token.trim()) {
    throw new Error('Exact Vercel reconciliation target and deployment IDs required');
  }
  const query = `?slug=${encodeURIComponent(team)}`;
  const selected = await request(fetchImpl, `/v9/projects/${encodeURIComponent(project)}${query}`, token);
  if (selected?.name !== project || !/^prj_[A-Za-z0-9_-]{4,80}$/.test(selected?.id ?? '') || selected.link != null ||
      selected.ssoProtection?.deploymentType !== 'all' ||
      (selected.protectionBypass != null &&
        (typeof selected.protectionBypass !== 'object' || Array.isArray(selected.protectionBypass) || Object.keys(selected.protectionBypass).length))) {
    throw new Error('Protected Vercel reconciliation target changed');
  }
  await verifySoleBaseline(fetchImpl, token, team, selected.id, baselineDeploymentId);
  let old;
  try {
    old = await fetchImpl(`${API}/v13/deployments/${encodeURIComponent(deletedDeploymentId)}${query}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error('Vercel deletion check failed; claim remains blocked'); }
  if (old.status !== 404) throw new Error('Old Vercel deployment is not verified deleted; claim remains blocked');
  return { projectId: selected.id, deletedDeploymentId, baselineDeploymentId };
}
