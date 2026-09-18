import { createAuth, clearAuthCookies } from '../../lib/auth.mjs';

export function createCallbackHandler({ auth = createAuth() } = {}) {
  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET');
      response.end();
      return;
    }
    response.setHeader('Set-Cookie', clearAuthCookies());
    try {
      const params = new URL(request.url, 'https://agent-village-six.vercel.app').searchParams;
      if (params.has('error')) throw new Error('Authorization denied');
      const result = await auth.complete({ code: params.get('code'), state: params.get('state'), cookie: request.headers?.cookie });
      response.statusCode = 302;
      response.setHeader('Set-Cookie', [clearAuthCookies()[0], result.sessionCookie]);
      response.setHeader('Location', '/office');
      response.end();
    } catch {
      response.statusCode = 403;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Office sign in denied');
    }
  };
}

export default createCallbackHandler();
