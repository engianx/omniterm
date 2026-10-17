import { execFile } from 'child_process';
import { existsSync, statSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { loadSettings, saveSettings } from './settings.js';
import { displayNameForPath, repoIdForPath, worktreeIdForPath } from './ids.js';
import { getRemoteUrl, isGitRepo } from './gitDir.js';
import { cloneSlug } from './cloneUrl.js';
import {
  createWorktree,
  isWorktreeDirty,
  listWorktrees,
  listWorktreesAsync,
  removeWorktree,
  type Worktree,
} from './worktrees.js';
import { deleteSessionsForWorktree } from '../plugins/terminal/lib/sessions.js';

/**
 * Workspaces: folders the user opened, with git as a capability detected on
 * each one rather than a separate kind of entry.
 *
 * Two spellings of one folder, and why both survive:
 *
 *   - Tracked entries are addressed by their LEXICAL path (as the user gave
 *     it, normalized with path.resolve). A folder and a symlink to it are two
 *     entries, the same rule lib/ids.ts gives repo ids, so untracking one row
 *     never untracks the other.
 *   - `WorkspaceEntry.id` is `worktreeIdForPath`, which RESOLVES symlinks: it is
 *     the id terminal sessions are keyed by, so a workspace keeps its sessions
 *     no matter which spelling opened it. Two such rows share an id, which is why
 *     every mutation here takes a path, never an id.
 *
 * Linked worktrees of a tracked main worktree are listed automatically (with
 * `parent` set) instead of being tracked; they appear and disappear with git.
 */

const execFileAsync = promisify(execFile);

export interface WorkspaceGit {
  /** Main worktree path. */
  root: string;
  /** Checked-out branch, or 'HEAD' when detached. */
  branch: string;
  isMainWorktree: boolean;
  remoteUrl: string;
}

export interface WorkspaceEntry {
  /** worktreeIdForPath(path): the id terminal sessions are keyed by. */
  id: string;
  path: string;
  name: string;
  exists: boolean;
  /** The tracked main-worktree path, when this is an auto-listed linked worktree. */
  parent: string | null;
  git: WorkspaceGit | null;
  sessionCount: number;
}

/** A failure with the HTTP status the routes should answer with. */
export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Worktrees of a tracked path, or null when it isn't a git repo root. An empty
 * result from git (a bare repo with no worktrees, or a stray `HEAD` file that
 * isn't a repo at all) also reads as "no git": there is no work tree to show.
 */
async function probeWorktrees(dirPath: string): Promise<Worktree[] | null> {
  if (!isGitRepo(dirPath)) return null;
  const worktrees = await listWorktreesAsync(dirPath, repoIdForPath(dirPath));
  return worktrees.length > 0 ? worktrees : null;
}

/**
 * Every workspace in panel order: each tracked entry, followed by its linked
 * worktrees when it is a main worktree. `sessionCwds` are the cwds of live
 * terminal sessions; each counts toward the workspace whose id it resolves to.
 */
export async function listWorkspaces(
  sessionCwds: readonly string[] = [],
): Promise<WorkspaceEntry[]> {
  const tracked = loadSettings().workspaces;
  const sessionCounts = new Map<string, number>();
  for (const cwd of sessionCwds) {
    const id = worktreeIdForPath(cwd);
    sessionCounts.set(id, (sessionCounts.get(id) ?? 0) + 1);
  }
  const trackedIds = new Set(tracked.map((p) => worktreeIdForPath(p)));
  const autoListed = new Set<string>();
  const probes = await Promise.all(
    tracked.map((p) => (existsSync(p) ? probeWorktrees(p) : Promise.resolve(null))),
  );

  const entries: WorkspaceEntry[] = [];
  tracked.forEach((wsPath, i) => {
    const id = worktreeIdForPath(wsPath);
    const worktrees = probes[i];
    const self = worktrees?.find((w) => w.id === id);
    const remoteUrl = worktrees ? getRemoteUrl(wsPath) : '';
    const root = self?.isMain ? wsPath : (worktrees?.find((w) => w.isMain)?.path ?? wsPath);
    entries.push({
      id,
      path: wsPath,
      name: displayNameForPath(wsPath),
      exists: existsSync(wsPath),
      parent: null,
      git: worktrees
        ? {
            root,
            branch: self?.branch ?? 'HEAD',
            isMainWorktree: self?.isMain ?? true,
            remoteUrl,
          }
        : null,
      sessionCount: sessionCounts.get(id) ?? 0,
    });
    if (!worktrees || !self?.isMain) return;
    for (const wt of worktrees) {
      // A linked worktree the user also tracked is listed once, as its own
      // tracked row; one reachable from two tracked spellings of its repo is
      // nested under the first.
      if (wt.isMain || trackedIds.has(wt.id) || autoListed.has(wt.id)) continue;
      autoListed.add(wt.id);
      entries.push({
        id: wt.id,
        path: wt.path,
        name: displayNameForPath(wt.path),
        exists: existsSync(wt.path),
        parent: wsPath,
        git: { root: wsPath, branch: wt.branch, isMainWorktree: false, remoteUrl },
        sessionCount: sessionCounts.get(wt.id) ?? 0,
      });
    }
  });
  return entries;
}

/** The listed entry for a path: exact tracked spelling first, then by resolved id. */
export function findWorkspace(
  entries: WorkspaceEntry[],
  dirPath: string,
): WorkspaceEntry | undefined {
  const resolved = path.resolve(dirPath);
  return (
    entries.find((e) => e.path === resolved) ??
    entries.find((e) => e.id === worktreeIdForPath(resolved))
  );
}

/** The main worktree of the repo a linked worktree belongs to, or null for anything else. */
function mainWorktreeOf(dirPath: string): Worktree | null {
  let dotGit;
  try {
    dotGit = statSync(path.join(dirPath, '.git'));
  } catch {
    return null;
  }
  // Only a linked worktree has a `.git` *file*; skip the spawn for everything else.
  if (!dotGit.isFile()) return null;
  const main = listWorktrees(dirPath, '').find((w) => w.isMain);
  return main && main.id !== worktreeIdForPath(dirPath) ? main : null;
}

/**
 * Track a folder. Returns `created: false` when it is already listed — tracked
 * under this spelling, or a linked worktree already shown under its tracked
 * repo (tracking it too would pull it out of its group).
 */
export function addWorkspace(dirPath: string): { path: string; created: boolean } {
  const resolved = path.resolve(dirPath);
  if (!existsSync(resolved)) throw new WorkspaceError(400, `Path "${resolved}" does not exist`);
  if (!isDirectory(resolved)) throw new WorkspaceError(400, `"${resolved}" is not a directory`);
  const { workspaces } = loadSettings();
  if (workspaces.includes(resolved)) return { path: resolved, created: false };
  const main = mainWorktreeOf(resolved);
  if (main && workspaces.some((w) => worktreeIdForPath(w) === main.id)) {
    return { path: resolved, created: false };
  }
  saveSettings({ workspaces: [...workspaces, resolved] });
  return { path: resolved, created: true };
}

/** `~/git/<slug>`, where a clone lands when the caller gives no destination. */
export function defaultCloneDestinationFor(url: string): string {
  return path.join(homedir(), 'git', cloneSlug(url));
}

/**
 * `git clone` into `destination` (default ~/git/<slug>) and track the result.
 * Async: a clone can take minutes, and a synchronous spawn would stall every
 * other request for that long.
 */
export async function cloneWorkspace(url: string, destination?: string): Promise<string> {
  const dest = path.resolve(destination || defaultCloneDestinationFor(url));
  if (existsSync(dest)) throw new WorkspaceError(409, `"${dest}" already exists`);
  try {
    // `--` keeps a URL that starts with '-' from being read as an option.
    await execFileAsync('git', ['clone', '--', url, dest], {
      encoding: 'utf-8',
      timeout: 300000,
    });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new WorkspaceError(400, stderr || (e instanceof Error ? e.message : String(e)));
  }
  addWorkspace(dest);
  return dest;
}

export interface UntrackResult {
  worktreesRemoved: number;
  worktreesSkipped: string[];
  sessionsKilled: number;
}

/**
 * Stop tracking a folder (its files are the user's and stay put).
 *
 * Untracking a main worktree keeps the old remove-repo contract: its terminal
 * sessions are torn down and its clean linked worktrees removed (dirty ones are
 * kept and reported, never forced). Anything still listed through another
 * tracked entry — a second spelling of the repo, or a linked worktree tracked
 * on its own — is left alone, since it is still on screen. A non-git folder
 * only leaves the list: its shells were opened free-form and outlive it.
 */
export function untrackWorkspace(dirPath: string): UntrackResult {
  const resolved = path.resolve(dirPath);
  const { workspaces } = loadSettings();
  if (!workspaces.includes(resolved)) throw new WorkspaceError(404, 'Workspace not tracked');
  const remaining = workspaces.filter((p) => p !== resolved);
  const remainingIds = new Set(remaining.map((p) => worktreeIdForPath(p)));
  const result: UntrackResult = { worktreesRemoved: 0, worktreesSkipped: [], sessionsKilled: 0 };

  const ownId = worktreeIdForPath(resolved);
  const worktrees =
    existsSync(resolved) && isGitRepo(resolved) ? listWorktrees(resolved, repoIdForPath(resolved)) : [];
  const self = worktrees.find((w) => w.id === ownId);
  if (self?.isMain && !remainingIds.has(ownId)) {
    for (const wt of worktrees) {
      if (remainingIds.has(wt.id)) continue;
      result.sessionsKilled += deleteSessionsForWorktree(wt.id);
      // The main worktree isn't ours to remove and isn't "left behind" work.
      if (wt.isMain) continue;
      try {
        removeWorktree(resolved, wt.path);
        result.worktreesRemoved++;
      } catch {
        result.worktreesSkipped.push(wt.path);
      }
    }
  } else if (self && !remainingIds.has(ownId)) {
    // A linked worktree tracked on its own: it stays listed under its repo
    // when that is tracked, and only its own sessions go otherwise.
    const main = worktrees.find((w) => w.isMain);
    if (!main || !remainingIds.has(main.id)) {
      result.sessionsKilled += deleteSessionsForWorktree(ownId);
    }
  }

  saveSettings({ workspaces: remaining });
  return result;
}

/** Create a linked worktree of the repo `dirPath` belongs to; returns its path. */
export function createWorkspaceWorktree(
  dirPath: string,
  branch?: string,
  newBranch: boolean = true,
): string {
  const resolved = path.resolve(dirPath);
  if (!existsSync(resolved) || !isGitRepo(resolved)) {
    throw new WorkspaceError(400, `"${resolved}" is not a git repository`);
  }
  const worktrees = listWorktrees(resolved, '');
  const main = worktrees.find((w) => w.isMain);
  if (!main) throw new WorkspaceError(400, `"${resolved}" has no main worktree`);
  // Name the new worktree after the repo as the user tracked it — its path
  // (`<repo>-<branch>`) and naming scheme (keyed by repo id) both derive from it.
  const repoPath =
    main.id === worktreeIdForPath(resolved)
      ? resolved
      : (loadSettings().workspaces.find((w) => worktreeIdForPath(w) === main.id) ?? main.path);
  try {
    return createWorktree(repoPath, repoIdForPath(repoPath), branch, newBranch).path;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WorkspaceError(message.includes('already') ? 409 : 400, message);
  }
}

export type WorktreeRemoval =
  | { ok: true; sessionsKilled: number }
  | { ok: false; status: number; error: string; requiresForce: boolean };

/**
 * Remove a linked worktree, then its sessions. Shared by DELETE
 * /api/workspaces/worktrees and the legacy DELETE /api/worktrees/:wtId.
 */
export function removeWorktreeAndSessions(
  repoPath: string,
  wt: Worktree,
  force: boolean,
): WorktreeRemoval {
  // Refuse up front when the worktree has uncommitted work and the caller
  // hasn't confirmed a force delete, surfacing requiresForce so the UI can
  // confirm before discarding work. The main worktree can't be removed even
  // with --force, so never advertise force for it. Checking here rather than
  // catching git's refusal avoids a second `git status` spawn on the error
  // path and makes the requiresForce contract explicit.
  if (!force && !wt.isMain && isWorktreeDirty(wt.path)) {
    return {
      ok: false,
      status: 409,
      error: 'Worktree has uncommitted changes',
      requiresForce: true,
    };
  }
  try {
    removeWorktree(repoPath, wt.path, { force });
  } catch (e: unknown) {
    // Unforceable for some reason forcing can't fix (the main worktree, a
    // locked worktree, submodules) — forcing won't help, so requiresForce
    // stays false and the UI won't prompt for a doomed retry.
    return {
      ok: false,
      status: 409,
      error: e instanceof Error ? e.message : String(e),
      requiresForce: false,
    };
  }
  // Tear sessions down only after a successful remove: when the worktree
  // survives (dirty/unforceable) we keep its sessions alive. This differs
  // from untracking a repo, which frees sessions for every worktree because
  // the whole repo is leaving the list.
  return { ok: true, sessionsKilled: deleteSessionsForWorktree(wt.id) };
}

/** Remove the worktree at `dirPath`, and drop it from the tracked list if it was there. */
export function deleteWorkspaceWorktree(dirPath: string, force: boolean): WorktreeRemoval {
  const resolved = path.resolve(dirPath);
  const worktrees =
    existsSync(resolved) && isGitRepo(resolved) ? listWorktrees(resolved, repoIdForPath(resolved)) : [];
  const wt = worktrees.find((w) => w.id === worktreeIdForPath(resolved));
  if (!wt) return { ok: false, status: 404, error: 'Worktree not found', requiresForce: false };
  // Run git from the main worktree: a worktree can't be removed from inside itself.
  const main = worktrees.find((w) => w.isMain);
  const removal = removeWorktreeAndSessions(main?.path ?? resolved, wt, force);
  if (removal.ok) {
    const { workspaces } = loadSettings();
    if (workspaces.includes(resolved)) {
      saveSettings({ workspaces: workspaces.filter((p) => p !== resolved) });
    }
  }
  return removal;
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

const MAX_COMPLETIONS = 50;

/**
 * Absolute directory paths completing a typed prefix: `~/gi` → `~/git`'s
 * siblings starting with "gi"; a trailing `/` lists that directory's children.
 *
 * Confined like every other path route, with one widening so typing from `/`
 * works: a directory that is an *ancestor* of an allowed root may be listed,
 * but only its children that lead into a root show up. `/` offers `home` (and
 * `/workspace` when tracked), never `etc`.
 */
export async function completeDirs(prefix: string, roots: string[]): Promise<string[]> {
  const raw = prefix || '~/';
  const expanded = raw.startsWith('~') ? raw.replace('~', homedir()) : raw;
  if (!path.isAbsolute(expanded)) return [];
  const endsWithSep = expanded.endsWith('/');
  const resolved = path.resolve(expanded);
  const dir = endsWithSep ? resolved : path.dirname(resolved);
  const partial = endsWithSep ? '' : path.basename(resolved).toLowerCase();
  const normalizedRoots = roots.filter(Boolean).map((r) => path.resolve(r));
  const reachable = (p: string) =>
    normalizedRoots.some((r) => isWithin(p, r) || isWithin(r, p));
  if (!reachable(dir)) return [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const showHidden = partial.startsWith('.');
  const dirs = await Promise.all(
    entries.map(async (e) => {
      if (!showHidden && e.name.startsWith('.')) return null;
      if (!e.name.toLowerCase().startsWith(partial)) return null;
      const full = path.join(dir, e.name);
      if (!reachable(full)) return null;
      if (e.isDirectory()) return full;
      if (!e.isSymbolicLink()) return null;
      try {
        return (await stat(full)).isDirectory() ? full : null;
      } catch {
        return null;
      }
    }),
  );
  return dirs
    .filter((d): d is string => d !== null)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_COMPLETIONS);
}
