import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// paths.ts captures SETTINGS_DIR at module load, so point it at a throwaway dir
// before the dynamic imports below (and never touch the real ~/.omniterm).
const ROOT = mkdtempSync(path.join(tmpdir(), 'omniterm-repo-identity-'));
process.env.SETTINGS_DIR = path.join(ROOT, 'settings');
mkdirSync(process.env.SETTINGS_DIR, { recursive: true });

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A directory that passes isGitRepo — the code only checks that `.git` exists. */
function fakeRepo(...segments: string[]): string {
  const repoPath = path.join(ROOT, ...segments);
  mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  return repoPath;
}

const WORK = fakeRepo('Acme', 'omniterm');
const PERSONAL = fakeRepo('Personal', 'omniterm');

writeFileSync(
  path.join(process.env.SETTINGS_DIR, 'settings.json'),
  JSON.stringify({ trackedRepos: [WORK, PERSONAL], trackedDirs: [] }),
);

// Regression: repo ids were the bare directory basename, so both of these
// collapsed onto "omniterm". getRepo returned the first tracked match, which
// made the second repo unreachable — every repo-scoped route (new worktree,
// remove repo, list worktrees) acted on the first repo instead.
test('two repos with the same directory name each resolve to their own path', async () => {
  const { listRepos, getRepo } = await import('./repos.js');

  const repos = listRepos();
  assert.equal(repos.length, 2);

  const ids = repos.map((r) => r.id);
  assert.equal(new Set(ids).size, 2, `repo ids must be unique, got ${ids.join(', ')}`);
  assert.deepEqual(
    repos.map((r) => r.name),
    ['omniterm', 'omniterm'],
    'display names are expected to collide — only the ids must not',
  );

  for (const repo of repos) {
    assert.equal(getRepo(repo.id)?.path, repo.path);
  }
  const byPath = new Map(repos.map((r) => [r.path, r.id]));
  assert.equal(getRepo(byPath.get(WORK) as string)?.path, WORK);
  assert.equal(getRepo(byPath.get(PERSONAL) as string)?.path, PERSONAL);
});

test('the legacy basename id no longer resolves to any repo', async () => {
  const { getRepo } = await import('./repos.js');
  // Failing closed matters more than compatibility here: resolving "omniterm"
  // to *a* repo is exactly the ambiguity this change removes.
  assert.equal(getRepo('omniterm'), undefined);
});
