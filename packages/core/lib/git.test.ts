import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as git from './git.js';

// ----- parsePorcelainV2 (pure) -----

const H = '0000000000000000000000000000000000000000';

test('parses branch headers, including ahead/behind', () => {
  const out = [
    '# branch.oid abc',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -3',
    '',
  ].join('\0');
  assert.deepEqual(git.parsePorcelainV2(out).branch, {
    head: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 3,
  });
});

test('detached head and no upstream', () => {
  const out = ['# branch.oid abc', '# branch.head (detached)', ''].join('\0');
  assert.deepEqual(git.parsePorcelainV2(out).branch, { head: null, upstream: null, ahead: 0, behind: 0 });
});

test('splits ordinary entries into staged and unstaged sides', () => {
  const out = [
    `1 M. N... 100644 100644 100644 ${H} ${H} staged.txt`,
    `1 .M N... 100644 100644 100644 ${H} ${H} unstaged.txt`,
    `1 MM N... 100644 100644 100644 ${H} ${H} both.txt`,
    `1 A. N... 000000 100644 100644 ${H} ${H} added.txt`,
    `1 .D N... 100644 100644 000000 ${H} ${H} gone.txt`,
    `1 T. N... 100644 120000 120000 ${H} ${H} link`,
    '',
  ].join('\0');
  const s = git.parsePorcelainV2(out);
  assert.deepEqual(s.staged, [
    { path: 'staged.txt', status: 'M' },
    { path: 'both.txt', status: 'M' },
    { path: 'added.txt', status: 'A' },
    { path: 'link', status: 'M' },
  ]);
  assert.deepEqual(s.unstaged, [
    { path: 'unstaged.txt', status: 'M' },
    { path: 'both.txt', status: 'M' },
    { path: 'gone.txt', status: 'D' },
  ]);
  assert.deepEqual(s.untracked, []);
});

