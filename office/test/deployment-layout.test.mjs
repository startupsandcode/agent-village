import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('one deployment serves synthetic home and keeps private HTML outside public', async () => {
  const config = JSON.parse(await read('../vercel.json'));
  assert.equal(config.outputDirectory, 'public');
  assert.ok(config.rewrites.some(rule => rule.source === '/office' && rule.destination === '/api/private-page'));
  const home = await read('../public/index.html');
  assert.match(home, /Public demo/i);
  assert.match(home, /href="\/office"/);
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
