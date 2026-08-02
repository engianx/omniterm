import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isWorktreeDirty, removeWorktree } from './worktrees.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** Create a git repo with one commit and return its path. */
function initRepo(root: string): string {
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  return repo;
}

/** Add a worktree at `<repo>-<name>` on a new branch and return its path. */
function addWorktree(repo: string, name: string): string {
  const wtPath = `${repo}-${name}`;
  git(['worktree', 'add', '-q', '-b', name, wtPath], repo);
  return wtPath;
}

async function withRepo<T>(fn: (repo: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-worktrees-test-'));
  try {
    return await fn(initRepo(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- removeWorktree ----

test('removeWorktree without force refuses a dirty worktree and keeps its files', async () => {
  await withRepo((repo) => {
    const wt = addWorktree(repo, 'dirty');
    // Untracked file → git refuses removal without --force.
    writeFileSync(path.join(wt, 'scratch.txt'), 'in progress\n');

    assert.throws(() => removeWorktree(repo, wt), /untracked|modified|force/i);
    assert.ok(existsSync(wt), 'dirty worktree must survive a non-forced remove');
    assert.ok(existsSync(path.join(wt, 'scratch.txt')), 'uncommitted work must be preserved');
  });
});

test('removeWorktree with force removes a dirty worktree', async () => {
  await withRepo((repo) => {
    const wt = addWorktree(repo, 'dirty');
    writeFileSync(path.join(wt, 'scratch.txt'), 'in progress\n');

    assert.doesNotThrow(() => removeWorktree(repo, wt, { force: true }));
    assert.ok(!existsSync(wt), 'forced remove must delete the worktree');
  });
});

test('removeWorktree without force removes a clean worktree', async () => {
  await withRepo((repo) => {
    const wt = addWorktree(repo, 'clean');

    assert.doesNotThrow(() => removeWorktree(repo, wt));
    assert.ok(!existsSync(wt), 'clean worktree should be removed without force');
  });
});

// ---- isWorktreeDirty ----

test('isWorktreeDirty is false for a clean worktree, true for an uncommitted change', async () => {
  await withRepo((repo) => {
    const wt = addWorktree(repo, 'wt');
    assert.equal(isWorktreeDirty(wt), false);

    writeFileSync(path.join(wt, 'scratch.txt'), 'in progress\n');
    assert.equal(isWorktreeDirty(wt), true);
  });
});

test('isWorktreeDirty assumes dirty when git status cannot be read', () => {
  // A non-existent path makes `git status` fail; we must err on the side of
  // "dirty" so callers never force-delete blindly.
  assert.equal(isWorktreeDirty(path.join(tmpdir(), 'omniterm-does-not-exist-xyz')), true);
});
