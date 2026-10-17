import { existsSync } from 'fs';
import { loadSettings } from './settings.js';
import { displayNameForPath, repoIdForPath } from './ids.js';
import { getRemoteUrl, isGitRepo } from './gitDir.js';
import { addWorkspace, cloneWorkspace, untrackWorkspace, type UntrackResult } from './workspaces.js';

// The repo-shaped view of `workspaces` (lib/workspaces.ts): the tracked entries
// that are git repo roots. Kept for HostContext.repos() and the legacy
// /api/repos routes; new code should use lib/workspaces.ts.

// `Repo` crosses the plugin boundary (HostContext.repos()), so it is declared
// in @omniterm/plugin-types and re-exported here.
import type { Repo } from '@omniterm/plugin-types';
export type { Repo };

function toRepo(p: string): Repo {
  return { id: repoIdForPath(p), name: displayNameForPath(p), remoteUrl: getRemoteUrl(p), path: p };
}

export function listRepos(): Repo[] {
  return loadSettings()
    .trackedRepos.filter((p) => existsSync(p) && isGitRepo(p))
    .map(toRepo);
}

export function getRepo(repoId: string): Repo | undefined {
  // Resolve a single repo without building (and git-reading) the whole list —
  // this is on the per-workspace hot path and is called for every worktrees fetch.
  // Ids are path-derived, so at most one tracked repo can match; there is no
  // "first match wins" ambiguity between same-named checkouts.
  const p = loadSettings().trackedRepos.find((r) => repoIdForPath(r) === repoId);
  return p && existsSync(p) && isGitRepo(p) ? toRepo(p) : undefined;
}

/** Track a local folder; `type` says whether it was detected as a git repo. */
export function addLocalPath(localPath: string): { type: 'repo' | 'dir'; path: string } {
  const { path } = addWorkspace(localPath);
  return { type: isGitRepo(path) ? 'repo' : 'dir', path };
}

export async function cloneRepo(url: string, destination?: string): Promise<Repo> {
  const clonePath = await cloneWorkspace(url, destination);
  return { ...toRepo(clonePath), remoteUrl: url };
}

export function removeRepo(repoId: string): UntrackResult {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`Repo "${repoId}" not found`);
  return untrackWorkspace(repo.path);
}
