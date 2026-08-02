import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// paths.ts captures SETTINGS_DIR at module-import time, so point it at a temp
// settings dir before importing repos/settings/sessions.
const settingsDir = mkdtempSync(path.join(tmpdir(), 'omniterm-removerepo-settings-'));
process.env.SETTINGS_DIR = settingsDir;

const { removeRepo } = await import('./repos.js');
const { saveSettings } = await import('./settings.js');
const { registerSession } = await import('../plugins/terminal/lib/sessions.js');
const { repoIdForPath, worktreeIdForPath } = await import('./ids.js');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function makeRepo(root: string, slug: string): string {
  const repo = path.join(root, slug);
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  return repo;
}

function addWorktree(repo: string, name: string): string {
  const wt = `${repo}-${name}`;
  git(['worktree', 'add', '-q', '-b', name, wt], repo);
  return wt;
}

async function withRepo<T>(slug: string, fn: (repo: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-removerepo-'));
  try {
    const repo = makeRepo(root, slug);
    saveSettings({ trackedRepos: [repo] });
    return await fn(repo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('removeRepo removes clean worktrees, keeps dirty ones, and never reports the main worktree', async () => {
  await withRepo('repo2', async (repo) => {
    const clean = addWorktree(repo, 'clean');
    const dirty = addWorktree(repo, 'dirty');
    writeFileSync(path.join(dirty, 'scratch.txt'), 'in progress\n'); // untracked → dirty

    const result = removeRepo(repoIdForPath(repo));

    assert.equal(result.worktreesRemoved, 1, 'only the clean worktree is removed');
    assert.equal(result.worktreesSkipped.length, 1, 'only the dirty worktree is skipped');
    assert.ok(
      result.worktreesSkipped[0]!.endsWith('repo2-dirty'),
      'the dirty worktree is the one reported as left behind',
    );
    assert.ok(
      !result.worktreesSkipped.some((p) => path.basename(p) === 'repo2'),
      'the main worktree must never appear in worktreesSkipped',
    );

    assert.ok(!existsSync(clean), 'clean worktree removed from disk');
    assert.ok(existsSync(dirty), 'dirty worktree kept on disk');
    assert.ok(existsSync(path.join(dirty, 'scratch.txt')), 'uncommitted work preserved');
    assert.ok(existsSync(repo), 'main worktree left in place');
  });
});

test('removeRepo tears down sessions even for worktrees it keeps (dirty)', async () => {
  await withRepo('repo3', async (repo) => {
    const dirty = addWorktree(repo, 'dirty');
    writeFileSync(path.join(dirty, 'scratch.txt'), 'in progress\n');

    // A live terminal session attached to the soon-to-be-kept dirty worktree.
    registerSession({
      id: `${worktreeIdForPath(dirty)}-term-1`,
      worktreeId: worktreeIdForPath(dirty),
      tmuxName: 'omniterm-test-repo3-dirty',
      port: 49999,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = removeRepo(repoIdForPath(repo));

    // The worktree itself is kept because it is dirty...
    assert.ok(
      result.worktreesSkipped.some((p) => p.endsWith('repo3-dirty')),
      'dirty worktree is kept',
    );
    assert.ok(existsSync(dirty), 'dirty worktree files preserved');
    // ...but its session is still killed, so it is not orphaned after untracking.
    assert.equal(result.sessionsKilled, 1, 'session for a kept worktree must still be torn down');
  });
});
