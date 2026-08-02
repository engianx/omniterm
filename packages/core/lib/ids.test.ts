import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { displayNameForPath, repoIdForPath, worktreeIdForPath } from './ids.js';

const ROOT = mkdtempSync(path.join(tmpdir(), 'omniterm-ids-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function dir(...segments: string[]): string {
  const p = path.join(ROOT, ...segments);
  mkdirSync(p, { recursive: true });
  return p;
}

const WORK = dir('Acme', 'omniterm');
const PERSONAL = dir('Personal', 'omniterm');

// The regression this module exists for: two checkouts named `omniterm` shared
// the id "omniterm", so repo-scoped routes resolved to whichever was tracked
// first and the other repo was unreachable.
test('same-named repos in different directories get different ids', () => {
  const work = repoIdForPath(WORK);
  const personal = repoIdForPath(PERSONAL);

  assert.notEqual(work, personal);
  assert.ok(work.startsWith('omniterm-'), `expected a readable slug, got ${work}`);
  assert.ok(personal.startsWith('omniterm-'), `expected a readable slug, got ${personal}`);
});

test('worktree ids are unique across repos that share a directory name', () => {
  assert.notEqual(worktreeIdForPath(WORK), worktreeIdForPath(PERSONAL));
  // A worktree id must not collide with the repo id for the same path either —
  // both are matched against the same-shaped :wtId / :repoId route params.
  assert.notEqual(repoIdForPath(WORK), worktreeIdForPath(WORK));
});

test('ids are stable across calls and insensitive to path spelling', () => {
  const canonical = repoIdForPath(WORK);

  assert.equal(repoIdForPath(WORK), canonical);
  assert.equal(repoIdForPath(WORK + '/'), canonical);
  assert.equal(repoIdForPath(path.join(ROOT, 'Acme', '..', 'Acme', 'omniterm')), canonical);
});

// `git worktree list` prints fully resolved paths while createWorktree builds
// its path from the tracked repo path as the user entered it. If those two
// spellings produced different ids, a freshly created worktree would not match
// the one the next listing reports.
test('a symlinked spelling of a worktree path yields the same id as the real path', () => {
  const link = path.join(ROOT, 'link-to-work');
  symlinkSync(WORK, link);
  assert.equal(worktreeIdForPath(link), worktreeIdForPath(WORK));
});

// Repo ids must NOT collapse aliases. addLocalPath only path.resolve()s, so a
// user can track both a directory and a symlink pointing at it; those are two
// separate trackedRepos entries and each row must address its own entry.
// Resolving symlinks here would give them one id, and getRepo returns the first
// tracked match — so deleting one row would untrack the other repo.
test('repo ids keep two tracked paths that alias one directory distinct', () => {
  const target = dir('aliasing', 'omniterm');
  const link = path.join(ROOT, 'aliasing', 'current');
  symlinkSync(target, link);
  assert.notEqual(repoIdForPath(link), repoIdForPath(target));
});

// The sidebar must name the directory the user tracked, not whatever it points
// at — a row that silently renames itself is worse than one with a stale name.
test('displayNameForPath keeps the tracked spelling of a symlinked repo', () => {
  const target = dir('spelling', 'omniterm-main');
  const link = path.join(ROOT, 'spelling', 'current');
  symlinkSync(target, link);
  assert.equal(displayNameForPath(link), 'current');
});

test('ids only use characters safe in URLs, tmux targets, and registry keys', () => {
  // A dotted directory would otherwise break tmux target lookups ('.' and ':'
  // are target delimiters) and a '/' would break the route.
  for (const id of [
    repoIdForPath(dir('my.app')),
    repoIdForPath(dir('weird name!')),
    worktreeIdForPath(dir('feature', 'slash')),
  ]) {
    assert.match(id, /^[A-Za-z0-9_-]+$/, `unsafe characters in ${id}`);
  }
});

test('displayNameForPath strips a bare repo .git suffix', () => {
  assert.equal(displayNameForPath(dir('omniterm.git')), 'omniterm');
  assert.equal(displayNameForPath(PERSONAL), 'omniterm');
});

// `/path/to/proj/.git` passes isGitRepo (its HEAD exists), so a user can add it
// as a local repo. Stripping `.git` leaves nothing, which would render a
// workspaces row with no visible label at all.
test('a bare .git directory is named after its parent, never blank', () => {
  assert.equal(displayNameForPath(dir('proj', '.git')), 'proj');
});

// A worktree id asked for before the directory exists must not be memoized:
// the lexical answer differs from the realpath answer, and createWorktree can
// ask early. Pinning the lexical id would hand back an id that never appears in
// the next `git worktree list`, so delete/rename on the fresh row 404s.
// Uses an explicit symlink so the lexical and resolved spellings differ on
// every platform, not just where tmpdir happens to be a symlink.
test('a worktree id computed before the directory exists is not cached', () => {
  const target = dir('cache-target');
  const link = path.join(ROOT, 'cache-link');
  symlinkSync(target, link);

  const pending = path.join(link, 'wt');
  const before = worktreeIdForPath(pending);

  mkdirSync(path.join(target, 'wt'), { recursive: true });
  const after = worktreeIdForPath(pending);

  assert.notEqual(before, after, 'the pre-creation id must not be pinned in the cache');
  assert.equal(after, worktreeIdForPath(path.join(target, 'wt')));
});
