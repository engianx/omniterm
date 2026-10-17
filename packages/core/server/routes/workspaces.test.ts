import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// Everything lives under a throwaway HOME: allowedRoots() always includes
// home, so repos made there are reachable, and the clone default (~/git/<slug>)
// lands there too. paths.ts captures SETTINGS_DIR at import — set both first.
const home = mkdtempSync(path.join(tmpdir(), 'omniterm-ws-route-home-'));
process.env.HOME = home;
process.env.SETTINGS_DIR = path.join(home, '.omniterm');
// GET /api/workspaces counts live sessions via `tmux list-sessions`. Shadow
// tmux with a stub that reports none, so this suite never talks to a real
// tmux server.
const fakeBin = path.join(home, '.fakebin');
mkdirSync(fakeBin);
writeFileSync(path.join(fakeBin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;

const { workspacesRouter } = await import('./workspaces.js');
const { saveSettings, loadSettings } = await import('../../lib/settings.js');
const { worktreeIdForPath } = await import('../../lib/ids.js');

after(() => rmSync(home, { recursive: true, force: true }));

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

let seq = 0;
function makeRepo(slug: string): string {
  const repo = path.join(home, 'src', `${slug}-${++seq}`);
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
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

function makeDir(name: string): string {
  const d = path.join(home, 'dirs', `${name}-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
}

interface Entry {
  id: string;
  path: string;
  name: string;
  exists: boolean;
  parent: string | null;
  git: null | { root: string; branch: string; isMainWorktree: boolean; remoteUrl: string };
  sessionCount: number;
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use(workspacesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function list(base: string): Promise<Entry[]> {
  const res = await fetch(`${base}/workspaces`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { workspaces: Entry[] }).workspaces;
}

function post(base: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET lists folders and repos in one list, with linked worktrees nested under their repo', async () => {
  const repo = makeRepo('listed');
  const wt = addWorktree(repo, 'feature');
  const plain = makeDir('plain');
  saveSettings({ workspaces: [plain, repo] });

  await withServer(async (base) => {
    const entries = await list(base);
    assert.deepEqual(
      entries.map((e) => [e.path, e.parent]),
      [
        [plain, null],
        [repo, null],
        [wt, repo],
      ],
    );
    const [dirEntry, repoEntry, wtEntry] = entries;
    assert.equal(dirEntry.git, null);
    assert.equal(dirEntry.id, worktreeIdForPath(plain));
    // The id is the worktree id terminal sessions already use.
    assert.equal(repoEntry.id, worktreeIdForPath(repo));
    assert.deepEqual(repoEntry.git, {
      root: repo,
      branch: 'main',
      isMainWorktree: true,
      remoteUrl: '',
    });
    assert.equal(wtEntry.id, worktreeIdForPath(wt));
    assert.equal(wtEntry.git?.branch, 'feature');
    assert.equal(wtEntry.git?.isMainWorktree, false);
    assert.equal(wtEntry.git?.root, repo);
    assert.equal(wtEntry.sessionCount, 0);
  });
});

test('POST tracks a folder once and keeps a symlink as its own entry', async () => {
  const plain = makeDir('add');
  const link = path.join(home, 'dirs', `link-${++seq}`);
  symlinkSync(plain, link);
  saveSettings({ workspaces: [] });

  await withServer(async (base) => {
    const first = await post(base, '/workspaces', { path: plain });
    assert.equal(first.status, 201);
    assert.equal(((await first.json()) as Entry).path, plain);
    const again = await post(base, '/workspaces', { path: `${plain}/` });
    assert.equal(again.status, 200, 'already tracked → 200, not a second entry');

    const viaLink = await post(base, '/workspaces', { path: link });
    assert.equal(viaLink.status, 201);
    const entries = await list(base);
    assert.deepEqual(
      entries.map((e) => e.path),
      [plain, link],
    );
    // Same folder, so the same session id; mutations address the path instead.
    assert.equal(entries[0].id, entries[1].id);
  });
});

test('POST on a listed linked worktree answers 200 and leaves it nested', async () => {
  const repo = makeRepo('nested');
  const wt = addWorktree(repo, 'side');
  saveSettings({ workspaces: [repo] });

  await withServer(async (base) => {
    const res = await post(base, '/workspaces', { path: wt });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Entry).parent, repo);
    assert.deepEqual(loadSettings().workspaces, [repo]);
  });
});

test('POST rejects paths outside the allowed roots, missing paths and files', async () => {
  const file = path.join(makeDir('files'), 'notes.txt');
  writeFileSync(file, 'x');
  await withServer(async (base) => {
    assert.equal((await post(base, '/workspaces', { path: '/etc' })).status, 403);
    assert.equal((await post(base, '/workspaces', {})).status, 400);
    assert.equal((await post(base, '/workspaces', { path: `${home}/nope` })).status, 400);
    assert.equal((await post(base, '/workspaces', { path: file })).status, 400);
  });
});

test('DELETE untracks a repo, removing clean worktrees and keeping dirty ones', async () => {
  const repo = makeRepo('untrack');
  const clean = addWorktree(repo, 'clean');
  const dirty = addWorktree(repo, 'dirty');
  writeFileSync(path.join(dirty, 'wip.txt'), 'in progress\n');
  const plain = makeDir('stays');
  saveSettings({ workspaces: [repo, plain] });

  await withServer(async (base) => {
    const res = await fetch(`${base}/workspaces?path=${encodeURIComponent(repo)}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { worktreesRemoved: number; worktreesSkipped: string[] };
    assert.equal(body.worktreesRemoved, 1);
    assert.deepEqual(body.worktreesSkipped, [dirty]);
    assert.ok(!existsSync(clean));
    assert.ok(existsSync(repo), "the repo's own files are the user's and stay");
    assert.deepEqual(
      (await list(base)).map((e) => e.path),
      [plain],
    );

    const missing = await fetch(`${base}/workspaces?path=${encodeURIComponent(repo)}`, {
      method: 'DELETE',
    });
    assert.equal(missing.status, 404);
  });
});

test('POST /workspaces/clone clones to ~/git/<slug> by default and tracks it', async () => {
  const source = makeRepo('upstream');
  saveSettings({ workspaces: [] });

  await withServer(async (base) => {
    const url = `file://${source}`;
    const res = await post(base, '/workspaces/clone', { url });
    assert.equal(res.status, 201);
    const entry = (await res.json()) as Entry;
    const expected = path.join(home, 'git', path.basename(source));
    assert.equal(entry.path, expected);
    assert.equal(entry.git?.remoteUrl, url);
    assert.ok(existsSync(path.join(expected, 'README.md')));

    const clash = await post(base, '/workspaces/clone', { url });
    assert.equal(clash.status, 409, 'destination already exists');
    const outside = await post(base, '/workspaces/clone', { url, destination: '/etc/x' });
    assert.equal(outside.status, 403);
    const bad = await post(base, '/workspaces/clone', {
      url: `file://${home}/no-such-repo`,
      destination: `${home}/git/never`,
    });
    assert.equal(bad.status, 400);
    assert.ok(!existsSync(`${home}/git/never`));
  });
});

test('worktree create and delete keep the requiresForce contract', async () => {
  const repo = makeRepo('wt');
  saveSettings({ workspaces: [repo] });

  await withServer(async (base) => {
    const created = await post(base, '/workspaces/worktrees', { path: repo, branch: 'feat' });
    assert.equal(created.status, 201);
    const entry = (await created.json()) as Entry;
    assert.equal(entry.path, `${repo}-feat`);
    assert.equal(entry.parent, repo);
    assert.equal(entry.git?.branch, 'feat');
    const dup = await post(base, '/workspaces/worktrees', { path: repo, branch: 'feat' });
    assert.equal(dup.status, 409);

    const del = (p: string, force = false) =>
      fetch(`${base}/workspaces/worktrees?path=${encodeURIComponent(p)}${force ? '&force=true' : ''}`, {
        method: 'DELETE',
      });
    writeFileSync(path.join(entry.path, 'wip.txt'), 'x\n');
    const refused = await del(entry.path);
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { requiresForce: boolean }).requiresForce, true);
    assert.ok(existsSync(entry.path));
    assert.equal((await del(entry.path, true)).status, 200);
    assert.ok(!existsSync(entry.path));

    const main = await del(repo, true);
    assert.equal(main.status, 409);
    assert.equal(((await main.json()) as { requiresForce: boolean }).requiresForce, false);
    assert.equal((await del(`${repo}-gone`)).status, 404);
  });
});

