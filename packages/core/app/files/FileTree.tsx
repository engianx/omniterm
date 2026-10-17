'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BranchIcon, FileIcon, FolderIcon } from '../components/icons';
import ConfirmDialog from '../components/ConfirmDialog';
import { isPreviewable } from '../../lib/previewable';
import type { HostApi, PluginIntegration } from '../types';
import { buildDirStatus, changedSets, gitStatusColor, matchesGlob } from './fileTabs';
import {
  FILE_PATH_DRAG_MIME,
  breadcrumbSegments,
  diffModeFor,
  invalidEntryName,
  joinRel,
  treeMenuEntries,
  type Crumb,
  type TreeMenuAction,
} from './fileOps';

export interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

/** A file operation's outcome: an error message, or null on success. */
type OpResult = Promise<string | null>;

interface Props {
  /** Workspace root (absolute). `null` → "Select a workspace" placeholder. */
  rootPath: string | null;
  tree: DirEntry[];
  expandedDirs: Record<string, DirEntry[]>;
  gitStatus: Record<string, string>;
  changesOnly: boolean;
  /** Workspace-relative path of the active tab's file (highlighted). */
  activeRelPath: string | null;
  /** Scroll to and flash this row once it renders; a new `seq` repeats it. */
  reveal?: { path: string; seq: number } | null;
  fileHandlers?: PluginIntegration['fileHandlers'];
  fileIndicatorPaths?: ReadonlySet<string>;
  host: HostApi;
  /** "Open to the side" is offered (the split view is available). */
  canSplit: boolean;
  /** Rows can be dragged (onto a terminal, to paste their path). */
  draggable: boolean;
  onToggleDir: (relPath: string) => void;
  /** Expand a folder if it is collapsed (before creating inside it). */
  onExpandDir: (relPath: string) => void;
  /** Opens (or focuses) a file. */
  onOpenFile: (relPath: string) => void;
  onOpenPreview: (relPath: string) => void;
  onOpenToSide: (relPath: string) => void;
  onOpenDiff: (relPath: string, mode: 'worktree' | 'staged') => void;
  onOpenTerminal: (absPath: string) => void;
  onOpenWorkspace: (absPath: string) => void;
  onCreate: (parentRel: string, name: string, kind: 'file' | 'folder') => OpResult;
  onRename: (relPath: string, newName: string) => OpResult;
  onDelete: (relPath: string) => OpResult;
  /** Open tabs with unsaved edits at or under a path (delete warns about them). */
  dirtyCountUnder: (relPath: string) => number;
  onToggleChangesOnly: () => void;
  onRefresh: () => void;
}

interface MenuItem {
  label: string;
  onSelect: () => void;
  separatorBefore?: boolean;
}

type Editing =
  | { mode: 'rename'; relPath: string }
  | { mode: 'create'; parent: string; kind: 'file' | 'folder' };

const MENU_LABELS: Record<TreeMenuAction, string> = {
  open: 'Open',
  'open-side': 'Open to the side',
  'open-diff': 'Open changes',
  'open-preview': 'Open preview',
  'open-terminal': 'Open terminal here',
  'open-workspace': 'Open as workspace',
  'new-file': 'New file…',
  'new-folder': 'New folder…',
  rename: 'Rename…',
  delete: 'Delete',
  'copy-path': 'Copy path',
  'copy-relative-path': 'Copy relative path',
};

/** Ancestors of the root shown before collapsing the rest into "…". */
const VISIBLE_ANCESTORS = 2;

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Menu position for a click point, kept on screen. */
function menuPosition(x: number, y: number, itemCount: number) {
  const width = 200;
  const height = itemCount * 30 + 12;
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
    y: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
  };
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.1s' }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const RefreshIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const MoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);

/**
 * Inline name field for rename / new file / new folder. Enter (or blur with a
 * changed name) commits; Escape cancels. A failed commit keeps the field open
 * with the error under it.
 */
function NameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => OpResult;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the stem, not the extension (VS Code-style rename).
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const commit = async () => {
    if (busyRef.current) return;
    const name = value.trim();
    if (name === initial) {
      onCancel();
      return;
    }
    const invalid = invalidEntryName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    busyRef.current = true;
    const err = await onCommit(name);
    busyRef.current = false;
    if (err) setError(err);
  };

  return (
    <span style={S.inputWrap}>
      <input
        ref={inputRef}
        className="ot-tree-input"
        data-invalid={error ? 'true' : undefined}
        value={value}
        spellCheck={false}
        aria-label="Name"
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => {
          // Leaving an empty or untouched field abandons it; a typed name commits.
          if (!value.trim() || value.trim() === initial) onCancel();
          else void commit();
        }}
        onClick={(e) => e.stopPropagation()}
      />
      {error && <span style={S.inputError}>{error}</span>}
    </span>
  );
}

/**
 * The workspace file tree, rendered as the left sidebar's "Files" section.
 * A view over the files store (useFilesIntegration); local state is only the
 * context menu, inline name editing, the delete prompt and long-press
 * bookkeeping.
 */
export default function FileTree({
  rootPath,
  tree,
  expandedDirs,
  gitStatus,
  changesOnly,
  activeRelPath,
  reveal,
  fileHandlers,
  fileIndicatorPaths,
  host,
  canSplit,
  draggable,
  onToggleDir,
  onExpandDir,
  onOpenFile,
  onOpenPreview,
  onOpenToSide,
  onOpenDiff,
  onOpenTerminal,
  onOpenWorkspace,
  onCreate,
  onRename,
  onDelete,
  dirtyCountUnder,
  onToggleChangesOnly,
  onRefresh,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; target?: string } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Folders load asynchronously, so retry on each tree change until the
  // revealed row exists, then handle that reveal once.
  const revealedSeqRef = useRef(0);
  useEffect(() => {
    if (!reveal || reveal.seq === revealedSeqRef.current) return;
    const row = treeRef.current?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(reveal.path)}"]`);
    if (!row) return;
    revealedSeqRef.current = reveal.seq;
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('ot-tree-flash');
    void row.offsetWidth; // restart the animation on a repeat reveal
    row.classList.add('ot-tree-flash');
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ relPath: string; isDir: boolean } | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  // A workspace switch abandons any half-done edit or prompt.
  useEffect(() => {
    setMenu(null);
    setEditing(null);
    setPendingDelete(null);
    setOpError(null);
  }, [rootPath]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  // Close the menu on outside press / Escape / resize / scroll / focus into an iframe.
  useEffect(() => {
    if (!menu) return;
    const onDocDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // Memoized on gitStatus so editor keystrokes (dirty-state re-renders) don't
  // rebuild these.
  const { files: changedPaths, dirs: changedDirPaths } = useMemo(
    () => changedSets(gitStatus),
    [gitStatus],
  );
  const dirStatusColors = useMemo(() => buildDirStatus(gitStatus), [gitStatus]);
  const crumbs = useMemo(() => (rootPath ? breadcrumbSegments(rootPath) : []), [rootPath]);

  if (!rootPath) {
    return (
      <div style={S.container}>
        <div style={S.empty}>Select a workspace</div>
      </div>
    );
  }

  const absOf = (relPath: string) => (relPath ? `${rootPath}/${relPath}` : rootPath);

  const startCreate = (parent: string, kind: 'file' | 'folder') => {
    if (parent) onExpandDir(parent);
    setEditing({ mode: 'create', parent, kind });
  };

  const runAction = (action: TreeMenuAction, relPath: string, isDir: boolean) => {
    const abs = absOf(relPath);
    switch (action) {
      case 'open':
        return onOpenFile(relPath);
      case 'open-side':
        return onOpenToSide(relPath);
      case 'open-diff': {
        const mode = diffModeFor(gitStatus[relPath]);
        if (mode) onOpenDiff(relPath, mode);
        return;
      }
      case 'open-preview':
        return onOpenPreview(relPath);
      case 'open-terminal':
        return onOpenTerminal(abs);
      case 'open-workspace':
        return onOpenWorkspace(abs);
      case 'new-file':
        return startCreate(relPath, 'file');
      case 'new-folder':
        return startCreate(relPath, 'folder');
      case 'rename':
        return setEditing({ mode: 'rename', relPath });
      case 'delete':
        return setPendingDelete({ relPath, isDir });
      case 'copy-path':
        return void copyToClipboard(abs);
      case 'copy-relative-path':
        return void copyToClipboard(relPath);
    }
  };

  const openEntryMenu = (clientX: number, clientY: number, relPath: string, isDir: boolean) => {
    setOpError(null);
    const abs = absOf(relPath);
    const items: MenuItem[] = treeMenuEntries({
      isDir,
      isRoot: relPath === '',
      canSplit,
      hasChanges: !isDir && diffModeFor(gitStatus[relPath]) !== null,
      previewable: !isDir && isPreviewable(relPath),
    }).map(({ action, separatorBefore }) => ({
      label: MENU_LABELS[action],
      separatorBefore,
      onSelect: () => runAction(action, relPath, isDir),
    }));
    if (!isDir) {
      const name = abs.split('/').pop() ?? '';
      const handlers = (fileHandlers ?? []).filter((h) => matchesGlob(h.pattern, name));
      handlers.forEach((h, i) =>
        items.push({
          label: h.label,
          separatorBefore: i === 0,
          onSelect: () => void h.onSelect(abs, host),
        }),
      );
    }
    setMenu({ ...menuPosition(clientX, clientY, items.length), items, target: relPath });
  };

  const openCrumbMenu = (clientX: number, clientY: number, targets: Crumb[]) => {
    const home = crumbs[0]?.label === '~' ? crumbs[0].path : null;
    const display = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
    const items: MenuItem[] = targets.map((c) => ({
      label: targets.length === 1 ? 'Open as workspace' : `Open ${display(c.path)}`,
      onSelect: () => onOpenWorkspace(c.path),
    }));
    setMenu({ ...menuPosition(clientX, clientY, items.length), items });
  };

  const rowProps = (relPath: string, isDir: boolean) => ({
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openEntryMenu(e.clientX, e.clientY, relPath, isDir);
    },
    onTouchStart: (e: React.TouchEvent) => {
      longPressFiredRef.current = false;
      const t = e.touches[0];
      if (!t) return;
      const cx = t.clientX;
      const cy = t.clientY;
      cancelLongPress();
      longPressTimerRef.current = setTimeout(() => {
        longPressFiredRef.current = true;
        openEntryMenu(cx, cy, relPath, isDir);
      }, 500);
    },
    onTouchMove: cancelLongPress,
    onTouchEnd: cancelLongPress,
    onTouchCancel: cancelLongPress,
  });

  const createRow = (parent: string, depth: number) =>
    editing?.mode === 'create' && editing.parent === parent ? (
      <div style={{ ...S.entry, paddingLeft: `${4 + depth * 12}px`, cursor: 'default' }}>
        <span style={S.chevron} />
        <span style={{ ...S.entryIcon, color: 'var(--text-muted)' }}>
          {editing.kind === 'folder' ? <FolderIcon size={14} /> : <FileIcon size={14} />}
        </span>
        <NameInput
          initial=""
          onCommit={async (name) => {
            const err = await onCreate(parent, name, editing.kind);
            if (!err) setEditing(null);
            return err;
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    ) : null;

  const renderEntries = (entries: DirEntry[], parentPath: string, depth: number): React.ReactNode =>
    entries
      .filter((entry) => {
        if (!changesOnly) return true;
        const fullPath = joinRel(parentPath, entry.name);
        return entry.type === 'directory' ? changedDirPaths.has(fullPath) : changedPaths.has(fullPath);
      })
      .map((entry) => {
        const fullPath = joinRel(parentPath, entry.name);
        const isExpanded = expandedDirs[fullPath] !== undefined;
        const isDir = entry.type === 'directory';
        const isSelected = !isDir && activeRelPath === fullPath;
        const statusColor = isDir ? dirStatusColors[fullPath] : gitStatusColor(gitStatus[fullPath]);
        const hasIndicator = !isDir && fileIndicatorPaths?.has(absOf(fullPath));
        const renaming = editing?.mode === 'rename' && editing.relPath === fullPath;

        return (
          <div key={fullPath}>
            <div
              role="treeitem"
              className="ot-tree-row"
              aria-expanded={isDir ? isExpanded : undefined}
              aria-selected={isSelected}
              data-menu-open={menu?.target === fullPath ? 'true' : undefined}
              data-rel={fullPath}
              title={fullPath}
              draggable={draggable && !renaming}
              style={{
                ...S.entry,
                paddingLeft: `${4 + depth * 12}px`,
                background: isSelected ? 'var(--accent)' : undefined,
                color: isSelected ? 'var(--text-bright)' : statusColor || 'var(--text)',
              }}
              onClick={() => {
                if (longPressFiredRef.current) {
                  longPressFiredRef.current = false;
                  return;
                }
                if (renaming) return;
                if (isDir) onToggleDir(fullPath);
                else onOpenFile(fullPath);
              }}
              onDragStart={(e) => {
                const abs = absOf(fullPath);
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData(FILE_PATH_DRAG_MIME, abs);
                e.dataTransfer.setData('text/plain', abs);
              }}
              {...rowProps(fullPath, isDir)}
            >
              <span style={S.chevron}>{isDir && <Chevron open={isExpanded} />}</span>
              <span
                style={{
                  ...S.entryIcon,
                  color: isSelected ? 'inherit' : statusColor || 'var(--text-muted)',
                }}
              >
                {isDir ? <FolderIcon size={14} /> : <FileIcon size={14} />}
              </span>
              {renaming ? (
                <NameInput
                  initial={entry.name}
                  onCommit={async (name) => {
                    const err = await onRename(fullPath, name);
                    if (!err) setEditing(null);
                    return err;
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <span style={S.entryName}>{entry.name}</span>
              )}
              {hasIndicator && <span title="Open in plugin tab" style={S.indicator} />}
              {!renaming && (
                <button
                  type="button"
                  className="ot-tree-more"
                  title="More actions"
                  aria-label={`More actions for ${entry.name}`}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    openEntryMenu(r.left, r.bottom + 2, fullPath, isDir);
                  }}
                >
                  <MoreIcon />
                </button>
              )}
            </div>
            {isDir && isExpanded && expandedDirs[fullPath] && (
              <div role="group">
                {createRow(fullPath, depth + 1)}
                {renderEntries(expandedDirs[fullPath], fullPath, depth + 1)}
              </div>
            )}
          </div>
        );
      });

  // Breadcrumb: `~ › git › app`, the root last. Ancestors above the root open
  // as workspaces; the root opens its own folder menu (new file, terminal…).
  const ancestors = crumbs.slice(0, -1);
  const rootCrumb = crumbs[crumbs.length - 1];
  const hidden = ancestors.slice(0, Math.max(0, ancestors.length - VISIBLE_ANCESTORS));
  const shown = ancestors.slice(hidden.length);

  const pendingName = pendingDelete?.relPath.split('/').pop() ?? '';
  const pendingDirty = pendingDelete ? dirtyCountUnder(pendingDelete.relPath) : 0;

  return (
    <div style={S.container}>
      <div style={S.header}>
        <nav style={S.crumbs} aria-label="Workspace path" title={rootPath}>
          {hidden.length > 0 && (
            <>
              <button
                type="button"
                className="ot-crumb"
                title="Open a parent folder as workspace"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  openCrumbMenu(r.left, r.bottom + 2, hidden);
                }}
              >
                …
              </button>
              <span style={S.crumbSep}>›</span>
            </>
          )}
          {shown.map((c) => (
            <span key={c.path} style={S.crumbItem}>
              <button
                type="button"
                className="ot-crumb"
                title={`Open ${c.path} as workspace`}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  openCrumbMenu(r.left, r.bottom + 2, [c]);
                }}
              >
                {c.label}
              </button>
              <span style={S.crumbSep}>›</span>
            </span>
          ))}
          <button
            type="button"
            className="ot-crumb ot-crumb-root"
            title={rootPath}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openEntryMenu(r.left, r.bottom + 2, '', true);
            }}
          >
            {rootCrumb?.label}
          </button>
          {changesOnly && <span style={S.crumbNote}>· changes</span>}
        </nav>
        <button
          type="button"
          style={{ ...S.headerBtn, color: changesOnly ? 'var(--warning)' : undefined }}
          onClick={onToggleChangesOnly}
          title={changesOnly ? 'Show all files' : 'Show changes only'}
          aria-label={changesOnly ? 'Show all files' : 'Show changes only'}
          aria-pressed={changesOnly}
        >
          <BranchIcon size={14} />
        </button>
        <button
          type="button"
          style={S.headerBtn}
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh files"
        >
          <RefreshIcon />
        </button>
      </div>
      {opError && (
        <div style={S.opError} role="alert" onClick={() => setOpError(null)} title="Dismiss">
          {opError}
        </div>
      )}
      <div
        ref={treeRef}
        style={S.treeContent}
        role="tree"
        // Right-click on empty space: the workspace root's menu.
        onContextMenu={(e) => {
          e.preventDefault();
          openEntryMenu(e.clientX, e.clientY, '', true);
        }}
      >
        {createRow('', 0)}
        {tree.length > 0
          ? renderEntries(tree, '', 0)
          : editing?.mode !== 'create' && (
              <div style={S.empty}>{changesOnly ? 'No changes' : 'No files'}</div>
            )}
      </div>

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ ...S.menu, top: menu.y, left: menu.x }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {menu.items.map((item) => (
              <div key={item.label}>
                {item.separatorBefore && <div style={S.menuSeparator} />}
                <button
                  type="button"
                  role="menuitem"
                  className="ot-menu-item"
                  onClick={() => {
                    setMenu(null);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}

      {pendingDelete &&
        createPortal(
          <ConfirmDialog
            title={pendingDelete.isDir ? 'Delete Folder' : 'Delete File'}
            message={
              <>
                Delete &quot;{pendingName}&quot;
                {pendingDelete.isDir ? ' and everything in it' : ''}? This cannot be undone.
                {pendingDirty > 0 && (
                  <div style={{ color: 'var(--danger)', marginTop: '8px' }}>
                    Unsaved changes in {pendingDirty} open file{pendingDirty === 1 ? '' : 's'} will be
                    lost.
                  </div>
                )}
              </>
            }
            buttons={[
              {
                label: 'Delete',
                danger: true,
                action: async () => {
                  const err = await onDelete(pendingDelete.relPath);
                  if (err) setOpError(err);
                },
              },
              { label: 'Cancel', action: () => {} },
            ]}
            onClose={() => setPendingDelete(null)}
          />,
          document.body,
        )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    height: 'var(--tab-height)',
    padding: '0 4px 0 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  crumbs: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: '12px',
  },
  crumbItem: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    flexShrink: 1,
  },
  crumbSep: {
    color: 'var(--text-muted)',
    opacity: 0.6,
    padding: '0 1px',
    flexShrink: 0,
  },
  crumbNote: {
    color: 'var(--text-muted)',
    paddingLeft: 4,
    flexShrink: 0,
  },
  headerBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    border: 'none',
    borderRadius: 4,
    background: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  opError: {
    padding: '4px 12px',
    fontSize: '12px',
    color: 'var(--danger)',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  treeContent: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '4px 0',
  },
  entry: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    height: 26,
    paddingRight: 4,
    cursor: 'pointer',
    fontSize: '13px',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  chevron: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    flexShrink: 0,
    color: 'var(--text-muted)',
  },
  entryIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  entryName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
    flex: 1,
  },
  inputWrap: {
    position: 'relative',
    flex: 1,
    minWidth: 0,
    display: 'flex',
  },
  inputError: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 2,
    padding: '2px 6px',
    fontSize: '11px',
    whiteSpace: 'normal',
    color: 'var(--text-bright)',
    background: 'var(--danger)',
    borderRadius: '0 0 3px 3px',
  },
  indicator: {
    display: 'inline-block',
    width: 6,
    height: 6,
    marginLeft: 6,
    borderRadius: '50%',
    background: 'var(--link)',
    flexShrink: 0,
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: 16,
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
  // Matches the tab strip's context menu (TabBar).
  menu: {
    position: 'fixed',
    minWidth: '160px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    padding: '4px 0',
    zIndex: 1000,
  },
  menuSeparator: {
    height: '1px',
    margin: '4px 0',
    background: 'var(--border)',
  },
};
