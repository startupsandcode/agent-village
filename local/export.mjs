import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactDigest } from './artifact.mjs';

function digest(html, css) { return artifactDigest(html, css); }
function supportFiles(sha256) {
  return {
    'package.json': JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test verify.test.mjs' } }, null, 2) + '\n',
    'verify.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile, readdir } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\ntest('site contains only reviewed delivery files and matching receipt', async () => {\n  const expected = ['.vercelignore', 'README.md', 'index.html', 'package.json', 'styles.css', 'verify.test.mjs'];\n  const entries = await readdir(new URL('.', import.meta.url), { withFileTypes: true });\n  const delivery = entries.filter(item => !['.git', '.vercel'].includes(item.name));\n  assert.deepEqual(delivery.map(item => item.name).sort(), expected.sort());\n  assert.ok(delivery.every(item => item.isFile() && !item.isSymbolicLink()));\n  assert.ok(entries.filter(item => ['.git', '.vercel'].includes(item.name)).every(item => item.isDirectory() && !item.isSymbolicLink()));\n  assert.equal(await readFile(new URL('./.vercelignore', import.meta.url), 'utf8'), '.git\\n.vercel\\n');\n  const html = await readFile(new URL('./index.html', import.meta.url));\n  const css = await readFile(new URL('./styles.css', import.meta.url));\n  const part = value => createHash('sha256').update(value).digest();\n  assert.equal(createHash('sha256').update(part(html)).update(part(css)).digest('hex'), '${sha256}');\n  assert.match(html.toString(), /<h1>[^<]+<\\/h1>/);\n});\n`,
    '.vercelignore': '.git\n.vercel\n',
    'README.md': `# Reviewed static website\n\nGenerated from a bounded Agent Village run. Review the files before sharing.\n\nReceipt: SHA-256 ${sha256} over the two SHA-256 file digests, in index.html then styles.css order.\n\nRun \`npm test\` before publishing. Only the six delivery files are checked; local .git and .vercel metadata may exist but are not part of the receipt and are excluded by .vercelignore. This repository contains no API keys or chat history.\n`,
  };
}

/** Build the canonical six-file delivery from an approved HTML/CSS receipt. */
export function createDeliverySnapshot({ html, css, sha256 }) {
  if (!/^[0-9a-f]{64}$/.test(sha256) ||
      !(typeof html === 'string' || Buffer.isBuffer(html)) ||
      !(typeof css === 'string' || Buffer.isBuffer(css))) {
    throw new Error('Invalid reviewed site snapshot');
  }
  const htmlBytes = Buffer.from(html);
  const cssBytes = Buffer.from(css);
  if (digest(htmlBytes, cssBytes) !== sha256) throw new Error('Reviewed files changed');
  const files = new Map(Object.entries({
    'index.html': htmlBytes,
    'styles.css': cssBytes,
    ...supportFiles(sha256),
  }).map(([name, value]) => [name, Buffer.from(value)]));
  return { sha256, files };
}

export async function exportProject(engine, id) {
  const project = await engine.get(id);
  if (project.status !== 'reviewed' || !project.artifact) throw new Error('Only a reviewed project can be prepared');
  const dir = await engine.checkedWorkspace(id);
  const [html, css] = await Promise.all(['index.html', 'styles.css'].map(name => engine.artifact(id, name)));
  if (digest(html, css) !== project.artifact.sha256) throw new Error('Reviewed files changed');
  const destination = join(dir, 'site');
  try {
    const existing = await lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Prepared project path invalid');
    const expectedFiles = { 'index.html': html, 'styles.css': css, ...supportFiles(project.artifact.sha256) };
    const entries = await readdir(destination, { withFileTypes: true });
    const expectedNames = Object.keys(expectedFiles).sort();
    const delivery = entries.filter(item => !['.git', '.vercel'].includes(item.name));
    if (delivery.map(item => item.name).sort().join('\0') !== expectedNames.join('\0') ||
      delivery.some(item => !item.isFile() || item.isSymbolicLink()) ||
      entries.some(item => ['.git', '.vercel'].includes(item.name) && (!item.isDirectory() || item.isSymbolicLink()))) {
      throw new Error('Prepared project changed; inspect it before publishing');
    }
    await Promise.all(Object.entries(expectedFiles).map(async ([name, expected]) => {
      const file = join(destination, name);
      let details, actual;
      try { details = await lstat(file); actual = await readFile(file); }
      catch { throw new Error('Prepared project changed; inspect it before publishing'); }
      if (!details.isFile() || details.isSymbolicLink() || !actual.equals(Buffer.from(expected))) throw new Error('Prepared project changed; inspect it before publishing');
    }));
    return { path: destination, sha256: project.artifact.sha256 };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(dir, `site-${randomUUID()}.tmp`);
  await mkdir(temp, { mode: 0o700 });
  try {
    const files = { 'index.html': html, 'styles.css': css, ...supportFiles(project.artifact.sha256) };
    for (const [name, value] of Object.entries(files)) await writeFile(join(temp, name), value, { flag: 'wx', mode: 0o600 });
    await rename(temp, destination);
    return { path: destination, sha256: project.artifact.sha256 };
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
}

/** Capture the exact reviewed delivery bytes so later local edits cannot alter a publish. */
export async function capturePreparedProject(engine, id) {
  const prepared = await exportProject(engine, id);
  const project = await engine.get(id);
  if (project.status !== 'reviewed' || project.artifact?.sha256 !== prepared.sha256) throw new Error('Reviewed project changed');
  const [html, css] = await Promise.all(['index.html', 'styles.css'].map(name => engine.artifact(id, name)));
  if (digest(html, css) !== prepared.sha256) throw new Error('Reviewed files changed');
  const expected = createDeliverySnapshot({ html, css, sha256: prepared.sha256 }).files;
  const entries = await readdir(prepared.path, { withFileTypes: true });
  const delivery = entries.filter(item => !['.git', '.vercel'].includes(item.name));
  if (delivery.map(item => item.name).sort().join('\0') !== [...expected.keys()].sort().join('\0') ||
      delivery.some(item => !item.isFile() || item.isSymbolicLink()) ||
      entries.some(item => ['.git', '.vercel'].includes(item.name) && (!item.isDirectory() || item.isSymbolicLink()))) {
    throw new Error('Prepared project changed; inspect it before publishing');
  }
  const files = new Map();
  for (const [name, value] of expected) {
    const path = join(prepared.path, name);
    let details, content;
    try { details = await lstat(path); content = await readFile(path); }
    catch { throw new Error('Prepared project changed; inspect it before publishing'); }
    if (!details.isFile() || details.isSymbolicLink() || !content.equals(Buffer.from(value))) {
      throw new Error('Prepared project changed; inspect it before publishing');
    }
    files.set(name, content);
  }
  if (digest(files.get('index.html'), files.get('styles.css')) !== prepared.sha256) throw new Error('Reviewed files changed');
  return { ...prepared, files };
}