test('renames carry oldPath; a rename with worktree edits also shows unstaged', () => {
  const out = [
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.txt`,
    'old name.txt',
    `2 RM N... 100644 100644 100644 ${H} ${H} R87 dir/b.ts`,
    'dir/a.ts',
    `1 .M N... 100644 100644 100644 ${H} ${H} after.txt`,
    '',
  ].join('\0');
  const s = git.parsePorcelainV2(out);
  assert.deepEqual(s.staged, [
    { path: 'new name.txt', status: 'R', oldPath: 'old name.txt' },
    { path: 'dir/b.ts', status: 'R', oldPath: 'dir/a.ts' },
  ]);
  // The oldPath record is consumed, so the next entry still parses.
  assert.deepEqual(s.unstaged, [
    { path: 'dir/b.ts', status: 'M' },
    { path: 'after.txt', status: 'M' },
  ]);
});

test('unmerged entries land in unstaged as U', () => {
  const out = [`u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict file.txt`, ''].join('\0');
  const s = git.parsePorcelainV2(out);
  assert.deepEqual(s.unstaged, [{ path: 'conflict file.txt', status: 'U' }]);
  assert.deepEqual(s.staged, []);
});

test('untracked paths keep spaces and newlines', () => {
  const out = ['? a b.txt', '? line\nbreak.txt', '? dir/x', ''].join('\0');
  assert.deepEqual(git.parsePorcelainV2(out).untracked, [
    { path: 'a b.txt', status: '?' },
    { path: 'line\nbreak.txt', status: '?' },
    { path: 'dir/x', status: '?' },
  ]);
});

test('parseWorktreeBranches maps branches to worktree paths', () => {
  const out = [
    'worktree /r/main',
    `HEAD ${H}`,
    'branch refs/heads/main',
    '',
    'worktree /r/feature x',
    `HEAD ${H}`,
    'branch refs/heads/feat/x',
    '',
    'worktree /r/detached',
    `HEAD ${H}`,
    'detached',
    '',
    '',
  ].join('\0');
  assert.deepEqual(
    [...git.parseWorktreeBranches(out)],
    [
      ['main', '/r/main'],
      ['feat/x', '/r/feature x'],
    ],
  );
});

// ----- repoRelative (pure-ish) -----

test('repoRelative accepts relative and absolute paths inside the root', () => {
  assert.equal(git.repoRelative('/repo', 'a/b.txt'), 'a/b.txt');
  assert.equal(git.repoRelative('/repo', '/repo/a/b.txt'), 'a/b.txt');
  assert.equal(git.repoRelative('/repo', 'a/../c'), 'c');
});

test('repoRelative rejects escapes, the root itself and NULs', () => {
  for (const p of ['../x', '/etc/passwd', '/repo-sibling/x', '.', '', 'a\0b', 'a/../../x']) {
    assert.throws(() => git.repoRelative('/repo', p), (e: unknown) => e instanceof git.GitError && e.status === 400, p);
  }
});

// ----- against real repos -----

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function withRepo(fn: (repo: string, tmp: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'omniterm-git-lib-'));
    const repo = path.join(tmp, 'repo');
    mkdirSync(repo);
    sh(['init', '-q', '-b', 'main'], repo);
    sh(['config', 'user.email', 'test@example.com'], repo);
    sh(['config', 'user.name', 'Test'], repo);
    sh(['config', 'commit.gpgsign', 'false'], repo);
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    writeFileSync(path.join(repo, 'old.ts'), 'export const x = 1;\n');
    sh(['add', '-A'], repo);
    sh(['commit', '-q', '-m', 'init'], repo);
    try {
      await fn(repo, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

test('findRoot: subdir, file and non-repo', withRepo(async (repo, tmp) => {
  mkdirSync(path.join(repo, 'sub'));
  assert.equal(await git.findRoot(path.join(repo, 'sub')), repo);
  assert.equal(await git.findRoot(path.join(repo, 'a.txt')), repo);
  mkdirSync(path.join(tmp, 'plain'));
  assert.equal(await git.findRoot(path.join(tmp, 'plain')), null);
  assert.equal(await git.findRoot(path.join(tmp, 'missing')), null);
}));

test('findRoot keeps the logical path of a symlinked workspace', withRepo(async (repo, tmp) => {
  const link = path.join(tmp, 'link');
  symlinkSync(repo, link);
  assert.equal(await git.findRoot(link), link);
  // An absolute path through the physical location still maps into the repo.
  assert.equal(git.repoRelative(link, path.join(repo, 'a.txt')), 'a.txt');
}));

test('status, stage, unstage and discard round-trip', withRepo(async (repo) => {
  writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  writeFileSync(path.join(repo, 'new file.txt'), 'n\n');
  sh(['mv', 'old.ts', 'renamed.ts'], repo);
  let s = await git.status(repo);
  assert.deepEqual(s.staged, [{ path: 'renamed.ts', status: 'R', oldPath: 'old.ts' }]);
  assert.deepEqual(s.unstaged, [{ path: 'a.txt', status: 'M' }]);
  assert.deepEqual(s.untracked, [{ path: 'new file.txt', status: '?' }]);

  await git.stage(repo, ['a.txt', 'new file.txt']);
  s = await git.status(repo);
  assert.deepEqual(s.unstaged, []);
  assert.deepEqual(s.untracked, []);
  assert.equal(s.staged.length, 3);

  await git.unstage(repo, ['renamed.ts', 'old.ts', 'new file.txt']);
  s = await git.status(repo);
  assert.deepEqual(s.staged, [{ path: 'a.txt', status: 'M' }]);
  assert.deepEqual(
    s.unstaged.map((c) => [c.path, c.status]),
    [['old.ts', 'D']],
  );
  assert.deepEqual(
    s.untracked.map((c) => c.path).sort(),
    ['new file.txt', 'renamed.ts'],
  );

  // Discard: tracked restores from the index; untracked is deleted.
  await git.discard(repo, ['old.ts', 'new file.txt']);
  assert.equal(readFileSync(path.join(repo, 'old.ts'), 'utf-8'), 'export const x = 1;\n');
  assert.equal(existsSync(path.join(repo, 'new file.txt')), false);
  // a.txt is staged-only: discard leaves the staged change alone.
  await git.discard(repo, ['a.txt']);
  assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf-8'), 'two\n');
}));

test('discard rejects paths outside the repo', withRepo(async (repo, tmp) => {
  writeFileSync(path.join(tmp, 'outside.txt'), 'keep\n');
  await assert.rejects(git.discard(repo, ['../outside.txt']), (e: unknown) => e instanceof git.GitError && e.status === 400);
  assert.ok(existsSync(path.join(tmp, 'outside.txt')));
}));

test('diff: staged, unstaged, untracked, renamed and language', withRepo(async (repo) => {
  writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  sh(['add', 'a.txt'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  assert.deepEqual(await git.diff(repo, 'a.txt', true), {
    path: 'a.txt',
    original: 'one\n',
    modified: 'two\n',
    language: 'text',
  });
  const wt = await git.diff(repo, path.join(repo, 'a.txt'), false);
  assert.equal(wt.original, 'two\n');
  assert.equal(wt.modified, 'three\n');

  writeFileSync(path.join(repo, 'n.py'), 'print(1)\n');
  assert.deepEqual(await git.diff(repo, 'n.py', false), {
    path: 'n.py',
    original: '',
    modified: 'print(1)\n',
    language: 'python',
  });

  sh(['mv', 'old.ts', 'new.ts'], repo);
  const r = await git.diff(repo, 'new.ts', true);
  assert.equal(r.original, 'export const x = 1;\n');
  assert.equal(r.modified, 'export const x = 1;\n');
  assert.equal(r.language, 'typescript');
}));

test('unstage works on an unborn branch', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'omniterm-git-lib-'));
  try {
    sh(['init', '-q'], tmp);
    writeFileSync(path.join(tmp, 'f.txt'), 'x\n');
    await git.stage(tmp, ['f.txt']);
    assert.equal((await git.status(tmp)).staged.length, 1);
    await git.unstage(tmp, ['f.txt']);
    const s = await git.status(tmp);
    assert.deepEqual(s.staged, []);
    assert.deepEqual(s.untracked, [{ path: 'f.txt', status: '?' }]);
    // info on an unborn branch: still a repo, branch known.
    const i = await git.info(tmp);
    assert.equal(i.isRepo, true);
    assert.equal(i.detached, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('commit, amend, branches, checkout and rename', withRepo(async (repo, tmp) => {
  await assert.rejects(git.commit(repo, '  ', false), (e: unknown) => e instanceof git.GitError && e.status === 400);
  await assert.rejects(git.commit(repo, 'nothing staged', false), (e: unknown) => e instanceof git.GitError && e.status === 409);

  writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  await git.stage(repo, ['a.txt']);
  const sha = await git.commit(repo, '-starts with a dash', false);
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(sh(['log', '-1', '--format=%s'], repo).trim(), '-starts with a dash');
  const amended = await git.commit(repo, 'amended', true);
  assert.notEqual(amended, sha);
  assert.equal(sh(['rev-list', '--count', 'HEAD'], repo).trim(), '2');

  await git.checkout(repo, 'feature', true);
  assert.equal((await git.info(repo)).branch, 'feature');
  await git.checkout(repo, 'main', false);
  await git.renameBranch(repo, 'feature', 'feature-2');
  sh(['worktree', 'add', '-q', path.join(tmp, 'wt'), 'feature-2'], repo);

  const b = await git.branches(repo);
  assert.equal(b.current, 'main');
  assert.deepEqual(b.local, [
    { name: 'feature-2', worktreePath: path.join(tmp, 'wt') },
    { name: 'main', worktreePath: null },
  ]);
  assert.deepEqual(b.remote, []);

  for (const bad of ['-x', 'a..b', '', 'has space']) {
    await assert.rejects(git.checkout(repo, bad, true), (e: unknown) => e instanceof git.GitError && e.status === 400, bad);
  }
  await assert.rejects(git.checkout(repo, 'no-such-branch', false), (e: unknown) => e instanceof git.GitError && e.status === 409);
}));

test('info reports upstream and ahead/behind', withRepo(async (repo, tmp) => {
  const remote = path.join(tmp, 'remote.git');
  sh(['init', '-q', '--bare', remote], tmp);
  sh(['remote', 'add', 'origin', remote], repo);
  sh(['push', '-q', '-u', 'origin', 'main'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'ahead\n');
  sh(['commit', '-q', '-am', 'ahead'], repo);
  assert.deepEqual(await git.info(repo), {
    isRepo: true,
    root: repo,
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
  });
  assert.deepEqual((await git.branches(repo)).remote, ['origin/main']);

  sh(['checkout', '-q', '--detach'], repo);
  const d = await git.info(repo);
  assert.equal(d.detached, true);
  assert.equal(d.branch, 'HEAD');
}));
