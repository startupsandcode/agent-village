import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitWorkspaces } from '../worker.mjs';

test('creates and reuses a bounded Astra issue worktree without overwriting dirt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'village-worktree-test-'));
  const remote = mkdtempSync(join(tmpdir(), 'village-worktree-remote-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['init', '--bare', '-q', remote]);
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.com');
    git('commit', '--allow-empty', '-q', '-m', 'initial');
    git('branch', '-M', 'main');
    git('remote', 'add', 'origin', 'git@github.com:startupsandcode/astra-lab.git');
    git('config', `url.file://${remote}/.insteadOf`, 'git@github.com:startupsandcode/astra-lab.git');
    git('push', '-q', 'origin', 'main');
    const manager = new GitWorkspaces({ root });
    const path = await manager.ensure(22);
    assert.equal(await manager.ensure(22), path);
    writeFileSync(join(path, 'scratch.txt'), 'keep me');
    assert.equal(await manager.dirty(path), true);
    assert.equal(await manager.ensure(22), path);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test('fresh host resumes the remote implementation branch instead of main', async () => {
  const root = mkdtempSync(join(tmpdir(), 'village-fresh-host-'));
  const remote = mkdtempSync(join(tmpdir(), 'village-fresh-remote-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
    execFileSync('git', ['init', '--bare', '-q', remote]);
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.com');
    git('commit', '--allow-empty', '-q', '-m', 'main');
    git('branch', '-M', 'main');
    git('remote', 'add', 'origin', 'git@github.com:startupsandcode/astra-lab.git');
    git('config', `url.file://${remote}/.insteadOf`, 'git@github.com:startupsandcode/astra-lab.git');
    git('push', '-q', 'origin', 'main');
    git('checkout', '-q', '-b', 'maya/issue-22');
    git('commit', '--allow-empty', '-q', '-m', 'Sam implementation');
    const implemented = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', 'maya/issue-22');
    git('checkout', '-q', 'main');
    git('branch', '-D', 'maya/issue-22');
    const manager = new GitWorkspaces({ root });
    const path = await manager.ensure(22);
    assert.equal(await manager.head(path), implemented);
    assert.notEqual(await manager.head(path), git('rev-parse', 'HEAD'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
