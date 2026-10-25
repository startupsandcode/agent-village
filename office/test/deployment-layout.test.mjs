import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECONCILE_MIN_AGE_MS } from '../lib/hosted-publish.mjs';
import { resolvePublicRoute } from '../server.mjs';

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
  const homeStyles = await read('../public/styles.css');
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

test('public Workflow explainer is a separate route linked from the unchanged team demo', async () => {
  const config = JSON.parse(await read('../vercel.json'));
  assert.ok(config.rewrites.some(rule => rule.source === '/workflow' && rule.destination === '/workflow.html'));
  assert.ok(config.rewrites.some(rule => rule.source === '/setup' && rule.destination === '/setup.html'));
  assert.equal(resolvePublicRoute('/workflow'), '/workflow.html');
  assert.equal(resolvePublicRoute('/setup'), '/setup.html');
  assert.equal(resolvePublicRoute('/'), '/');
  const home = await read('../public/index.html');
  const homeStyles = await read('../public/styles.css');
  assert.match(home, /href="\/workflow">Workflow<\/a>/);
  assert.match(home, /class="mobile-workflow" href="\/workflow">Workflow<\/a>/);
  assert.match(homeStyles, /\.site-header nav \{ display: none; \}/);
  assert.match(homeStyles, /\.mobile-workflow \{ display: inline-flex;/);
  assert.match(home, /href="#office">Demo office<\/a>/);
  assert.match(home, /href="\/setup">Setup guide<\/a>/);
  const page = await read('../public/workflow.html');
  assert.match(page, /<title>Agent Village \| Design-Led Autonomy<\/title>/);
  assert.match(page, /<h1 id="title">A visible path<br>to <span>proof\.<\/span><\/h1>/);
  assert.match(page, /href="https:\/\/agent-village\.startupsandcode\.com\/workflow"/);
  assert.match(page, /href="\/setup">Check access and setup requirements/);
  assert.match(page, /This page explains the intended route; it does not launch a mission/);
  assert.match(page, /the public pages explain the intended route; they do not launch a mission/i);
  assert.doesNotMatch(page, /github\.com\/startupsandcode\/agent-village/);
  assert.match(await read('../../README.md'), /`\/workflow` explains the design-led path/);
  assert.match(await read('../../README.md'), /`\/setup` explains public cloning, local prerequisites, and restricted hosted office access/);
  assert.match(await read('../README.md'), /public \[Workflow: Design-Led Autonomy\]\(\/workflow\)/);
  assert.match(await read('../README.md'), /public access\/setup guidance at `\/setup`/);
  assert.doesNotMatch(page, /village-preview-20261024|Internal concept|astra-4idr0wopp/);
  await stat(new URL('../public/workflow.css', import.meta.url));
  await stat(new URL('../public/workflow.js', import.meta.url));
  const setup = await read('../public/setup.html');
  assert.match(setup, /<title>Access and setup \| Agent Village<\/title>/);
  assert.match(setup, /The Agent Village GitHub repository and issue queue are public/);
  assert.match(setup, /A public clone does not grant hosted office access or authorize autonomous missions/);
  assert.match(setup, /href="https:\/\/github.com\/startupsandcode\/agent-village\/blob\/main\/docs\/first-user-setup.md"/);
  assert.match(setup, /href="https:\/\/agent-village.startupsandcode.com\/">Team demo/);
  assert.match(setup, /href="\/workflow"/);
  assert.doesNotMatch(setup, /village-interface-20261011-01|repository and issue queue are private|<form\b|mailto:/i);
});

test('hosted publisher runtime ends before a stale attempt can be reconciled', async () => {
  const config = JSON.parse(await read('../vercel.json'));
  const seconds = config.functions?.['api/maya-projects.mjs']?.maxDuration;
  assert.equal(seconds, 300);
  assert.ok(RECONCILE_MIN_AGE_MS > seconds * 1000);
});

test('private office opens on the room after project controls and keeps the work board below', async () => {
  const privatePage = await read('../private/index.html');
  assert.match(privatePage, /<main id="main">\s*<h1 class="sr-only">Village Office<\/h1>/);
  const project = privatePage.indexOf('id="project-dashboard"');
  const create = privatePage.indexOf('id="project-create-open"');
  const room = privatePage.indexOf('id="office"');
  const scene = privatePage.indexOf('class="office-layout"');
  const board = privatePage.indexOf('id="work-board"');
  assert.ok(project >= 0 && create > project && room > create && scene > room && board > scene);
  assert.doesNotMatch(privatePage, /class="intro"|The work has<br \/><em>a place to sit/);
});
