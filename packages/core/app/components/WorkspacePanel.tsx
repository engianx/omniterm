'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './WorkspacePanel.module.css';
import OpenPicker from './OpenPicker';
import { buildWorkspaceRows, type WorkspaceEntry, type WorkspaceRow } from './workspaceList';
import { PlusIcon } from './icons';

interface OrphanSession {
  name: string;
  created: string;
}

interface Props {
  workspaces: WorkspaceEntry[];
  orphanSessions: Record<string, OrphanSession[]>;
  activePath: string | null;
  alertedPaths: ReadonlySet<string>;
  onSelect: (path: string) => void;
  /** Track (if needed) and switch; resolves to an error message or null. */
  onOpenPath: (path: string) => Promise<string | null>;
  onClone: (url: string, destination: string) => Promise<string | null>;
  onCreateWorktree: (entry: WorkspaceEntry) => void;
  onDeleteWorktree: (entry: WorkspaceEntry) => void;
  onRenameBranch: (entry: WorkspaceEntry, newName: string) => void;
  /** `label` is the rendered row name, for the confirm prompt. */
  onUntrack: (entry: WorkspaceEntry, label: string) => void;
}

/**
 * Actions for the sidebar header while the Workspaces section is showing:
 * deselect (home) and refresh. They live in the Sidebar's header row rather
 * than a second header inside the panel.
 */
export function WorkspaceHeaderActions({
  onRefresh,
  onGoHome,
}: {
  onRefresh: () => void;
  onGoHome: () => void;
}) {
  return (
    <>
      <button
        className={styles.headerBtn}
        onClick={onGoHome}
        title="Deselect workspace"
        aria-label="Deselect workspace"
      >
        <svg {...iconProps}>
          <path d="M3 10.5L12 3l9 7.5" />
          <path d="M5 9v11h14V9" />
        </svg>
      </button>
      <button className={styles.headerBtn} onClick={onRefresh} title="Refresh" aria-label="Refresh">
        <svg {...iconProps}>
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
    </>
  );
}

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg {...iconProps} width={12} height={12}>
    {open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}
  </svg>
);

const MoreIcon = () => (
  <svg {...iconProps}>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </svg>
);

interface MenuAction {
  label: string;
  danger?: boolean;
  run: () => void;
}

/** A linked worktree, auto-listed or tracked on its own. */
const isLinkedWorktree = (e: WorkspaceEntry) => e.git !== null && !e.git.isMainWorktree;

