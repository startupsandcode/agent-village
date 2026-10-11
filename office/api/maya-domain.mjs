import { createAuth, officeOriginForHost } from '../lib/auth.mjs';
import { createNeonHostedRuntime } from '../lib/neon-runtime.mjs';
import { normalizeDomainProfile } from '../lib/hosted-domain.mjs';

function send(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(value));
}

export function createMayaDomainHandler({ env = process.env, auth = createAuth({ env }), runtimeFactory = createNeonHostedRuntime } = {}) {
  return async function handler(request, response) {
    if (!['GET', 'POST'].includes(request.method)) return send(response, 405, { error: 'Method not allowed' });
    const access = auth.authorize(request.headers?.cookie);
    if (access.status !== 200) return send(response, access.status, { error: 'Office access denied' });
    const operators = env.OFFICE_RUN_ALLOWED_EMAILS?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean) ?? [];
    if (!operators.includes(access.email?.toLowerCase())) return send(response, 403, { error: 'Project runs are not authorized for this viewer' });
    let runtime;
    try {
      const origin = officeOriginForHost(request.headers?.host, env);
      const fetchSite = request.headers?.['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return send(response, 403, { error: 'Same-origin office request required' });
      if (request.method === 'POST' && request.headers?.origin !== origin) return send(response, 403, { error: 'Same-origin office request required' });
      const url = new URL(request.url, origin);
      if (url.search || url.pathname !== '/api/maya-domain') return send(response, 400, { error: 'Invalid domain request' });
      let body = null;
      if (request.method === 'POST') {
        if (request.headers?.['content-type']?.split(';')[0] !== 'application/json') return send(response, 400, { error: 'JSON required' });
        const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        if (!raw || Buffer.byteLength(raw) > 4096) return send(response, 400, { error: 'Request too large' });
        try { body = typeof request.body === 'string' ? JSON.parse(raw) : request.body; }
        catch { return send(response, 400, { error: 'Invalid domain answers' }); }
        body = normalizeDomainProfile(body);
      }
      runtime = await runtimeFactory({ env, auth });
      return send(response, 200, request.method === 'GET'
        ? await runtime.domain.read(request.headers?.cookie)
        : await runtime.domain.save(request.headers?.cookie, body));
    } catch (error) {
      const safe = ['Domain answers must be text under 500 characters each', 'Do not put an API key in domain answers'].includes(error.message);
      return send(response, safe ? 400 : 503, { error: safe ? error.message : 'Domain answers are unavailable' });
    } finally { try { await runtime?.close(); } catch { /* response already sent */ } }
  };
}

export default createMayaDomainHandler();
