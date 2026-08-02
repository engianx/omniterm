export interface WorkspaceFilterRepo {
  id: string;
}

export interface WorkspaceFilterWorktree {
  repoId: string;
  path: string;
  sessionCount: number;
}

export interface WorkspaceFilterOrphanSession {
  name: string;
  created: string;
}

export interface FilteredWorkspaceRepo<
  TRepo extends WorkspaceFilterRepo,
  TWorktree extends WorkspaceFilterWorktree,
> {
  repo: TRepo;
  worktrees: TWorktree[];
}

export function hasActiveWorkspacePath(
  path: string,
  sessionCount: number,
  orphanSessions: Record<string, WorkspaceFilterOrphanSession[]>,
  alertedPaths: Set<string>,
): boolean {
  return alertedPaths.has(path) || sessionCount > 0 || (orphanSessions[path] || []).length > 0;
}

export function filterWorkspacePanelData<
  TRepo extends WorkspaceFilterRepo,
  TWorktree extends WorkspaceFilterWorktree,
>(input: {
  repos: TRepo[];
  worktreesByRepo: Record<string, TWorktree[]>;
  orphanSessions: Record<string, WorkspaceFilterOrphanSession[]>;
  alertedPaths: Set<string>;
  activeOnly: boolean;
}): {
  orderedDirs: [string, WorkspaceFilterOrphanSession[]][];
  visibleRepos: FilteredWorkspaceRepo<TRepo, TWorktree>[];
} {
  const { repos, worktreesByRepo, orphanSessions, alertedPaths, activeOnly } = input;

  const orderedDirs = Object.entries(orphanSessions).filter(([dir]) => {
    if (!activeOnly) return true;
    return hasActiveWorkspacePath(dir, 0, orphanSessions, alertedPaths);
  });

  const visibleRepos = repos
    .map((repo) => ({
      repo,
      worktrees: (worktreesByRepo[repo.id] || []).filter(
        (wt) =>
          !activeOnly ||
          hasActiveWorkspacePath(wt.path, wt.sessionCount, orphanSessions, alertedPaths),
      ),
    }))
    .filter(({ worktrees }) => !activeOnly || worktrees.length > 0);

  return { orderedDirs, visibleRepos };
}
