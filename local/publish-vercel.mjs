import { artifactDigest } from './artifact.mjs';

const API = 'https://api.vercel.com';
const namePattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

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

export async function deployReviewedPreview({ engine, id, team, project, token, fetchImpl = fetch, onBeforeSubmit = async () => {} }) {
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
  await onBeforeSubmit({ team, project, projectId: selected.id, artifactSha256: record.artifact.sha256 });
  const deployment = await request(fetchImpl, `/v13/deployments${query}`, token, { method: 'POST', body: JSON.stringify({
    name: project,
    project: selected.id,
    files: [
      { file: 'index.html', data: Buffer.from(html).toString('base64'), encoding: 'base64' },
      { file: 'styles.css', data: Buffer.from(css).toString('base64'), encoding: 'base64' },
    ],
    projectSettings: { framework: null, buildCommand: '' },
    meta: { villageProjectId: id, villageArtifactSha256: record.artifact.sha256 },
  }) });
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
