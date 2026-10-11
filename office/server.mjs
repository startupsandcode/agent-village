#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCheckins, readAgents } from './lib/checkins.mjs';
import { createTaskLoader } from './lib/tasks.mjs';

const officeDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function respond(response, status, body, type = 'text/plain; charset=utf-8', head = false) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(head ? undefined : body);
}

async function serveStatic(pathname, response, publicDir, head) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return respond(response, 400, 'Bad path', undefined, head); }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes(':') || decoded.split('/').some(part => part.startsWith('.'))) {
    return respond(response, 404, 'Not found', undefined, head);
  }
  const file = resolve(publicDir, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!file.startsWith(`${resolve(publicDir)}${sep}`)) return respond(response, 404, 'Not found', undefined, head);
  try {
    const [root, target, details] = await Promise.all([realpath(publicDir), realpath(file), stat(file)]);
    if (!target.startsWith(`${root}${sep}`) || !details.isFile()) return respond(response, 404, 'Not found', undefined, head);
    const body = await readFile(target);
    return respond(response, 200, body, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', head);
  } catch {
    return respond(response, 404, 'Not found', undefined, head);
  }
}

export function createOfficeServer({
  checkinDir = resolve(officeDir, '.local', 'checkins'),
  publicDir = resolve(officeDir, 'public'),
  privatePageFile = resolve(officeDir, 'private', 'index.html'),
  now = Date.now,
  getTasks = createTaskLoader({ repo: process.env.VILLAGE_GITHUB_REPO || null }),
} = {}) {
  return createServer(async (request, response) => {
    const head = request.method === 'HEAD';
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(request.headers.host ?? '')) return respond(response, 403, 'Local host required', undefined, head);
    if (request.method !== 'GET' && !head) return respond(response, 405, 'Method not allowed');
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { return respond(response, 400, 'Bad path', undefined, head); }
    if (pathname === '/api/office') {
      let reports;
      try { reports = await loadCheckins(checkinDir); } catch { reports = Object.fromEntries(['Maya', 'Sam', 'Quinn', 'Theo', 'Susie'].map(name => [name, { error: true }])); }
      let tasks;
      try { tasks = await getTasks(); } catch { tasks = { status: 'error', updatedAt: null, items: [] }; }
      const body = JSON.stringify({ generatedAt: new Date(now()).toISOString(), repository: process.env.VILLAGE_GITHUB_REPO || null, agents: readAgents(reports, now()), tasks });
      return respond(response, 200, body, 'application/json; charset=utf-8', head);
    }
    if (pathname.startsWith('/api/')) return respond(response, 404, 'Not found', undefined, head);
    if (pathname === '/office') {
      try { return respond(response, 200, await readFile(privatePageFile), 'text/html; charset=utf-8', head); }
      catch { return respond(response, 404, 'Not found', undefined, head); }
    }
    return serveStatic(pathname, response, publicDir, head);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createOfficeServer();
  server.listen(4173, '127.0.0.1', () => console.log('Village Office: http://127.0.0.1:4173'));
}
