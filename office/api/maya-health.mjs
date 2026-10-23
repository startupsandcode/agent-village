import { createAuth, officeOriginForHost } from '../lib/auth.mjs';

const tables = ['village_projects', 'village_monthly_budget', 'village_budget_claims'];
function safeIssue(error) {
  return error?.code === '42P01' ? 'missing_table' : error?.code === '42501' ? 'permission_denied' : 'unavailable';
}
function send(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(value));
}

export function createMayaHealthHandler({ env = process.env, auth = createAuth({ env }), PoolClass } = {}) {
  return async function handler(request, response) {
    if (request.method !== 'GET') return send(response, 405, { error: 'Method not allowed' });
    const access = auth.authorize(request.headers?.cookie);
    if (access.status !== 200) return send(response, access.status, { error: 'Office access denied' });
    const operators = env.OFFICE_RUN_ALLOWED_EMAILS?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean) ?? [];
    if (!operators.includes(access.email?.toLowerCase())) return send(response, 403, { error: 'Project runs are not authorized for this viewer' });
    try {
      officeOriginForHost(request.headers?.host, env);
      const fetchSite = request.headers?.['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return send(response, 403, { error: 'Same-origin office request required' });
      if (!env.VILLAGE_DATABASE_URL) return send(response, 503, { ready: false, error: 'Hosted database is not configured' });
      const Pool = PoolClass ?? (await import('@neondatabase/serverless')).Pool;
      const pool = new Pool({ connectionString: env.VILLAGE_DATABASE_URL, max: 1,
        connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, query_timeout: 5000 });
      try {
        for (const table of tables) await pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
        let usageReady = false; let usageIssue = null;
        try { await pool.query('SELECT 1 FROM village_provider_usage LIMIT 0'); usageReady = true; }
        catch (error) { usageIssue = safeIssue(error); }
        let domainReady = false;
        try { await pool.query('SELECT 1 FROM village_domain_profiles LIMIT 0'); domainReady = true; }
        catch { /* additive 003 migration is still pending */ }
        return send(response, 200, { ready: true, tables, usageReady, usageIssue, domainReady });
      } finally { await pool.end(); }
    } catch { return send(response, 503, { ready: false, error: 'Database schema or access is not ready' }); }
  };
}

export default createMayaHealthHandler();
