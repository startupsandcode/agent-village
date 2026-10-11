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
    const provider = env.VILLAGE_PROVIDER === 'anthropic' ? 'anthropic' : 'openai';
    const configured = Boolean(env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY']);
    response.statusCode = 200;
    const officeName = typeof env.VILLAGE_OFFICE_NAME === 'string' && env.VILLAGE_OFFICE_NAME.trim().length <= 60 ? env.VILLAGE_OFFICE_NAME.trim() : '';
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ provider, providerConfigured: configured, officeName,
      runAvailable: false, reason: 'Hosted runs need a private durable project store and isolated executor. The local office can run now.' }));
  };
}

export default createMayaStatusHandler();
