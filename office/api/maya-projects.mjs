import { createAuth, officeOriginForHost } from '../lib/auth.mjs';
import { createNeonHostedRuntime } from '../lib/neon-runtime.mjs';

const shapes = {
  create: ['action', 'goal', 'requestId'],
  start: ['action', 'goal', 'requestId'],
  clarify: ['action', 'id'],
  answer: ['action', 'id', 'answer', 'requestId'],
  build: ['action', 'id', 'requestId'],
  review: ['action', 'id', 'requestId'],
  cancel: ['action', 'id'],
};
function send(response, status, value, type = 'application/json; charset=utf-8') {
  response.statusCode = status;
  response.setHeader('Content-Type', type);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
function strictBody(request) {
  if (request.headers?.['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON required');
  const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  if (!raw || Buffer.byteLength(raw) > 4096) throw new Error('Request too large');
  const body = typeof request.body === 'string' ? JSON.parse(raw) : request.body;
  const keys = typeof body?.action === 'string' && Object.hasOwn(shapes, body.action) ? shapes[body.action] : null;
  if (!keys || !body || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(body, key))) throw new Error('Invalid action');
  return body;
}

export function createHostedMayaHandler({ env = process.env, auth = createAuth({ env }), coordinator = null, runtimeFactory = null, enabled = false } = {}) {
  return async function handler(request, response) {
    if (!['GET', 'POST'].includes(request.method)) return send(response, 405, { error: 'Method not allowed' });
    const access = auth.authorize(request.headers?.cookie);
    if (access.status !== 200) return send(response, access.status, { error: 'Office access denied' });
    const operators = env.OFFICE_RUN_ALLOWED_EMAILS?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean) ?? [];
    if (!operators.includes(access.email?.toLowerCase())) return send(response, 403, { error: 'Project runs are not authorized for this viewer' });
    if (!enabled || (!coordinator && !runtimeFactory)) return send(response, 503, { error: 'Hosted project runs are not connected' });
    let runtime;
    try {
      const origin = officeOriginForHost(request.headers?.host, env);
      const fetchSite = request.headers?.['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return send(response, 403, { error: 'Same-origin office request required' });
      if (request.method === 'POST' && request.headers?.origin !== origin) return send(response, 403, { error: 'Same-origin office request required' });
      const url = request.method === 'GET' ? new URL(request.url, origin) : null;
      const id = url?.searchParams.get('id');
      if (url && (!id || [...url.searchParams.keys()].some(key => !['id', 'file'].includes(key)))) throw new Error('Project ID required');
      const file = url?.searchParams.get('file');
      const body = request.method === 'POST' ? strictBody(request) : null;
      runtime = runtimeFactory ? await runtimeFactory({ env, auth }) : null;
      const active = runtime?.coordinator ?? coordinator;
      const cookie = request.headers?.cookie;
      if (request.method === 'GET') {
        if (file) {
          const artifact = await active.artifact(cookie, id, file);
          response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'");
          return send(response, 200, artifact.content, file === 'index.html' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8');
        }
        return send(response, 200, await active.read(cookie, id));
      }
      const result = body.action === 'create' ? await active.create(cookie, body.goal, body.requestId)
        : body.action === 'start' ? await active.start(cookie, body.goal, body.requestId)
        : body.action === 'clarify' ? await active.clarify(cookie, body.id)
        : body.action === 'answer' ? await active.answer(cookie, body.id, body.answer, body.requestId)
        : body.action === 'build' ? await active.build(cookie, body.id, body.requestId)
        : body.action === 'review' ? await active.review(cookie, body.id, body.requestId)
        : await active.cancel(cookie, body.id);
      return send(response, 200, result);
    } catch (error) {
      if (['Project not found', 'Artifact not found'].includes(error.message)) return send(response, 404, { error: error.message });
      const safe = /^(Project not found|Action not expected|Cancellation not expected|Artifact not found|Goal invalid or contains a provider key|Answer invalid or contains a provider key|Request ID required|Monthly project or provider budget reached|Invalid action|JSON required|Request too large|Project ID required)$/.test(error.message);
      return send(response, safe ? 400 : 500, { error: safe ? error.message : 'Project request failed' });
    } finally { try { await runtime?.close(); } catch { /* response contains the operation result */ } }
  };
}

// Explicit activation remains off in existing deployments. Configure and verify
// the database, migration, operator allowlist and provider before enabling.
export default createHostedMayaHandler({ enabled: process.env.VILLAGE_HOSTED_RUNS_ENABLED === 'true', runtimeFactory: createNeonHostedRuntime });
