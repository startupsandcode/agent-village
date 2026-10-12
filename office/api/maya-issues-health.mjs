import { createAuth, officeOriginForHost } from '../lib/auth.mjs';
import { createGitHubIssuesLoader } from '../lib/github-issues.mjs';

function send(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(value));
}

export function createMayaIssuesHealthHandler({ env = process.env, auth = createAuth({ env }), fetchImpl = fetch, now = Date.now } = {}) {
  const repository = env.VILLAGE_GITHUB_REPO || (env.OFFICE_ALLOWED_ORIGINS ? null : 'startupsandcode/agent-village');
  const getTasks = createGitHubIssuesLoader({ token: env.GITHUB_ISSUES_TOKEN || env.GITHUB_AGENT_TOKEN,
    repo: repository, fetchImpl, now, diagnostics: true });
  return async function handler(request, response) {
    if (request.method !== 'GET') return send(response, 405, { error: 'Method not allowed' });
    const access = auth.authorize(request.headers?.cookie);
    if (access.status !== 200) return send(response, access.status, { error: 'Office access denied' });
    const operators = env.OFFICE_RUN_ALLOWED_EMAILS?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean) ?? [];
    if (!operators.includes(access.email?.toLowerCase())) return send(response, 403, { error: 'Office operator required' });
    try {
      officeOriginForHost(request.headers?.host, env);
      const site = request.headers?.['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(response, 403, { error: 'Same-origin office request required' });
    } catch { return send(response, 403, { error: 'Same-origin office request required' }); }
    const tasks = await getTasks();
    return send(response, 200, tasks.status === 'ok' ? { ready: true, issueCount: tasks.items.length }
      : { ready: false, diagnostic: tasks.diagnostic });
  };
}

export default createMayaIssuesHealthHandler();
