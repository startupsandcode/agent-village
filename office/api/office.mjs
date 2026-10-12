import { ROSTER, readAgents } from '../lib/checkins.mjs';
import { createGitHubIssuesLoader } from '../lib/github-issues.mjs';
import { createAuth } from '../lib/auth.mjs';
import { createHostedProjectStore } from '../lib/hosted-project-store.mjs';
import { createHostedProjectAccess } from '../lib/hosted-project-access.mjs';

const unavailableReports = Object.fromEntries(ROSTER.map(({ name }) => [name, { error: true }]));
const STALE_MS = 90_000;
const stageAgent = { clarifying: 'Maya', planning: 'Maya', building: 'Sam', reviewing: 'Quinn' };

function recentActivity(stages, timestamp) {
  const byAgent = new Map();
  for (const project of stages) {
    const agent = stageAgent[project.status];
    const started = Date.parse(project.stageStartedAt);
    if (!agent || !Number.isFinite(started) || started > timestamp || timestamp - started >= STALE_MS) continue;
    const previous = byAgent.get(agent);
    if (!previous || started > Date.parse(previous.stageStartedAt)) {
      byAgent.set(agent, { name: agent, status: 'recent', projectId: project.id,
        goal: project.goal, stage: project.status, stageStartedAt: new Date(started).toISOString() });
    }
  }
  return { status: 'ok', source: 'hosted_project_stage',
    agents: ROSTER.map(({ name }) => byAgent.get(name) || { name, status: 'idle' }) };
}

async function loadActivity({ env, auth, cookie, timestamp, PoolClass }) {
  if (!env.VILLAGE_DATABASE_URL) return { status: 'unavailable', source: 'hosted_project_stage', agents: [] };
  const Pool = PoolClass ?? (await import('@neondatabase/serverless')).Pool;
  const pool = new Pool({ connectionString: env.VILLAGE_DATABASE_URL, max: 2 });
  try {
    const store = createHostedProjectStore({ query: (sql, values) => pool.query(sql, values) });
    const access = createHostedProjectAccess({ auth, store });
    const stages = await access.recentStages(cookie, new Date(timestamp - STALE_MS).toISOString());
    return recentActivity(stages, timestamp);
  } finally {
    await pool.end();
  }
}

export function createOfficeHandler({ env = process.env, token = env.GITHUB_ISSUES_TOKEN || env.GITHUB_AGENT_TOKEN,
  fetchImpl = fetch, now = Date.now, auth = createAuth({ env, now }), PoolClass } = {}) {
  const repository = env.VILLAGE_GITHUB_REPO || (env.OFFICE_ALLOWED_ORIGINS ? null : 'startupsandcode/agent-village');
  const getTasks = createGitHubIssuesLoader({ token, repo: repository, fetchImpl, now });
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
    // The issue board is independent of hosted project storage.
    const [activity, tasks] = await Promise.all([
      loadActivity({ env, auth, cookie: request.headers?.cookie, timestamp, PoolClass })
        .catch(() => ({ status: 'unavailable', source: 'hosted_project_stage', agents: [] })),
      getTasks(),
    ]);
    const body = JSON.stringify({
      generatedAt: new Date(timestamp).toISOString(),
      repository,
      checkinsConfigured: false,
      agents: readAgents(unavailableReports, timestamp),
      activity,
      tasks,
    });
    response.statusCode = 200;
    response.end(request.method === 'HEAD' ? undefined : body);
  };
}

export default createOfficeHandler();
