import { createAuth } from '../../lib/auth.mjs';

export function createLoginHandler({ auth = createAuth() } = {}) {
  return function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET');
      response.end();
      return;
    }
    try {
      const { url, cookie } = auth.begin(request.headers?.host);
      response.statusCode = 302;
      response.setHeader('Location', url);
      response.setHeader('Set-Cookie', cookie);
      response.end();
    } catch {
      response.statusCode = 503;
      response.end('Office sign in is unavailable');
    }
  };
}

export default createLoginHandler();
