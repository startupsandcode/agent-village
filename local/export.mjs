import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function digest(html, css) { return createHash('sha256').update(html).update(css).digest('hex'); }
function supportFiles(sha256) {
  return {
    'package.json': JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'verify.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\ntest('site files match the reviewed SHA-256 receipt', async () => {\n  const html = await readFile(new URL('./index.html', import.meta.url));\n  const css = await readFile(new URL('./styles.css', import.meta.url));\n  assert.equal(createHash('sha256').update(html).update(css).digest('hex'), '${sha256}');\n  assert.match(html.toString(), /<h1>[^<]+<\\/h1>/);\n});\n`,
    'README.md': `# Reviewed static website\n\nGenerated from a bounded Agent Village run. Review the files before sharing.\n\nReceipt: SHA-256 ${sha256} over index.html followed by styles.css.\n\nRun \`npm test\` before publishing. This repository contains no API keys or chat history.\n`,
  };
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
