/**
 * Pure helpers behind the Files tree's file operations: path arithmetic, name
 * validation, the context-menu model and the root breadcrumb.
 *
 * No React, no fetch — unit-tested in fileOps.test.ts.
 */

/** MIME type a dragged tree row carries (its absolute path), e.g. for a
 *  terminal pane to paste it. */
export const FILE_PATH_DRAG_MIME = 'application/x-omniterm-path';

/** `p` is `root` or below it (string paths, no normalisation). */
export function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** `abs` relative to `root` ('' for the root itself), or null when outside. */
export function relativeTo(root: string, abs: string): string | null {
  if (abs === root) return '';
  return isInside(abs, root) ? abs.slice(root.length).replace(/^\/+/, '') : null;
}

export function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

/** Why `name` can't be a new file/folder name, or null when it can. */
export function invalidEntryName(name: string): string | null {
  if (!name.trim()) return 'Name is required';
  if (name.includes('/')) return 'Name cannot contain "/"';
  if (name === '.' || name === '..') return 'Name cannot be "." or ".."';
  if (name.includes('\0')) return 'Name cannot contain a null byte';
  return null;
}

/**
 * Where `p` ends up after `from` is renamed to `to` (all workspace-relative):
 * `from` itself or anything under it moves; anything else → null (unaffected).
 */
export function remapPath(p: string, from: string, to: string): string | null {
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return null;
}

/**
 * Which diff a file's porcelain status pair (`XY`) opens: its unstaged changes
 * when the worktree side changed (or it is untracked), else its staged ones;
 * null when it has no change.
 */
export function diffModeFor(xy: string | undefined): 'worktree' | 'staged' | null {
  if (!xy || xy.length < 2) return null;
  if (xy === '??' || xy[1] !== ' ') return 'worktree';
  return xy[0] !== ' ' ? 'staged' : null;
}

// ----- context menu -----

export type TreeMenuAction =
  | 'open'
  | 'open-side'
  | 'open-diff'
  | 'open-preview'
  | 'open-terminal'
  | 'open-workspace'
  | 'new-file'
  | 'new-folder'
  | 'rename'
  | 'delete'
  | 'copy-path'
  | 'copy-relative-path';

export interface TreeMenuEntry {
  action: TreeMenuAction;
  separatorBefore?: boolean;
}

/**
 * The tree's context-menu entries for one row (or the workspace root, which
 * can't be renamed, deleted or re-opened as a workspace). Plugin file handlers
 * are appended by the caller.
 */
export function treeMenuEntries(target: {
  isDir: boolean;
  isRoot: boolean;
  /** The split view is available (desktop, wide enough). */
  canSplit: boolean;
  hasChanges: boolean;
  previewable: boolean;
}): TreeMenuEntry[] {
  const entries: TreeMenuEntry[] = [];
  const sep = (action: TreeMenuAction) => entries.push({ action, separatorBefore: entries.length > 0 });
  if (target.isDir) {
    entries.push({ action: 'open-terminal' });
    if (!target.isRoot) entries.push({ action: 'open-workspace' });
    sep('new-file');
    entries.push({ action: 'new-folder' });
  } else {
    entries.push({ action: 'open' });
    if (target.canSplit) entries.push({ action: 'open-side' });
    if (target.hasChanges) entries.push({ action: 'open-diff' });
    if (target.previewable) entries.push({ action: 'open-preview' });
  }
  if (!target.isRoot) {
    sep('rename');
    entries.push({ action: 'delete' });
  }
  sep('copy-path');
  if (!target.isRoot) entries.push({ action: 'copy-relative-path' });
  return entries;
}

// ----- breadcrumb -----

export interface Crumb {
  label: string;
  path: string;
}

/**
 * The root path as crumbs, `/` first. A leading `/home/<user>` or
 * `/Users/<user>` collapses into one `~` crumb (the home directory itself).
 */
export function breadcrumbSegments(root: string): Crumb[] {
  const parts = root.split('/').filter(Boolean);
  const crumbs: Crumb[] = [];
  let start = 0;
  if (parts.length >= 2 && (parts[0] === 'home' || parts[0] === 'Users')) {
    crumbs.push({ label: '~', path: `/${parts[0]}/${parts[1]}` });
    start = 2;
  } else {
    crumbs.push({ label: '/', path: '/' });
  }
  for (let i = start; i < parts.length; i++) {
    crumbs.push({ label: parts[i], path: `/${parts.slice(0, i + 1).join('/')}` });
  }
  return crumbs;
}
