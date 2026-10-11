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
    } catch (error) {
      response.statusCode = 503;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(error.message === 'Unregistered office host'
        ? 'Office sign in is unavailable on this URL. Open the configured Preview address.'
        : error.message === 'Office authentication configuration is missing'
          ? 'Office sign in is not configured for this Preview.'
          : 'Office sign in is unavailable');
    }
  };
}

export default createLoginHandler();
