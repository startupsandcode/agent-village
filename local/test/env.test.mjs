import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalEnv } from '../env.mjs';

test('.env.local loads a server key without replacing an exported provider choice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'village-env-'));
  const key = 'VILLAGE_TEST_PROVIDER_KEY';
  const priorProvider = process.env.VILLAGE_PROVIDER;
  try {
    assert.equal(await loadLocalEnv(join(dir, '.env.local')), false);
    await writeFile(join(dir, '.env.local'), `${key}=fake-local-key\nVILLAGE_PROVIDER=anthropic\n`, { mode: 0o600 });
    process.env.VILLAGE_PROVIDER = 'openai';
    assert.equal(await loadLocalEnv(join(dir, '.env.local')), true);
    assert.equal(process.env[key], 'fake-local-key');
    assert.equal(process.env.VILLAGE_PROVIDER, 'openai');
    await symlink(join(dir, '.env.local'), join(dir, 'linked.env'));
    await assert.rejects(loadLocalEnv(join(dir, 'linked.env')), /regular file/);
    if (process.platform !== 'win32') {
      await chmod(join(dir, '.env.local'), 0o644);
      await assert.rejects(loadLocalEnv(join(dir, '.env.local')), /chmod 600/);
    }
  } finally {
    delete process.env[key];
    if (priorProvider === undefined) delete process.env.VILLAGE_PROVIDER;
    else process.env.VILLAGE_PROVIDER = priorProvider;
    await rm(dir, { recursive: true, force: true });
  }
});
