import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// paths.ts captures SETTINGS_DIR at module-import time — set it before importing.
const settingsDir = mkdtempSync(path.join(tmpdir(), 'omniterm-git-route-settings-'));
process.env.SETTINGS_DIR = settingsDir;

const { gitRouter } = await import('./git.js');
const { setExtraAllowedRoots } = await import('../../lib/allowedRoots.js');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

async function withServer(
  fn: (ctx: { base: string; repo: string; tmp: string }) => Promise<void>,
): Promise<void> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'omniterm-git-route-'));
  // Only the repo dir is allowed: `tmp` itself stays outside the roots.
  const repo = path.join(tmp, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  setExtraAllowedRoots([repo]);

  const app = express();
  app.use(express.json());
  app.use('/api', gitRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}/api`, repo, tmp });
  } finally {
    setExtraAllowedRoots([]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  }
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function post(base: string, route: string, body: unknown) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('cwd outside the allowed roots is 403 on every route', async () => {
  await withServer(async ({ base, tmp }) => {
    const outside = path.join(tmp, 'elsewhere');
    for (const r of ['/git/info', '/git/changes', '/git/branches']) {
      const res = await fetch(`${base}${r}?${q({ cwd: outside })}`);
      assert.equal(res.status, 403, r);
    }
    const res = await post(base, '/git/stage', { cwd: outside, paths: ['x'] });
    assert.equal(res.status, 403);
    const missing = await fetch(`${base}/git/info`);
    assert.equal(missing.status, 403);
  });
});

test('GET /git/info for a repo subdir and a plain dir', async () => {
  await withServer(async ({ base, repo }) => {
    mkdirSync(path.join(repo, 'sub'));
    const info = await (await fetch(`${base}/git/info?${q({ cwd: path.join(repo, 'sub') })}`)).json();
    assert.deepEqual(info, {
      isRepo: true,
      root: repo,
      branch: 'main',
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
    });
    // A dir inside the allowed root but outside any repo's work tree: the
    // repo's .git dir is the only such thing here.
    const plain = await (await fetch(`${base}/git/info?${q({ cwd: path.join(repo, '.git') })}`)).json();
    assert.equal(plain.isRepo, false);
  });
});

test('changes, stage, diff, unstage, discard and commit over HTTP', async () => {
  await withServer(async ({ base, repo }) => {
    writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    writeFileSync(path.join(repo, 'weird\nname.md'), '# hi\n');

    let changes = await (await fetch(`${base}/git/changes?${q({ cwd: repo })}`)).json();
    assert.deepEqual(changes, {
      root: repo,
      staged: [],
      unstaged: [{ path: 'a.txt', status: 'M' }],
      untracked: [{ path: 'weird\nname.md', status: '?' }],
    });

    const untrackedDiff = await (
      await fetch(`${base}/git/diff?${q({ cwd: repo, path: 'weird\nname.md' })}`)
    ).json();
    assert.deepEqual(untrackedDiff, { path: 'weird\nname.md', original: '', modified: '# hi\n', language: 'markdown' });

    assert.equal((await post(base, '/git/stage', { cwd: repo, paths: ['a.txt'] })).status, 200);
    const staged = await (await fetch(`${base}/git/diff?${q({ cwd: repo, path: 'a.txt', staged: '1' })}`)).json();
    assert.equal(staged.original, 'one\n');
    assert.equal(staged.modified, 'two\n');

    assert.equal((await post(base, '/git/unstage', { cwd: repo, paths: ['a.txt'] })).status, 200);
    changes = await (await fetch(`${base}/git/changes?${q({ cwd: repo })}`)).json();
    assert.deepEqual(changes.staged, []);

    assert.equal((await post(base, '/git/discard', { cwd: repo, paths: ['weird\nname.md'] })).status, 200);
    assert.equal(existsSync(path.join(repo, 'weird\nname.md')), false);

    await post(base, '/git/stage', { cwd: repo, paths: [path.join(repo, 'a.txt')] });
    const commit = await post(base, '/git/commit', { cwd: repo, message: 'second' });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.sha, git(['rev-parse', 'HEAD'], repo).trim());

    const empty = await post(base, '/git/commit', { cwd: repo, message: 'again' });
    assert.equal(empty.status, 409);
    assert.ok(typeof empty.body.error === 'string' && empty.body.error.length > 0);
  });
});

test('path escapes and bad input are 400', async () => {
  await withServer(async ({ base, repo, tmp }) => {
    writeFileSync(path.join(tmp, 'secret.txt'), 'x\n');
    for (const paths of [['../secret.txt'], [path.join(tmp, 'secret.txt')], [], 'a.txt']) {
      const res = await post(base, '/git/discard', { cwd: repo, paths });
      assert.equal(res.status, 400, JSON.stringify(paths));
    }
    assert.ok(existsSync(path.join(tmp, 'secret.txt')));
    const diff = await fetch(`${base}/git/diff?${q({ cwd: repo, path: '../secret.txt' })}`);
    assert.equal(diff.status, 400);
    assert.equal((await post(base, '/git/commit', { cwd: repo })).status, 400);
    assert.equal((await post(base, '/git/checkout', { cwd: repo, branch: '--orphan' })).status, 400);
  });
});

test('an unmerged file is reported as U', async () => {
  await withServer(async ({ base, repo }) => {
    git(['checkout', '-q', '-b', 'other'], repo);
    writeFileSync(path.join(repo, 'a.txt'), 'other\n');
    git(['commit', '-q', '-am', 'other'], repo);
    git(['checkout', '-q', 'main'], repo);
    writeFileSync(path.join(repo, 'a.txt'), 'main\n');
    git(['commit', '-q', '-am', 'main'], repo);
    assert.throws(() => execFileSync('git', ['merge', '-q', 'other'], { cwd: repo, stdio: 'ignore' }));
    const changes = await (await fetch(`${base}/git/changes?${q({ cwd: repo })}`)).json();
    assert.deepEqual(changes.unstaged, [{ path: 'a.txt', status: 'U' }]);
    assert.deepEqual(changes.staged, []);
  });
});

test('branches, checkout (create) and rename over HTTP', async () => {
  await withServer(async ({ base, repo }) => {
    assert.equal((await post(base, '/git/checkout', { cwd: repo, branch: 'feat', create: true })).status, 200);
    assert.equal((await post(base, '/git/branch/rename', { cwd: repo, from: 'feat', to: 'feat-2' })).status, 200);
    const b = await (await fetch(`${base}/git/branches?${q({ cwd: repo })}`)).json();
    assert.equal(b.current, 'feat-2');
    assert.deepEqual(
      b.local.map((l: { name: string }) => l.name),
      ['feat-2', 'main'],
    );
    const dup = await post(base, '/git/checkout', { cwd: repo, branch: 'main', create: true });
    assert.equal(dup.status, 409);
  });
});
