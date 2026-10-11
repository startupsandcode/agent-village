#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from './providers.mjs';
import { VillageEngine } from './engine.mjs';
import { exportProject } from './export.mjs';
import { readOfficeSetup, saveOfficeSetup, validOfficeName } from './setup.mjs';
import { inspectConnections } from './connections.mjs';
import { loadLocalEnv } from './env.mjs';
import { readDomainProfile, saveDomainProfile } from './domain.mjs';
import { publishReviewedSite } from './publish-github.mjs';
import { deployReviewedPreview, inspectPreviewDeployment, UnsafeVercelDeploymentError } from './publish-vercel.mjs';
import { beginPreviewPublish, completePreviewPublish, readPreviewPublish, recordUnsafePreviewPublish } from './publish-state.mjs';
import { readLocalUsage } from './usage.mjs';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'office.js': 'text/javascript; charset=utf-8', 'office-data.mjs': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
function send(response, status, value, type = 'application/json; charset=utf-8', extra = {}) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
  response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
async function body(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON required');
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 4096) throw new Error('Request too large'); }
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
}
export function createLocalServer({ provider, providerError, engine = provider && new VillageEngine({ provider }), publicDir = join(here, 'public'), officeName = process.env.VILLAGE_OFFICE_NAME, setupRoot = engine?.root ?? join(here, '.workspaces'), connectionInspector = inspectConnections, env = process.env, githubPublisher = publishReviewedSite, vercelPublisher = deployReviewedPreview, deploymentInspector = inspectPreviewDeployment } = {}) {
  const fixedOfficeName = validOfficeName(officeName) ? officeName.trim() : '';
  let connectionProbe = null;
  let lastConnectionResult = null;
  let lastConnectionProbeAt = 0;
  async function boundedConnectionProbe() {
    if (connectionProbe) return connectionProbe;
    if (lastConnectionResult && Date.now() - lastConnectionProbeAt < 30_000) return lastConnectionResult;
    lastConnectionProbeAt = Date.now();
    connectionProbe = Promise.resolve().then(() => connectionInspector()).catch(() => ({ github: { state: 'unavailable' }, vercel: { state: 'unavailable' } })).then(result => {
      lastConnectionResult = result;
      return result;
    }).finally(() => { connectionProbe = null; });
    return connectionProbe;
  }
  return createServer(async (request, response) => {
    const host = request.headers.host ?? '';
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(host)) return send(response, 403, { error: 'Local host required' });
    const origin = request.headers.origin;
    if (request.method !== 'GET' && request.method !== 'HEAD' && origin && ![`http://${host}`, `http://127.0.0.1:${host.split(':')[1] ?? '80'}`, `http://localhost:${host.split(':')[1] ?? '80'}`].includes(origin)) return send(response, 403, { error: 'Local origin required' });
    let path;
    try { path = new URL(request.url, `http://${host}`).pathname; } catch { return send(response, 400, { error: 'Bad path' }); }
    try {
      if (path === '/api/status' && request.method === 'GET') {
        const setup = await readOfficeSetup(setupRoot);
        return send(response, 200, { ready: !!engine, provider: provider?.name ?? null, model: provider?.model ?? null, error: providerError ?? null, officeName: fixedOfficeName || setup.name, officeNameEditable: !fixedOfficeName });
      }
      if (path === '/api/usage' && request.method === 'GET') {
        const url = new URL(request.url, `http://${host}`);
        if ([...url.searchParams.keys()].some(key => key !== 'projectId' && key !== 'month') ||
            [...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) return send(response, 400, { error: 'Invalid usage query' });
        return send(response, 200, await readLocalUsage({ root: setupRoot, projectId: url.searchParams.get('projectId'), month: url.searchParams.get('month') || undefined }));
      }
      if (path === '/api/setup' && request.method === 'POST') {
        if (fixedOfficeName) return send(response, 409, { error: 'Office name is set by the server environment' });
        const value = await body(request);
        return send(response, 200, await saveOfficeSetup(setupRoot, value.name));
      }
      if (path === '/api/domain' && request.method === 'GET') {
        const profile = await readDomainProfile(setupRoot);
        if (Object.values(profile).some(item => provider?.containsSecret?.(item))) return send(response, 400, { error: 'Do not put an API key in domain answers' });
        return send(response, 200, profile);
      }
      if (path === '/api/domain' && request.method === 'POST') {
        if (origin !== `http://${host}` || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) return send(response, 403, { error: 'Local origin required' });
        const value = await body(request);
        if (Object.values(value ?? {}).some(item => provider?.containsSecret?.(item))) return send(response, 400, { error: 'Do not put an API key in domain answers' });
        return send(response, 200, await saveDomainProfile(setupRoot, value));
      }
      if (path === '/api/connections') {
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' });
        if (origin !== `http://${host}` || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) return send(response, 403, { error: 'Local origin required' });
        return send(response, 200, await boundedConnectionProbe());
      }
      if (path.startsWith('/api/')) {
        if (!engine) return send(response, 503, { error: providerError ?? 'Provider not configured' });
        const publishing = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/publish(?:\/(github|vercel))?$/);
        if (publishing) {
          const [, id, service] = publishing;
          const project = await engine.get(id);
          if (project.status !== 'reviewed' || !project.artifact) return send(response, 409, { error: 'Only a reviewed project can be published' });
          if (!service && request.method === 'GET') {
            const receipt = await readPreviewPublish(engine, id);
            if (receipt?.status === 'submitted' && env.VILLAGE_PUBLISH_VERCEL_TOKEN) {
              try { return send(response, 200, { preview: await deploymentInspector({ receipt, token: env.VILLAGE_PUBLISH_VERCEL_TOKEN }) }); }
              catch { return send(response, 200, { preview: { ...receipt, lastObservedState: receipt.state, state: 'STATUS_UNAVAILABLE' } }); }
            }
            return send(response, 200, { preview: receipt });
          }
          if (request.method !== 'POST' || !service) return send(response, 405, { error: 'Method not allowed' });
          if (origin !== `http://${host}` || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) return send(response, 403, { error: 'Local origin required' });
          const value = await body(request);
          if (!value || typeof value !== 'object' || Array.isArray(value)) return send(response, 400, { error: 'Publishing target required' });
          if (service === 'github') {
            if (!env.VILLAGE_PUBLISH_GITHUB_TOKEN) return send(response, 503, { error: 'GitHub publishing token missing on the server' });
            const result = await githubPublisher({ engine, id, owner: value.owner, repo: value.repo, branch: value.branch, token: env.VILLAGE_PUBLISH_GITHUB_TOKEN });
            await engine.recordPublish(id, 'github', result);
            return send(response, 200, result);
          }
          if (!env.VILLAGE_PUBLISH_VERCEL_TOKEN) return send(response, 503, { error: 'Vercel publishing token missing on the server' });
          const existing = await readPreviewPublish(engine, id);
          if (existing) {
            if (existing.team !== value.team || existing.project !== value.project || existing.artifactSha256 !== project.artifact.sha256) return send(response, 409, { error: 'Preview target or reviewed files differ from the saved submission' });
            if (existing.status === 'submitted') await engine.recordPublish(id, 'vercel', existing);
            return send(response, existing.status === 'submitted' ? 200 : 409, existing.status === 'submitted'
              ? { preview: existing } : { error: 'Preview submission uncertain; inspect Vercel before retrying', preview: existing });
          }
          let result;
          try {
            result = await vercelPublisher({ engine, id, team: value.team, project: value.project, token: env.VILLAGE_PUBLISH_VERCEL_TOKEN,
              onBeforeSubmit: target => beginPreviewPublish(engine, id, target) });
          } catch (error) {
            if (error instanceof UnsafeVercelDeploymentError) {
              const receipt = await recordUnsafePreviewPublish(engine, id, error.receipt);
              return send(response, 409, { error: 'Vercel returned a non-Preview deployment; inspect target and protection. Automatic retry is blocked.', preview: receipt });
            }
            throw error;
          }
          await completePreviewPublish(engine, id, result);
          await engine.recordPublish(id, 'vercel', result);
          return send(response, 200, { preview: { status: 'submitted', ...result } });
        }
        if (path === '/api/projects' && request.method === 'POST') {
          const value = await body(request);
          return send(response, 200, await engine.create(value.goal, value.requestId));
        }
        const match = path.match(/^\/api\/projects\/([0-9a-f-]{36})(?:\/(answer|build|cancel|export))?$/);
        if (!match) return send(response, 404, { error: 'Not found' });
        const [, id, action] = match;
        if (!action && request.method === 'GET') return send(response, 200, await engine.get(id));
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' });
        if (action === 'cancel') return send(response, 200, await engine.cancel(id));
        if (action === 'export') return send(response, 200, await exportProject(engine, id));
        const value = await body(request);
        if (action === 'answer') return send(response, 200, await engine.answer(id, value.answer, value.requestId));
        if (action === 'build') return send(response, 202, await engine.build(id, value.requestId));
      }
      const artifact = path.match(/^\/artifact\/([0-9a-f-]{36})\/(index\.html|styles\.css)$/);
      if (artifact && request.method === 'GET') {
        const value = await engine.artifact(artifact[1], artifact[2]);
        return send(response, 200, value, types[artifact[2]], { 'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'" });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { error: 'Method not allowed' });
      if (path === '/office-assets/styles.css') {
        const value = await readFile(join(here, '..', 'office', 'public', 'office-assets', 'styles.css'));
        return send(response, 200, request.method === 'HEAD' ? '' : value, 'text/css; charset=utf-8');
      }
      if (path === '/setup') {
        const value = await readFile(join(here, '..', 'office', 'public', 'setup.html'));
        return send(response, 200, request.method === 'HEAD' ? '' : value, 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
      }
      if (path === '/setup.css') {
        const value = await readFile(join(here, '..', 'office', 'public', 'setup.css'));
        return send(response, 200, request.method === 'HEAD' ? '' : value, 'text/css; charset=utf-8');
      }
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!Object.hasOwn(types, name)) return send(response, 404, { error: 'Not found' });
      const value = await readFile(join(publicDir, name));
      return send(response, 200, request.method === 'HEAD' ? '' : value, types[name], { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" });
    } catch (error) {
      const safe = /^(Goal and request ID required|Answer not expected|Build not expected|Project not found|Artifact not found|Invalid usage query|JSON required|Request too large|Invalid JSON|Do not put an API key in chat|Do not put an API key in domain answers|Domain answers must be text under 500 characters each|Only a reviewed project can be prepared|Prepared project changed; inspect it before publishing|Office name must be 2–60 characters without markup or control characters|Only a reviewed project can be published|GitHub publishing credential is missing|Vercel publishing token missing on the server|Exact Vercel team and project names required|Vercel target must be an existing static project at its root with no Git link or custom build settings|A Preview publish already exists; inspect its status before retrying|GitHub target must be the requested writable private repository|GitHub target contains automation configuration; use a dedicated inert repository|Publishing requires a non-default branch|GitHub target branch must exist and be unprotected|GitHub branch already contains delivery files; choose a clean branch|Publishing to this branch is already in progress|Preview submission uncertain; inspect Vercel before retrying|Preview target or reviewed files differ from the saved submission|Publishing cancelled or timed out(?:; check the branch before retrying)?|GitHub request failed \([0-9]{3}\); check repository access, branch, or conflict|Vercel request failed \([0-9]{3}\); no response body was logged|Invalid GitHub (?:owner|repository|branch))$/.test(error.message) ? error.message : 'Publishing or project request failed';
      return send(response, safe === 'Publishing or project request failed' ? 500 : 400, { error: safe });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await loadLocalEnv();
  let provider, providerError;
  try { provider = createProvider(); } catch (error) { providerError = error.message; }
  const server = createLocalServer({ provider, providerError });
  server.listen(4174, '127.0.0.1', () => console.log('Agent Village: http://127.0.0.1:4174'));
}
