import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// paths.ts captures SETTINGS_DIR at module load, so point it at a throwaway dir
// before the dynamic imports below (and never touch the real ~/.omniterm).
const ROOT = mkdtempSync(path.join(tmpdir(), 'omniterm-repo-alias-'));
process.env.SETTINGS_DIR = path.join(ROOT, 'settings');
mkdirSync(process.env.SETTINGS_DIR, { recursive: true });

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A directory that passes isGitRepo — the code only checks that `.git` exists. */
function fakeRepo(...segments: string[]): string {
  const repoPath = path.join(ROOT, ...segments);
  mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  return repoPath;
}

// Two trackedRepos entries pointing at ONE directory: the real path, and a
// symlink under a different name. addLocalPath only path.resolve()s, so both
// entries persist and the panel shows two rows.
const TARGET = fakeRepo('dev', 'omniterm');
const ALIAS = path.join(ROOT, 'current');
symlinkSync(TARGET, ALIAS);

writeFileSync(
  path.join(process.env.SETTINGS_DIR, 'settings.json'),
  JSON.stringify({ trackedRepos: [TARGET, ALIAS], trackedDirs: [] }),
);

// Regression: resolving symlinks when deriving the repo id collapsed these two
// entries onto one id. getRepo returns the first tracked match, so clicking
// remove on the alias row untracked the *other* repo (and deleted its clean
// worktrees), while the clicked row stayed in the list — the same wrong-repo
// class of bug that path-derived ids were introduced to eliminate.
test('two tracked paths aliasing one directory keep separate repo ids', async () => {
  const { listRepos } = await import('./repos.js');

  const repos = listRepos();
  assert.equal(repos.length, 2, 'both tracked entries must be listed');

  const ids = repos.map((r) => r.id);
  assert.equal(new Set(ids).size, 2, `aliased entries must not share an id, got ${ids.join(', ')}`);
});

test('each aliased entry resolves back to the exact path the user tracked', async () => {
  const { listRepos, getRepo } = await import('./repos.js');

  for (const repo of listRepos()) {
    assert.equal(
      getRepo(repo.id)?.path,
      repo.path,
      `id ${repo.id} must address its own trackedRepos entry`,
    );
  }

  const byPath = new Map(listRepos().map((r) => [r.path, r.id]));
  assert.equal(getRepo(byPath.get(ALIAS) as string)?.path, ALIAS);
  assert.equal(getRepo(byPath.get(TARGET) as string)?.path, TARGET);
});

// The display name must be the directory the user tracked. Naming the alias row
// after its target makes two rows read identically and hides which is which.
test('the alias row is named after the tracked path, not its target', async () => {
  const { listRepos } = await import('./repos.js');

  const names = new Map(listRepos().map((r) => [r.path, r.name]));
  assert.equal(names.get(ALIAS), 'current');
  assert.equal(names.get(TARGET), 'omniterm');
});
