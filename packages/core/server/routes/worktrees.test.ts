import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// paths.ts captures SETTINGS_DIR at module-import time — set it before importing.
const settingsDir = mkdtempSync(path.join(tmpdir(), 'omniterm-wt-route-settings-'));
process.env.SETTINGS_DIR = settingsDir;

const { worktreesRouter } = await import('./worktrees.js');
const { saveSettings } = await import('../../lib/settings.js');
const { worktreeIdForPath } = await import('../../lib/ids.js');

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

async function withRepoServer<T>(
  slug: string,
  fn: (ctx: { base: string; repo: string }) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-wt-route-'));
  const app = express();
  app.use(express.json());
  app.use(worktreesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const repo = makeRepo(root, slug);
    saveSettings({ trackedRepos: [repo] });
    return await fn({ base: `http://127.0.0.1:${port}`, repo });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test('DELETE main worktree returns 409 but does not advertise force-retry', async () => {
  await withRepoServer('routerepoA', async ({ base, repo }) => {
    // Dirty the main worktree: this is the ordinary state of an active checkout
    // and the case that would wrongly advertise a force-retry if isMain weren't
    // excluded. The main worktree can never be removed by `git worktree remove`
    // (with or without --force), so requiresForce must stay false — otherwise
    // the UI loops on a confirm-and-force prompt that can never succeed.
    writeFileSync(path.join(repo, 'scratch.txt'), 'in progress\n');
    const res = await fetch(`${base}/worktrees/${worktreeIdForPath(repo)}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { requiresForce: boolean };
    assert.equal(body.requiresForce, false);
    assert.ok(existsSync(repo), 'main worktree left intact');
  });
});

test('DELETE dirty worktree without force returns 409 requiresForce and keeps the work', async () => {
  await withRepoServer('routerepoB', async ({ base, repo }) => {
    const dirty = addWorktree(repo, 'dirty');
    writeFileSync(path.join(dirty, 'scratch.txt'), 'in progress\n');

    const res = await fetch(`${base}/worktrees/${worktreeIdForPath(dirty)}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { requiresForce: boolean };
    assert.equal(body.requiresForce, true, 'forcing would help here, so prompt for it');
    assert.ok(existsSync(dirty), 'dirty worktree not removed');
    assert.ok(existsSync(path.join(dirty, 'scratch.txt')), 'uncommitted work preserved');
  });
});

test('GET worktree status reports clean vs dirty', async () => {
  await withRepoServer('routerepoStatus', async ({ base, repo }) => {
    const wt = addWorktree(repo, 'feature');

    const clean = await fetch(`${base}/worktrees/${worktreeIdForPath(wt)}/status`);
    assert.equal(clean.status, 200);
    assert.equal(((await clean.json()) as { dirty: boolean }).dirty, false, 'fresh worktree clean');

    writeFileSync(path.join(wt, 'scratch.txt'), 'in progress\n');
    const dirty = await fetch(`${base}/worktrees/${worktreeIdForPath(wt)}/status`);
    assert.equal(dirty.status, 200);
    assert.equal(
      ((await dirty.json()) as { dirty: boolean }).dirty,
      true,
      'uncommitted change reported dirty',
    );
  });
});

test('GET status for unknown worktree returns 404', async () => {
  await withRepoServer('routerepoStatus404', async ({ base }) => {
    const res = await fetch(`${base}/worktrees/wt-does-not-exist/status`);
    assert.equal(res.status, 404);
  });
});

test('DELETE dirty worktree with force=true removes it', async () => {
  await withRepoServer('routerepoC', async ({ base, repo }) => {
    const dirty = addWorktree(repo, 'dirty');
    writeFileSync(path.join(dirty, 'scratch.txt'), 'in progress\n');

    const res = await fetch(`${base}/worktrees/${worktreeIdForPath(dirty)}?force=true`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deleted: boolean };
    assert.equal(body.deleted, true);
    assert.ok(!existsSync(dirty), 'forced delete removed the worktree');
  });
});
