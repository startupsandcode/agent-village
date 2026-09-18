import { ROSTER, readAgents } from '../lib/checkins.mjs';
import { createGitHubIssuesLoader } from '../lib/github-issues.mjs';

const unavailableReports = Object.fromEntries(ROSTER.map(({ name }) => [name, { error: true }]));

export function createOfficeHandler({ token = process.env.GITHUB_ISSUES_TOKEN, fetchImpl = fetch, now = Date.now } = {}) {
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
    const timestamp = now();
    const body = JSON.stringify({
      generatedAt: new Date(timestamp).toISOString(),
      agents: readAgents(unavailableReports, timestamp),
      tasks: await getTasks(),
    });
    response.statusCode = 200;
    response.end(request.method === 'HEAD' ? undefined : body);
  };
}

export default createOfficeHandler();
