import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECONCILE_MIN_AGE_MS } from '../lib/hosted-publish.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('hosted function imports stay inside the Vercel root directory', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pending = [join(root, 'api')];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const details = await stat(path);
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) pending.push(join(path, entry));
      continue;
    }
    if (!path.endsWith('.mjs')) continue;
    const source = await readFile(path, 'utf8');
    for (const [, specifier] of source.matchAll(/\b(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const dependency = resolve(dirname(path), specifier);
      assert.ok(!relative(root, dependency).startsWith('..'), `${path} imports outside the Vercel root: ${specifier}`);
      await stat(dependency);
      pending.push(dependency);
    }
  }
});

test('one deployment serves synthetic home and keeps private HTML outside public', async () => {
  const config = JSON.parse(await read('../vercel.json'));
  assert.equal(config.outputDirectory, 'public');
  assert.ok(config.rewrites.some(rule => rule.source === '/office' && rule.destination === '/api/private-page'));
  const home = await read('../public/index.html');
  assert.match(home, /Public demo/i);
  assert.match(home, /href="\/office"/);
  assert.match(home, /href="#office">Demo office/);
  assert.match(home, /\/_vercel\/insights\/script\.js/);
  assert.doesNotMatch(home, /agent-village-demo-jmanns-projects\.vercel\.app/);
  const data = JSON.parse(await read('../public/demo-data.json'));
  assert.ok(data.tasks.items.length > 0);
  assert.equal(data.tasks.items.some(item => /github\.com\/startupsandcode\/agent-village\/issues\//.test(item.url)), false);
  const privatePage = await read('../private/index.html');
  assert.match(privatePage, /Private office/);
  assert.doesNotMatch(privatePage, /\/_vercel\/insights\/script\.js|window\.va/);
  assert.match(privatePage, /\/office-assets\/app\.js/);
  await assert.rejects(stat(new URL('../public/office/index.html', import.meta.url)));
  await assert.rejects(stat(new URL('../public/office', import.meta.url)));
  await stat(new URL('../public/office-assets/app.js', import.meta.url));
  await stat(new URL('../public/office-assets/styles.css', import.meta.url));
});

test('hosted publisher runtime ends before a stale attempt can be reconciled', async () => {
  const config = JSON.parse(await read('../vercel.json'));
  const seconds = config.functions?.['api/maya-projects.mjs']?.maxDuration;
  assert.equal(seconds, 300);
  assert.ok(RECONCILE_MIN_AGE_MS > seconds * 1000);
});
