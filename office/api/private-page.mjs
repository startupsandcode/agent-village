import { readFile } from 'node:fs/promises';
import { createAuth } from '../lib/auth.mjs';

export function createPrivatePageHandler({ auth = createAuth(), readPage = () => readFile(new URL('../private/index.html', import.meta.url), 'utf8') } = {}) {
  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET, HEAD');
      response.end();
      return;
    }
    const access = auth.authorize(request.headers?.cookie);
    if (access.status === 401) {
      response.statusCode = 302;
      response.setHeader('Location', '/api/auth/login');
      response.end();
      return;
    }
    if (access.status !== 200) {
      response.statusCode = access.status;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : 'Office access denied');
      return;
    }
    try {
      const page = await readPage();
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : page);
    } catch {
      response.statusCode = 503;
      response.end();
    }
  };
}

export default createPrivatePageHandler();
