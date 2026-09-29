import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitWorkspaces } from '../worker.mjs';

test('creates and reuses a bounded Astra issue worktree without overwriting dirt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'village-worktree-test-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.com');
    git('commit', '--allow-empty', '-q', '-m', 'initial');
    git('branch', '-M', 'main');
    git('remote', 'add', 'origin', 'git@github.com:startupsandcode/astra-lab.git');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const manager = new GitWorkspaces({ root });
    const path = await manager.ensure(22);
    assert.equal(await manager.ensure(22), path);
    writeFileSync(join(path, 'scratch.txt'), 'keep me');
    assert.equal(await manager.dirty(path), true);
    assert.equal(await manager.ensure(22), path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
