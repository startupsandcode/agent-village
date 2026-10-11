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
export function createLocalServer({ provider, providerError, engine = provider && new VillageEngine({ provider }), publicDir = join(here, 'public'), officeName = process.env.VILLAGE_OFFICE_NAME, setupRoot = engine?.root ?? join(here, '.workspaces'), connectionInspector = inspectConnections } = {}) {
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
      if (path === '/api/setup' && request.method === 'POST') {
        if (fixedOfficeName) return send(response, 409, { error: 'Office name is set by the server environment' });
        const value = await body(request);
        return send(response, 200, await saveOfficeSetup(setupRoot, value.name));
      }
      if (path === '/api/connections') {
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' });
        if (origin !== `http://${host}` || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) return send(response, 403, { error: 'Local origin required' });
        return send(response, 200, await boundedConnectionProbe());
      }
      if (path.startsWith('/api/')) {
        if (!engine) return send(response, 503, { error: providerError ?? 'Provider not configured' });
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
        const value = await readFile(join(here, 'README.md'));
        return send(response, 200, request.method === 'HEAD' ? '' : value, 'text/plain; charset=utf-8');
      }
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!Object.hasOwn(types, name)) return send(response, 404, { error: 'Not found' });
      const value = await readFile(join(publicDir, name));
      return send(response, 200, request.method === 'HEAD' ? '' : value, types[name], { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" });
    } catch (error) {
      const safe = /^(Goal and request ID required|Answer not expected|Build not expected|Project not found|Artifact not found|JSON required|Request too large|Invalid JSON|Do not put an API key in chat|Only a reviewed project can be prepared|Prepared project changed; inspect it before publishing|Office name must be 2–60 characters without markup or control characters)$/.test(error.message) ? error.message : 'Request failed';
      return send(response, safe === 'Request failed' ? 500 : 400, { error: safe });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let provider, providerError;
  try { provider = createProvider(); } catch (error) { providerError = error.message; }
  const server = createLocalServer({ provider, providerError });
  server.listen(4174, '127.0.0.1', () => console.log('Agent Village: http://127.0.0.1:4174'));
}
