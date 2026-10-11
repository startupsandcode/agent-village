import { createAuth, officeOriginForHost } from '../lib/auth.mjs';
import { createNeonHostedRuntime } from '../lib/neon-runtime.mjs';

function send(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(value));
}

export function createMayaUsageHandler({ env = process.env, auth = createAuth({ env }), runtimeFactory = createNeonHostedRuntime } = {}) {
  return async function handler(request, response) {
    if (request.method !== 'GET') return send(response, 405, { error: 'Method not allowed' });
    const access = auth.authorize(request.headers?.cookie);
    if (access.status !== 200) return send(response, access.status, { error: 'Office access denied' });
    const operators = env.OFFICE_RUN_ALLOWED_EMAILS?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean) ?? [];
    if (!operators.includes(access.email?.toLowerCase())) return send(response, 403, { error: 'Project runs are not authorized for this viewer' });
    let runtime;
    try {
      const origin = officeOriginForHost(request.headers?.host, env);
      const fetchSite = request.headers?.['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return send(response, 403, { error: 'Same-origin office request required' });
      const url = new URL(request.url, origin);
      if ([...url.searchParams.keys()].some(key => key !== 'projectId' && key !== 'month') ||
          [...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) return send(response, 400, { error: 'Invalid usage query' });
      runtime = await runtimeFactory({ env, auth });
      return send(response, 200, await runtime.usage.summary(request.headers?.cookie,
        { projectId: url.searchParams.get('projectId'), month: url.searchParams.get('month') || new Date().toISOString().slice(0, 7) }));
    } catch (error) {
      return send(response, error.message === 'Invalid usage query' ? 400 : 503,
        { error: error.message === 'Invalid usage query' ? error.message : 'Usage records are unavailable; no cost total is shown' });
    } finally { try { await runtime?.close(); } catch { /* response already sent */ } }
  };
}

export default createMayaUsageHandler();
