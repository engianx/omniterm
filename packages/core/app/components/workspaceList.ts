import type { WorkspaceEntry } from '../../lib/workspaces';
import { buildRepoLabels } from './repoLabels';

export type { WorkspaceEntry };

export interface WorkspaceRow {
  entry: WorkspaceEntry;
  /** Row text: the folder name, qualified when two top-level rows share one. */
  label: string;
  /** A live terminal session (or a pending alert) in this folder. */
  live: boolean;
  /** Not in the tracked list: a folder with stray tmux sessions, shown so they can be adopted. */
  discovered: boolean;
  /** Linked worktrees nested under a main worktree. */
  children: WorkspaceRow[];
}

interface OrphanSession {
  name: string;
  created: string;
}

/** Linked worktrees read by branch; a detached one falls back to its folder name. */
function branchLabel(entry: WorkspaceEntry): string {
  return entry.git && entry.git.branch !== 'HEAD' ? entry.git.branch : entry.name;
}

function liveFirst(rows: WorkspaceRow[]): WorkspaceRow[] {
  const isLive = (r: WorkspaceRow) => r.live || r.children.some((c) => c.live);
  // Array.prototype.sort is stable, so each group keeps the user's order.
  return [...rows].sort((a, b) => Number(isLive(b)) - Number(isLive(a)));
}

/**
 * The workspace panel's one flat list: tracked folders (git or not) in order,
 * linked worktrees nested under their repo, folders that only have stray
 * tmux sessions appended, and anything live sorted to the top.
 *
 * `orphanSessions` (from the terminal plugin, keyed by session cwd) counts
 * toward liveness only — it holds managed sessions too, see
 * bucketDiscoveredSessions.
 */
export function buildWorkspaceRows(input: {
  workspaces: WorkspaceEntry[];
  orphanSessions: Record<string, OrphanSession[]>;
  alertedPaths: ReadonlySet<string>;
}): WorkspaceRow[] {
  const { workspaces, orphanSessions, alertedPaths } = input;
  const isLive = (p: string, sessionCount: number) =>
    sessionCount > 0 || (orphanSessions[p]?.length ?? 0) > 0 || alertedPaths.has(p);

  const listed = new Set(workspaces.map((w) => w.path));
  const discovered: WorkspaceEntry[] = Object.entries(orphanSessions)
    .filter(([p, sessions]) => sessions.length > 0 && !listed.has(p))
    .map(([p]) => ({
      id: p,
      path: p,
      name: p.split('/').filter(Boolean).pop() ?? p,
      exists: true,
      parent: null,
      git: null,
      sessionCount: 0,
    }));

  const top = [...workspaces.filter((w) => w.parent === null), ...discovered];
  // Rows are keyed by path: a folder tracked under two spellings shares an id.
  const labels = buildRepoLabels(top.map((w) => ({ id: w.path, name: w.name, path: w.path })));
  const row = (entry: WorkspaceEntry, label: string, children: WorkspaceRow[] = []) => ({
    entry,
    label,
    live: isLive(entry.path, entry.sessionCount),
    discovered: !listed.has(entry.path),
    children,
  });

  return liveFirst(
    top.map((entry) =>
      row(
        entry,
        labels[entry.path] ?? entry.name,
        liveFirst(
          workspaces
            .filter((w) => w.parent === entry.path)
            .map((child) => row(child, branchLabel(child))),
        ),
      ),
    ),
  );
}

/** Whether any listed folder other than the active one has a pending alert. */
export function hasAlertElsewhere(
  workspaces: WorkspaceEntry[],
  orphanSessions: Record<string, OrphanSession[]>,
  alertedPaths: ReadonlySet<string>,
  activePath: string | null,
): boolean {
  if (alertedPaths.size === 0) return false;
  const paths = [...workspaces.map((w) => w.path), ...Object.keys(orphanSessions)];
  return paths.some((p) => p !== activePath && alertedPaths.has(p));
}
