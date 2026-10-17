import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// paths.ts captures SETTINGS_DIR at import time — set it before importing.
const root = mkdtempSync(path.join(tmpdir(), 'omniterm-workspaces-'));
process.env.SETTINGS_DIR = path.join(root, 'settings');

const { listWorkspaces, untrackWorkspace } = await import('./workspaces.js');
const { saveSettings, loadSettings } = await import('./settings.js');
const { registerSession, listSessions } = await import('../plugins/terminal/lib/sessions.js');
const { worktreeIdForPath } = await import('./ids.js');
const { cloneSlug, defaultCloneDestination } = await import('./cloneUrl.js');

after(() => rmSync(root, { recursive: true, force: true }));

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

let seq = 0;
function makeRepo(slug: string): string {
  const repo = path.join(root, `${slug}-${++seq}`);
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

test('sessions count toward the workspace their cwd resolves to, whatever the spelling', async () => {
  const repo = makeRepo('counted');
  const wt = addWorktree(repo, 'side');
  const link = path.join(root, `link-${++seq}`);
  symlinkSync(repo, link);
  saveSettings({ workspaces: [repo] });

  const entries = await listWorkspaces([repo, link, wt, '/somewhere/else']);
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e.sessionCount]));
  assert.equal(byPath[repo], 2);
  assert.equal(byPath[wt], 1);
});

test('a missing workspace is listed with exists=false and no git', async () => {
  const gone = path.join(root, 'gone');
  saveSettings({ workspaces: [gone] });
  const [entry] = await listWorkspaces();
  assert.equal(entry.exists, false);
  assert.equal(entry.git, null);
  assert.equal(entry.id, worktreeIdForPath(gone));
});

test('untracking one spelling of a repo leaves the other spelling and its worktrees alone', async () => {
  const repo = makeRepo('twice');
  const wt = addWorktree(repo, 'kept');
  const link = path.join(root, `alias-${++seq}`);
  symlinkSync(repo, link);
  saveSettings({ workspaces: [repo, link] });
  registerSession({
    id: `${worktreeIdForPath(wt)}-term-1`,
    worktreeId: worktreeIdForPath(wt),
    tmuxName: 'omniterm-test-twice-kept',
    port: 49998,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const result = untrackWorkspace(link);

  assert.deepEqual(result, { worktreesRemoved: 0, worktreesSkipped: [], sessionsKilled: 0 });
  assert.ok(existsSync(wt), 'the worktree is still listed under the remaining spelling');
  assert.equal(listSessions(worktreeIdForPath(wt)).length, 1);
  assert.deepEqual(loadSettings().workspaces, [repo]);
});

test('untracking a linked worktree tracked on its own never removes worktrees', async () => {
  const repo = makeRepo('linked');
  const wt = addWorktree(repo, 'own');
  const sibling = addWorktree(repo, 'sibling');
  saveSettings({ workspaces: [wt] });

  const result = untrackWorkspace(wt);

  assert.equal(result.worktreesRemoved, 0);
  assert.ok(existsSync(wt) && existsSync(sibling));
  assert.deepEqual(loadSettings().workspaces, []);
});

test('cloneSlug and the default destination follow git clone naming', () => {
  assert.equal(cloneSlug('git@github.com:user/omniterm.git'), 'omniterm');
  assert.equal(cloneSlug('https://github.com/user/omniterm/'), 'omniterm');
  assert.equal(cloneSlug('git@host:solo'), 'solo');
  assert.equal(cloneSlug('file:///srv/repos/thing.git'), 'thing');
  assert.equal(cloneSlug(''), 'repo');
  assert.equal(cloneSlug('https://host/..'), 'repo');
  assert.equal(defaultCloneDestination('https://x/y/z.git'), '~/git/z');
  assert.equal(defaultCloneDestination('https://x/y/z.git', '/home/me/'), '/home/me/git/z');
});