export default function WorkspacePanel({
  workspaces,
  orphanSessions,
  activePath,
  alertedPaths,
  onSelect,
  onOpenPath,
  onClone,
  onCreateWorktree,
  onDeleteWorktree,
  onRenameBranch,
  onUntrack,
}: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<{ entry: WorkspaceEntry; value: string } | null>(null);
  const [menu, setMenu] = useState<{ row: WorkspaceRow; x: number; y: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const rows = useMemo(
    () => buildWorkspaceRows({ workspaces, orphanSessions, alertedPaths }),
    [workspaces, orphanSessions, alertedPaths],
  );

  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menu]);

  const toggle = (p: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(p)) next.add(p);
      return next;
    });

  const startRename = (entry: WorkspaceEntry) => setRenaming({ entry, value: entry.git?.branch ?? '' });

  const commitRename = useCallback(() => {
    if (renaming && renaming.value.trim() && renaming.value.trim() !== renaming.entry.git?.branch) {
      onRenameBranch(renaming.entry, renaming.value.trim());
    }
    setRenaming(null);
  }, [renaming, onRenameBranch]);

  const actionsFor = ({ entry, label, discovered }: WorkspaceRow): MenuAction[] => {
    if (discovered) return [{ label: 'Add to workspaces', run: () => void onOpenPath(entry.path) }];
    const actions: MenuAction[] = [];
    if (entry.git?.isMainWorktree) {
      actions.push({ label: 'New worktree', run: () => onCreateWorktree(entry) });
    }
    if (isLinkedWorktree(entry) && entry.git?.branch !== 'HEAD') {
      actions.push({ label: 'Rename branch', run: () => startRename(entry) });
    }
    if (isLinkedWorktree(entry)) {
      actions.push({ label: 'Delete worktree…', danger: true, run: () => onDeleteWorktree(entry) });
    }
    if (entry.parent === null) {
      actions.push({ label: 'Remove from workspaces', run: () => onUntrack(entry, label) });
    }
    return actions;
  };

  const openMenu = (row: WorkspaceRow, x: number, y: number) => {
    if (actionsFor(row).length > 0) setMenu({ row, x, y });
  };

  const renderRow = (row: WorkspaceRow, depth: number) => {
    const { entry } = row;
    const hasChildren = row.children.length > 0;
    const expanded = !collapsed.has(entry.path);
    const isRenaming = renaming?.entry.path === entry.path;
    // Top-level repos show their branch, subtly; nested worktrees are already
    // labelled by branch.
    const branch = depth === 0 && entry.git && entry.git.branch !== 'HEAD' ? entry.git.branch : null;
    const title = [
      entry.path,
      entry.exists ? null : 'Folder not found',
      row.discovered ? 'Not tracked: has terminal sessions' : null,
    ]
      .filter(Boolean)
      .join('\n');
    return (
      <div key={entry.path}>
        <div
          className={[
            styles.row,
            entry.path === activePath ? styles.active : '',
            entry.exists ? '' : styles.missing,
            row.discovered ? styles.discovered : '',
          ].join(' ')}
          style={{ paddingLeft: 4 + depth * 16 }}
          onClick={() => onSelect(entry.path)}
          onDoubleClick={isLinkedWorktree(entry) ? () => startRename(entry) : undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(row, e.clientX, e.clientY);
          }}
          title={title}
        >
          {hasChildren ? (
            <button
              className={styles.chevron}
              onClick={(e) => {
                e.stopPropagation();
                toggle(entry.path);
              }}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              aria-expanded={expanded}
            >
              <Chevron open={expanded} />
            </button>
          ) : (
            <span className={styles.chevronSpacer} />
          )}
          <span className={styles.dotSlot}>
            {alertedPaths.has(entry.path) ? (
              <span className={styles.alertDot} />
            ) : (
              row.live && <span className={styles.sessionDot} />
            )}
          </span>
          {isRenaming ? (
            <input
              className={styles.renameInput}
              value={renaming.value}
              onChange={(e) => setRenaming({ entry, value: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.target.select()}
              aria-label="Branch name"
              autoFocus
            />
          ) : (
            <>
              <span className={styles.name}>{row.label}</span>
              {branch && <span className={styles.branch}>{branch}</span>}
              <button
                className={styles.moreBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  openMenu(row, r.right, r.bottom);
                }}
                title="Workspace actions"
                aria-label={`Actions for ${row.label}`}
                style={actionsFor(row).length === 0 ? { visibility: 'hidden' } : undefined}
              >
                <MoreIcon />
              </button>
            </>
          )}
        </div>
        {hasChildren && expanded && row.children.map((child) => renderRow(child, depth + 1))}
      </div>
    );
  };

  return (
    <aside className={styles.panel} aria-label="Workspaces">
      <div className={styles.scroll}>
        {rows.length === 0 && <div className={styles.empty}>No workspaces yet.</div>}
        {rows.map((row) => renderRow(row, 0))}
      </div>

      <div className={styles.footer}>
        <button className={styles.openBtn} onClick={() => setPickerOpen(true)}>
          <PlusIcon size={14} />
          Open…
        </button>
      </div>

      {menu && (
        <>
          <div
            className={styles.menuCatcher}
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className={styles.menu}
            role="menu"
            style={{
              // Keep the menu on screen; it opens leftward from the anchor.
              left: Math.max(8, Math.min(menu.x - 180, window.innerWidth - 188)),
              top: Math.min(menu.y, window.innerHeight - 160),
            }}
          >
            {actionsFor(menu.row).map((a) => (
              <button
                key={a.label}
                role="menuitem"
                className={`${styles.menuItem} ${a.danger ? styles.danger : ''}`}
                onClick={() => {
                  setMenu(null);
                  a.run();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}

      {pickerOpen && (
        <OpenPicker
          workspaces={workspaces}
          onOpen={onOpenPath}
          onClone={onClone}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </aside>
  );
}