test('GET /workspaces/complete completes typed paths without leaking outside the roots', async () => {
  const parent = makeDir('complete');
  mkdirSync(path.join(parent, 'alpha'));
  mkdirSync(path.join(parent, 'Alpine'));
  mkdirSync(path.join(parent, 'beta'));
  mkdirSync(path.join(parent, '.hidden'));
  writeFileSync(path.join(parent, 'alfile'), 'x');

  await withServer(async (base) => {
    const complete = async (prefix: string) => {
      const res = await fetch(`${base}/workspaces/complete?prefix=${encodeURIComponent(prefix)}`);
      assert.equal(res.status, 200);
      return ((await res.json()) as { dirs: string[] }).dirs;
    };
    assert.deepEqual(await complete(`${parent}/al`), [
      path.join(parent, 'alpha'),
      path.join(parent, 'Alpine'),
    ]);
    assert.deepEqual(await complete(`${parent}/`), [
      path.join(parent, 'alpha'),
      path.join(parent, 'Alpine'),
      path.join(parent, 'beta'),
    ]);
    assert.deepEqual(await complete(`${parent}/.h`), [path.join(parent, '.hidden')]);
    // From the filesystem root only the way into a root is offered.
    const top = await complete('/');
    assert.ok(top.length > 0);
    assert.ok(top.every((d) => home.startsWith(d + '/') || d === home), top.join(','));
    assert.deepEqual(await complete('/etc/'), []);
  });
});
