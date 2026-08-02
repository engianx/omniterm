import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { loadSettings, saveSettings } from './settings.js';
import { displayNameForPath, repoIdForPath } from './ids.js';
import { listWorktrees, removeWorktree } from './worktrees.js';
import { deleteSessionsForWorktree } from '../plugins/terminal/lib/sessions.js';

// `Repo` crosses the plugin boundary (HostContext.repos()), so it is declared
// in @omniterm/plugin-types and re-exported here.
import type { Repo } from '@omniterm/plugin-types';
export type { Repo };

// Resolve the path to the git config file for a tracked repo. Handles a normal
// `.git` directory, a linked-worktree `.git` file (gitdir: -> commondir), and a
// bare repo whose config sits at the root.
function gitConfigPath(repoPath: string): string | null {
  const dotGit = path.join(repoPath, '.git');
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return path.join(dotGit, 'config');
    if (st.isFile()) {
      // A `.git` file without a `gitdir:` line is malformed; fall through to the
      // bare-repo check below (returns null → empty remoteUrl) rather than throw.
      const m = readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitdir = path.resolve(repoPath, m[1].trim());
        const cdFile = path.join(gitdir, 'commondir');
        const common = existsSync(cdFile)
          ? path.resolve(gitdir, readFileSync(cdFile, 'utf-8').trim())
          : gitdir;
        return path.join(common, 'config');
      }
    }
  } catch {
    // fall through to bare-repo check
  }
  const rootCfg = path.join(repoPath, 'config');
  return existsSync(rootCfg) ? rootCfg : null;
}

// Minimal git-config parse: find the [remote "origin"] section and its url.
function parseOriginUrl(configText: string): string {
  let inOrigin = false;
  for (const raw of configText.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (inOrigin) {
      const m = line.match(/^url\s*=\s*(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return '';
}

// Cache parsed remote URLs by config path + mtime. Reading/parsing .git/config
// directly avoids spawning a `git config` subprocess per repo on every workspace
// switch — that synchronous spawn (×N repos) blocked the Node event loop and was
// the dominant cost of listing repos and switching workspaces.
const remoteUrlCache = new Map<string, { mtimeMs: number; url: string }>();

function getRemoteUrl(repoPath: string): string {
  const cfg = gitConfigPath(repoPath);
  if (!cfg) return '';
  try {
    const { mtimeMs } = statSync(cfg);
    const hit = remoteUrlCache.get(cfg);
    if (hit && hit.mtimeMs === mtimeMs) return hit.url;
    const url = parseOriginUrl(readFileSync(cfg, 'utf-8'));
    remoteUrlCache.set(cfg, { mtimeMs, url });
    return url;
  } catch {
    return '';
  }
}

function isGitRepo(dirPath: string): boolean {
  return existsSync(path.join(dirPath, '.git')) || existsSync(path.join(dirPath, 'HEAD'));
}

export function listRepos(): Repo[] {
  const settings = loadSettings();
  return settings.trackedRepos
    .filter((p) => existsSync(p) && isGitRepo(p))
    .map((p) => ({
      id: repoIdForPath(p),
      name: displayNameForPath(p),
      remoteUrl: getRemoteUrl(p),
      path: p,
    }));
}

export function getRepo(repoId: string): Repo | undefined {
  // Resolve a single repo without building (and git-reading) the whole list —
  // this is on the per-workspace hot path and is called for every worktrees fetch.
  // Ids are path-derived, so at most one tracked repo can match; there is no
  // "first match wins" ambiguity between same-named checkouts.
  const settings = loadSettings();
  for (const p of settings.trackedRepos) {
    if (repoIdForPath(p) === repoId && existsSync(p) && isGitRepo(p)) {
      return { id: repoId, name: displayNameForPath(p), remoteUrl: getRemoteUrl(p), path: p };
    }
  }
  return undefined;
}

export function addLocalPath(localPath: string): { type: 'repo' | 'dir'; path: string } {
  const resolved = path.resolve(localPath);

  if (!existsSync(resolved)) {
    throw new Error(`Path "${resolved}" does not exist`);
  }

  const settings = loadSettings();

  if (isGitRepo(resolved)) {
    if (!settings.trackedRepos.includes(resolved)) {
      saveSettings({ trackedRepos: [...settings.trackedRepos, resolved] });
    }
    return { type: 'repo', path: resolved };
  } else {
    const trackedRepos = settings.trackedRepos.filter((p) => p !== resolved);
    const trackedDirs = settings.trackedDirs.includes(resolved)
      ? settings.trackedDirs
      : [...settings.trackedDirs, resolved];
    if (
      trackedRepos.length !== settings.trackedRepos.length ||
      trackedDirs !== settings.trackedDirs
    ) {
      saveSettings({ trackedRepos, trackedDirs });
    }
    return { type: 'dir', path: resolved };
  }
}

export function cloneRepo(url: string, destination?: string): Repo {
  const slug = url.match(/\/([^/]+?)(\.git)?$/)?.[1] || 'repo';
  const clonePath = destination || path.join(process.env.HOME || '/tmp', slug);

  if (existsSync(clonePath)) {
    throw new Error(`"${clonePath}" already exists`);
  }

  execFileSync('git', ['clone', url, clonePath], {
    encoding: 'utf-8',
    timeout: 300000,
  });

  const settings = loadSettings();
  saveSettings({ trackedRepos: [...settings.trackedRepos, clonePath] });

  return {
    id: repoIdForPath(clonePath),
    name: displayNameForPath(clonePath),
    remoteUrl: url,
    path: clonePath,
  };
}

export function removeRepo(repoId: string): {
  worktreesRemoved: number;
  worktreesSkipped: string[];
  sessionsKilled: number;
} {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`Repo "${repoId}" not found`);

  let worktreesRemoved = 0;
  let sessionsKilled = 0;
  const worktreesSkipped: string[] = [];

  const worktrees = listWorktrees(repo.path, repoId);
  for (const wt of worktrees) {
    // Untracking a repo always tears down its terminal sessions to free the
    // tmux/ttyd resources — independent of whether the worktree files survive.
    // Doing this unconditionally (not just on successful removal) avoids
    // orphaning sessions of kept worktrees once the repo leaves the list.
    sessionsKilled += deleteSessionsForWorktree(wt.id);

    // The main worktree can't be removed by `git worktree remove` and isn't a
    // worktree we created — leave its files in place and don't report it as
    // "left behind" work alongside genuinely dirty worktrees.
    if (wt.isMain) continue;

    try {
      // No force: git refuses worktrees with uncommitted changes, so untracking
      // a repo never discards the user's in-progress work. Kept worktrees are
      // reported back so the caller can tell the user what was left behind.
      removeWorktree(repo.path, wt.path);
      worktreesRemoved++;
    } catch {
      // Dirty, or otherwise unremovable — keep the files, report it back.
      worktreesSkipped.push(wt.path);
    }
  }

  // Remove from tracked repos (don't delete files — user owns them)
  const settings = loadSettings();
  saveSettings({
    trackedRepos: settings.trackedRepos.filter((p) => p !== repo.path),
  });

  return { worktreesRemoved, worktreesSkipped, sessionsKilled };
}
