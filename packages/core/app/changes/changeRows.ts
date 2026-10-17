/**
 * Pure view-model helpers for the Changes panel and status bar (no React, no
 * fetch) — shapes mirror lib/git.ts's /api/git/* responses.
 */

import { gitStatusColor } from '../files/fileTabs';

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface Change {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
}

export interface GitChanges {
  root: string;
  staged: Change[];
  unstaged: Change[];
  untracked: Change[];
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

export interface ChangeRow {
  /** Unique within the panel. */
  key: string;
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  /** In the Staged group (vs Changes). */
  staged: boolean;
  name: string;
  /** Parent dir, '' at the root. */
  dir: string;
}

function row(c: Change, staged: boolean): ChangeRow {
  const slash = c.path.lastIndexOf('/');
  return {
    key: `${staged ? 's' : 'w'}:${c.path}`,
    path: c.path,
    ...(c.oldPath !== undefined ? { oldPath: c.oldPath } : {}),
    status: c.status,
    staged,
    name: c.path.slice(slash + 1),
    dir: slash === -1 ? '' : c.path.slice(0, slash),
  };
}

const byPath = (a: ChangeRow, b: ChangeRow) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** "Staged" and "Changes" groups; untracked files fold into Changes (as U). */
export function changeGroups(c: GitChanges): { staged: ChangeRow[]; changes: ChangeRow[] } {
  return {
    staged: c.staged.map((x) => row(x, true)).sort(byPath),
    changes: [...c.unstaged, ...c.untracked].map((x) => row(x, false)).sort(byPath),
  };
}

/** Distinct changed files (a file staged and modified again counts once). */
export function changeCount(c: GitChanges | null): number {
  if (!c) return 0;
  return new Set([...c.staged, ...c.unstaged, ...c.untracked].map((x) => x.path)).size;
}

/** The letter shown on a row: untracked reads as U (VS Code), conflicts as !. */
export function statusLetter(s: ChangeStatus): string {
  if (s === '?') return 'U';
  if (s === 'U') return '!';
  return s;
}

/** Same palette as the file tree's git colours. */
export function statusColor(s: ChangeStatus): string | undefined {
  if (s === '?') return gitStatusColor('??');
  if (s === 'U') return 'var(--danger, #f85149)';
  if (s === 'C') return gitStatusColor('A.');
  return gitStatusColor(`${s}.`);
}

export function statusTitle(r: ChangeRow): string {
  const label: Record<ChangeStatus, string> = {
    M: 'Modified',
    A: 'Added',
    D: 'Deleted',
    R: 'Renamed',
    C: 'Copied',
    U: 'Conflict',
    '?': 'Untracked',
  };
  return r.oldPath ? `${label[r.status]} from ${r.oldPath}` : label[r.status];
}

/** Paths a stage/unstage of this row must name (both sides of a rename). */
export function rowPaths(r: ChangeRow): string[] {
  return r.oldPath !== undefined ? [r.path, r.oldPath] : [r.path];
}

/** Case-insensitive substring filter over branch names. */
export function filterBranches<T extends { name: string }>(branches: ReadonlyArray<T>, query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : [...branches];
}
