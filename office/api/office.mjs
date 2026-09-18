import { ROSTER, readAgents } from '../lib/checkins.mjs';
import { createGitHubIssuesLoader } from '../lib/github-issues.mjs';
import { createAuth } from '../lib/auth.mjs';

const unavailableReports = Object.fromEntries(ROSTER.map(({ name }) => [name, { error: true }]));

export function createOfficeHandler({ env = process.env, token = env.GITHUB_ISSUES_TOKEN || env.GITHUB_AGENT_TOKEN, fetchImpl = fetch, now = Date.now, auth = createAuth({ env, now }) } = {}) {
  const getTasks = createGitHubIssuesLoader({ token, fetchImpl, now });
  return async function handler(request, response) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET, HEAD');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const access = auth.authorize(request.headers?.cookie);
    if (access.status !== 200) {
      response.statusCode = access.status;
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error: access.status === 503 ? 'Office unavailable' : 'Office access denied' }));
      return;
    }
    const timestamp = now();
    const body = JSON.stringify({
      generatedAt: new Date(timestamp).toISOString(),
      checkinsConfigured: false,
      agents: readAgents(unavailableReports, timestamp),
      tasks: await getTasks(),
    });
    response.statusCode = 200;
    response.end(request.method === 'HEAD' ? undefined : body);
  };
}

export default createOfficeHandler();
