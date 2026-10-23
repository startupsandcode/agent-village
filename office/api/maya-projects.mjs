import { createAuth, officeOriginForHost } from '../lib/auth.mjs';
import { createNeonHostedRuntime } from '../lib/neon-runtime.mjs';

const shapes = {
  create: ['action', 'goal', 'requestId'],
  start: ['action', 'goal', 'requestId'],
  clarify: ['action', 'id'],
  retryQuestion: ['action', 'id', 'requestId'],
  answer: ['action', 'id', 'answer', 'requestId'],
  build: ['action', 'id', 'requestId'],
  revise: ['action', 'id', 'requestId'],
  review: ['action', 'id', 'requestId'],
  cancel: ['action', 'id'],
  archive: ['action', 'id', 'expectedVersion'],
  restore: ['action', 'id', 'expectedVersion'],
  publishStatus: ['action', 'id'],
  publishGithub: ['action', 'id', 'artifactSha256', 'targetFingerprint'],
  publishVercel: ['action', 'id', 'artifactSha256', 'targetFingerprint'],
  reconcileVercel: ['action', 'id', 'artifactSha256', 'targetFingerprint', 'deletedDeploymentId', 'baselineDeploymentId', 'attemptStartedAt', 'attemptId'],
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

export function createHostedMayaHandler({ env = process.env, auth = createAuth({ env }), coordinator = null, publisher = null, runtimeFactory = null, enabled = false } = {}) {
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
      const queryKeys = [...(url?.searchParams.keys() ?? [])];
      if (url && (queryKeys.some(key => !['id', 'file', 'offset', 'archived'].includes(key)) || new Set(queryKeys).size !== queryKeys.length ||
          (id ? queryKeys.includes('offset') || queryKeys.includes('archived') : queryKeys.includes('file') || queryKeys.includes('id')))) throw new Error('Project ID required');
      const file = url?.searchParams.get('file');
      const offsetText = url?.searchParams.get('offset') ?? '0';
      const archivedText = url?.searchParams.get('archived') ?? 'false';
      if (url && !['true', 'false'].includes(archivedText)) throw new Error('Invalid project view');
      if (url && !id && (!/^(0|[1-9][0-9]{0,6})$/.test(offsetText) || Number(offsetText) > 1_000_000)) throw new Error('Invalid project offset');
      const body = request.method === 'POST' ? strictBody(request) : null;
      runtime = runtimeFactory ? await runtimeFactory({ env, auth }) : null;
      const active = runtime?.coordinator ?? coordinator;
      const publishing = runtime?.publisher ?? publisher;
      const cookie = request.headers?.cookie;
      if (request.method === 'GET') {
        if (!id) return send(response, 200, await active.list(cookie, Number(offsetText), archivedText === 'true'));
        if (file) {
          const artifact = await active.artifact(cookie, id, file);
          response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'");
          return send(response, 200, artifact.content, file === 'index.html' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8');
        }
        return send(response, 200, await active.read(cookie, id));
      }
      if (body.action === 'publishStatus') {
        if (!publishing) return send(response, 503, { error: 'Hosted publishing is not connected' });
        return send(response, 200, await publishing.status(cookie, body.id));
      }
      if (body.action === 'publishGithub' || body.action === 'publishVercel') {
        if (!publishing) return send(response, 503, { error: 'Hosted publishing is not connected' });
        return send(response, 200, await publishing.publish(cookie, body.id, body.action === 'publishGithub' ? 'github' : 'vercel', body.artifactSha256, body.targetFingerprint));
      }
      if (body.action === 'reconcileVercel') {
        if (!publishing) return send(response, 503, { error: 'Hosted publishing is not connected' });
        return send(response, 200, await publishing.reconcileVercel(cookie, body.id, body.artifactSha256,
          body.targetFingerprint, body.deletedDeploymentId, body.baselineDeploymentId, body.attemptStartedAt, body.attemptId));
      }
      const result = body.action === 'archive' ? await active.archive(cookie, body.id, body.expectedVersion)
        : body.action === 'restore' ? await active.restore(cookie, body.id, body.expectedVersion)
        : body.action === 'create' ? await active.create(cookie, body.goal, body.requestId)
        : body.action === 'start' ? await active.start(cookie, body.goal, body.requestId)
        : body.action === 'clarify' ? await active.clarify(cookie, body.id)
        : body.action === 'retryQuestion' ? await active.retryQuestion(cookie, body.id, body.requestId)
        : body.action === 'answer' ? await active.answer(cookie, body.id, body.answer, body.requestId)
        : body.action === 'build' ? await active.build(cookie, body.id, body.requestId)
        : body.action === 'revise' ? await active.revise(cookie, body.id, body.requestId)
        : body.action === 'review' ? await active.review(cookie, body.id, body.requestId)
        : await active.cancel(cookie, body.id);
      return send(response, 200, result);
    } catch (error) {
      if (['Project not found', 'Artifact not found'].includes(error.message)) return send(response, 404, { error: error.message });
      if (error.message === 'Hosted usage migration is not ready') return send(response, 503, { error: 'Hosted usage migration is not ready' });
      if (error.message === 'Hosted domain migration is not ready') return send(response, 503, { error: 'Hosted domain migration is not ready' });
      if (['Project changed; refresh and try again', 'Project is busy; wait for work or inspect publishing first', 'Project is archived; restore it first'].includes(error.message)) return send(response, 409, { error: error.message });
      if (error.message === 'Publish target changed; refresh status') return send(response, 409, { error: error.message });
      if (/^(Vercel publish attempt changed; refresh status|Vercel submission may still be active; wait before reconciling|Only an uncertain Vercel submission can be reconciled|Vercel deployment inventory changed; manual inspection required|Old Vercel deployment is not verified deleted; claim remains blocked|Protected Vercel reconciliation target changed|Vercel deletion check failed; claim remains blocked|Exact Vercel reconciliation target and deployment IDs required|Vercel deletion evidence changed)$/.test(error.message)) {
        return send(response, 409, { error: error.message });
      }
      const safe = /^(Project not found|Action not expected|Cancellation not expected|Artifact not found|Goal invalid or contains a provider key|Answer invalid or contains a provider key|Request ID required|Monthly project or provider budget reached|Invalid action|JSON required|Request too large|Project ID required|Invalid project offset|Invalid project view|Invalid project version|Reviewed artifact receipt required|Invalid publish action|GitHub publishing is not configured|Vercel publishing is not configured|Publish target or reviewed receipt changed|Publish claim changed; inspect status|Publishing stopped before target update; setup can be corrected and retried)$/.test(error.message);
      return send(response, safe ? 400 : 500, { error: safe ? error.message : 'Project request failed' });
    } finally { try { await runtime?.close(); } catch { /* response contains the operation result */ } }
  };
}

// Explicit activation remains off in existing deployments. Configure and verify
// the database, migration, operator allowlist and provider before enabling.
export default createHostedMayaHandler({ enabled: process.env.VILLAGE_HOSTED_RUNS_ENABLED === 'true', runtimeFactory: createNeonHostedRuntime });
