import { readFile } from 'node:fs/promises';
import { createAuth } from '../lib/auth.mjs';

const signInPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Agent Village</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8f5ed; color: #233029; font: 16px/1.5 system-ui, sans-serif; }
    main { max-width: 28rem; padding: 2rem; }
    a { color: inherit; }
    .sign-in { display: inline-block; margin-top: 1rem; padding: .75rem 1rem; border-radius: .5rem; background: #233029; color: white; font-weight: 600; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <h1>Agent Village Office</h1>
    <p>Sign in with Vercel to view your office.</p>
    <a class="sign-in" href="/api/auth/login">Sign in with Vercel</a>
    <p><a href="/">Back to the demo</a></p>
  </main>
</body>
</html>`;

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
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : signInPage);
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
