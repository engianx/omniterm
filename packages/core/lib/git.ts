/**
 * Git operations behind /api/git/* (server/routes/git.ts): status parsing,
 * diffs, stage/unstage/discard/commit and branch management for the Changes
 * panel and the status bar.
 *
 * Every call goes through `execFile` with an argument array (never a shell),
 * a timeout and `--` before pathspecs. Paths handed in by clients are
 * resolved against the repo root and rejected if they escape it.
 */

import { execFile } from 'child_process';
import { realpathSync } from 'fs';
import { readFile, rm, stat } from 'fs/promises';
import path from 'path';
import { detectLanguage } from './languages.js';

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface Change {
  /** Relative to the repo root, '/'-separated. */
  path: string;
  status: ChangeStatus;
  /** Source path of a rename/copy. */
  oldPath?: string;
}

export interface BranchStatus {
  /** Branch name, or null when HEAD is detached. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ParsedStatus {
  branch: BranchStatus;
  staged: Change[];
  unstaged: Change[];
  untracked: Change[];
}

/** A failed git operation, carrying the HTTP status the route should answer. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 = 409,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;
/** Commits run hooks (lint, tests) — give them longer. */
const COMMIT_TIMEOUT_MS = 120_000;
/** Largest blob/file a diff will return. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

interface RunOptions {
  timeout?: number;
  maxBuffer?: number;
}

function run(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf-8',
        timeout: opts.timeout ?? TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        // Never block on a credential/editor prompt; don't take index.lock for
        // read-only refreshes (avoids racing the user's own git in a terminal).
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'true' },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(new GitError('Output too large', 413));
        }
        const msg = (stderr || err.message).trim().replace(/^(fatal|error): /, '');
        reject(new GitError(msg || `git ${args[0]} failed`));
      },
    );
  });
}

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parsePorcelainV2(out: string): ParsedStatus {
  const branch: BranchStatus = { head: null, upstream: null, ahead: 0, behind: 0 };
  const staged: Change[] = [];
  const unstaged: Change[] = [];
  const untracked: Change[] = [];
  const fields = out.split('\0');

  /** Index (X) / worktree (Y) code -> our status; '.' means unchanged. */
  const code = (c: string): ChangeStatus | null => {
    if (c === '.') return null;
    if (c === 'T') return 'M'; // type change (file <-> symlink): show as modified
    return 'MADRC'.includes(c) ? (c as ChangeStatus) : 'M';
  };

  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    const kind = rec[0];
    if (kind === '#') {
      const [, key, ...rest] = rec.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') branch.head = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
    } else if (kind === '?') {
      untracked.push({ path: rec.slice(2), status: '?' });
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 <path>
      unstaged.push({ path: splitAfter(rec, 10), status: 'U' });
    } else if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI <path>
      // 2 XY sub mH mI mW hH hI Xscore <path>\0<origPath>
      const p = splitAfter(rec, kind === '1' ? 8 : 9);
      const oldPath = kind === '2' ? fields[++i] : undefined;
      const x = code(rec[2]);
      const y = code(rec[3]);
      // The rename belongs to whichever side reports R/C (normally the index).
      const withOld = (s: ChangeStatus): Change =>
        oldPath !== undefined && (s === 'R' || s === 'C') ? { path: p, status: s, oldPath } : { path: p, status: s };
      if (x) staged.push(withOld(x));
      if (y) unstaged.push(withOld(y));
    }
    // '!' (ignored) is never requested.
  }
  return { branch, staged, unstaged, untracked };
}

/** The remainder of `rec` after its first `n` space-separated fields (a path,
 *  which may itself contain spaces). */
function splitAfter(rec: string, n: number): string {
  let idx = 0;
  for (let k = 0; k < n; k++) idx = rec.indexOf(' ', idx) + 1;
  return rec.slice(idx);
}

/**
 * The working tree root for `cwd` (a directory or file inside the repo), or
 * null if it isn't in a git work tree. Derived from `--show-cdup` so a
 * workspace opened through a symlink keeps its logical path (`--show-toplevel`
 * would return the physical one).
 */
