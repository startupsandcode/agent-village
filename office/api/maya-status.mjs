import { createAuth } from '../lib/auth.mjs';

export function createMayaStatusHandler({ env = process.env, auth = createAuth({ env }) } = {}) {
  return function handler(request, response) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.statusCode = 405; response.setHeader('Allow', 'GET, HEAD'); response.end(JSON.stringify({ error: 'Method not allowed' })); return;
    }
    const access = auth.authorize(request.headers?.cookie);
    if (access.status !== 200) {
      response.statusCode = access.status;
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error: 'Office access denied' })); return;
    }
    const provider = env.VILLAGE_PROVIDER ?? 'openai';
    const keyPresent = provider === 'openai' ? Boolean(env.OPENAI_API_KEY) : provider === 'anthropic' ? Boolean(env.ANTHROPIC_API_KEY) : false;
    const runOperators = env.OFFICE_RUN_ALLOWED_EMAILS?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean) ?? [];
    const runOperator = runOperators.includes(access.email?.toLowerCase());
    const databaseConfigured = Boolean(env.VILLAGE_DATABASE_URL);
    const pilotModel = (!env.VILLAGE_OPENAI_MODEL || env.VILLAGE_OPENAI_MODEL === 'gpt-4.1-mini') &&
      (!env.VILLAGE_ANTHROPIC_MODEL || env.VILLAGE_ANTHROPIC_MODEL === 'claude-sonnet-5-5');
    const runAvailable = env.VILLAGE_HOSTED_RUNS_ENABLED === 'true' && ['openai', 'anthropic'].includes(provider) && runOperator && keyPresent && databaseConfigured && pilotModel;
    response.statusCode = 200;
    const officeName = typeof env.VILLAGE_OFFICE_NAME === 'string' && env.VILLAGE_OFFICE_NAME.trim().length <= 60 ? env.VILLAGE_OFFICE_NAME.trim() : '';
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ provider, providerKeyPresent: keyPresent, officeName,
      viewerEmail: access.email, operatorAllowlistPresent: runOperators.length > 0,
      runAvailable, reason: runAvailable ? 'Hosted test mode is enabled. Provider and database behavior are unverified until a request succeeds.' : 'Hosted runs need private project storage, operator permission, a server-side provider key, and explicit activation. The local office can run now.',
      setup: {
        viewerSignIn: 'connected',
        runPermission: runOperator ? 'configured_unverified' : 'not_authorized',
        provider: keyPresent ? 'key_present_unverified' : 'missing_key',
        durableProjects: databaseConfigured ? 'configured_unverified' : 'not_connected',
        isolatedExecutor: 'not_required_for_static_sites',
        githubPublishing: env.VILLAGE_PUBLISH_GITHUB_TOKEN && env.VILLAGE_PUBLISH_GITHUB_OWNER && env.VILLAGE_PUBLISH_GITHUB_REPO &&
          env.VILLAGE_PUBLISH_GITHUB_BRANCH && env.VILLAGE_PUBLISH_GITHUB_DEDICATED_REPO_CONFIRMED === 'true' ? 'configured_unverified' : 'not_connected',
        vercelPublishing: env.VILLAGE_PUBLISH_VERCEL_TOKEN && env.VILLAGE_PUBLISH_VERCEL_TEAM && env.VILLAGE_PUBLISH_VERCEL_PROJECT ? 'configured_unverified' : 'not_connected',
      } }));
  };
}

export default createMayaStatusHandler();