export async function findRoot(cwd: string): Promise<string | null> {
  let dir = cwd;
  try {
    if (!(await stat(dir)).isDirectory()) dir = path.dirname(dir);
  } catch {
    return null;
  }
  try {
    // Inside `.git` itself `--show-cdup` succeeds but there's no work tree.
    const [inside, cdup = ''] = (await run(dir, ['rev-parse', '--is-inside-work-tree', '--show-cdup'])).split('\n');
    return inside === 'true' ? path.resolve(dir, cdup) : null;
  } catch {
    return null;
  }
}

/** Like `findRoot`, but a non-repo is a 400. */
export async function requireRoot(cwd: string): Promise<string> {
  const root = await findRoot(cwd);
  if (!root) throw new GitError('Not a git repository', 400);
  return root;
}

/**
 * Resolve a client path (relative to `root`, or absolute) to a '/'-separated
 * repo-relative path. Throws 400 if it escapes the repo or is the root itself.
 */
export function repoRelative(root: string, p: string): string {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new GitError('Invalid path', 400);
  let abs = path.resolve(root, p);
  let rel = path.relative(root, abs);
  if (path.isAbsolute(p) && (rel.startsWith('..') || path.isAbsolute(rel))) {
    // An absolute path may reach the repo through a different symlink than
    // `root` did; compare physical paths before giving up.
    try {
      abs = path.join(realpathSync(path.dirname(abs)), path.basename(abs));
      rel = path.relative(realpathSync(root), abs);
    } catch {
      // nonexistent parent: fall through to the rejection below
    }
  }
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new GitError(`Path outside repository: ${p}`, 400);
  }
  return rel.split(path.sep).join('/');
}

function repoPaths(root: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new GitError('paths required', 400);
  return paths.map((p) => repoRelative(root, p as string));
}

export async function status(root: string): Promise<ParsedStatus> {
  const out = await run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  return parsePorcelainV2(out);
}

export interface GitInfo {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export async function info(cwd: string): Promise<GitInfo> {
  const root = await findRoot(cwd);
  if (!root) {
    return { isRepo: false, root: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0 };
  }
  const { branch } = await status(root);
  return {
    isRepo: true,
    root,
    branch: branch.head ?? 'HEAD',
    detached: branch.head === null,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
  };
}

/** `git show <rev>:<path>`, or null when the object doesn't exist there. */
async function showBlob(root: string, spec: string): Promise<string | null> {
  try {
    return await run(root, ['show', spec], { maxBuffer: MAX_DIFF_BYTES });
  } catch (e) {
    if (e instanceof GitError && e.status === 413) throw new GitError('File too large', 413);
    return null;
  }
}

async function readWorktree(root: string, rel: string): Promise<string> {
  const abs = path.join(root, rel);
  try {
    const s = await stat(abs);
    if (!s.isFile()) return '';
    if (s.size > MAX_DIFF_BYTES) throw new GitError('File too large', 413);
    return await readFile(abs, 'utf-8');
  } catch (e) {
    if (e instanceof GitError) throw e;
    return ''; // deleted in the working tree
  }
}

export interface FileDiff {
  path: string;
  original: string;
  modified: string;
  language: string;
}

/**
 * Both sides of one file's change: staged = HEAD vs index, otherwise index vs
 * working tree. A side that doesn't exist (added, deleted, untracked) is ''.
 */
export async function diff(root: string, p: string, staged: boolean): Promise<FileDiff> {
  const rel = repoRelative(root, p);
  let original: string;
  let modified: string;
  if (staged) {
    let head = await showBlob(root, `HEAD:${rel}`);
    if (head === null) {
      // A staged rename: the original lives under the old name.
      const renamed = (await status(root)).staged.find((c) => c.path === rel && c.oldPath);
      if (renamed?.oldPath) head = await showBlob(root, `HEAD:${renamed.oldPath}`);
    }
    original = head ?? '';
    modified = (await showBlob(root, `:${rel}`)) ?? '';
  } else {
    original = (await showBlob(root, `:${rel}`)) ?? '';
    modified = await readWorktree(root, rel);
  }
  const base = path.posix.basename(rel).toLowerCase();
  return { path: rel, original, modified, language: detectLanguage(path.posix.extname(base), base) };
}

export async function stage(root: string, paths: unknown): Promise<void> {
  // -A: also records deletions of tracked files.
  await run(root, ['add', '-A', '--', ...repoPaths(root, paths)]);
}

async function hasHead(root: string): Promise<boolean> {
  try {
    await run(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function unstage(root: string, paths: unknown): Promise<void> {
  const rels = repoPaths(root, paths);
  if (await hasHead(root)) await run(root, ['reset', '-q', '--', ...rels]);
  // Unborn branch: there is no HEAD to reset to, so just drop the entries.
  else await run(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...rels]);
}

/** Tracked: restore the working tree from the index. Untracked: delete. */
export async function discard(root: string, paths: unknown): Promise<void> {
  const rels = repoPaths(root, paths);
  const st = await status(root);
  const untracked = new Set(st.untracked.map((c) => c.path));
  const modified = new Set(st.unstaged.map((c) => c.path));
  const toRestore = rels.filter((r) => modified.has(r));
  const toDelete = rels.filter((r) => untracked.has(r));
  if (toRestore.length > 0) await run(root, ['checkout', '-q', '--', ...toRestore]);
  for (const r of toDelete) await rm(path.join(root, r), { force: true });
}

export async function commit(root: string, message: unknown, amend: boolean): Promise<string> {
  if (typeof message !== 'string' || !message.trim()) throw new GitError('Commit message required', 400);
  await run(root, ['commit', '-q', ...(amend ? ['--amend'] : []), '-m', message], {
    timeout: COMMIT_TIMEOUT_MS,
  });
  return (await run(root, ['rev-parse', 'HEAD'])).trim();
}

export interface Branches {
  /** Current branch, or 'HEAD' when detached. */
  current: string;
  /** `worktreePath` is set when the branch is checked out in ANOTHER worktree. */
  local: { name: string; worktreePath: string | null }[];
  remote: string[];
}

/** Map branch name -> worktree path from `git worktree list --porcelain -z`. */
export function parseWorktreeBranches(out: string): Map<string, string> {
  const result = new Map<string, string>();
  let wt: string | null = null;
  for (const field of out.split('\0')) {
    if (field.startsWith('worktree ')) wt = field.slice('worktree '.length);
    else if (field.startsWith('branch refs/heads/') && wt) result.set(field.slice('branch refs/heads/'.length), wt);
  }
  return result;
}

export async function branches(root: string): Promise<Branches> {
  const [st, heads, remotes, wts] = await Promise.all([
    status(root),
    run(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    run(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
    run(root, ['worktree', 'list', '--porcelain', '-z']),
  ]);
  const byBranch = parseWorktreeBranches(wts);
  const current = st.branch.head;
  const lines = (s: string) => s.split('\n').filter(Boolean);
  return {
    current: current ?? 'HEAD',
    local: lines(heads).map((name) => {
      const wt = byBranch.get(name);
      return { name, worktreePath: wt && name !== current ? wt : null };
    }),
    // `origin/HEAD` is a pointer, not a branch (short form is just `origin`).
    remote: lines(remotes).filter((r) => r.includes('/') && !r.endsWith('/HEAD')),
  };
}

async function validBranchName(root: string, name: unknown): Promise<string> {
  if (typeof name !== 'string' || !name || name.startsWith('-')) throw new GitError('Invalid branch name', 400);
  try {
    await run(root, ['check-ref-format', '--branch', name]);
  } catch {
    throw new GitError(`Invalid branch name: ${name}`, 400);
  }
  return name;
}

export async function checkout(root: string, branch: unknown, create: boolean): Promise<void> {
  const name = await validBranchName(root, branch);
  // Trailing `--`: the argument is a branch, never a pathspec.
  await run(root, create ? ['checkout', '-q', '-b', name, '--'] : ['checkout', '-q', name, '--']);
}

export async function renameBranch(root: string, from: unknown, to: unknown): Promise<void> {
  const oldName = await validBranchName(root, from);
  const newName = await validBranchName(root, to);
  await run(root, ['branch', '-m', oldName, newName]);
}
