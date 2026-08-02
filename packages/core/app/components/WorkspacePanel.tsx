'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import styles from './WorkspacePanel.module.css';
import TopBar, { topBarActionStyle } from './TopBar';
import { useResizeDrag, type DragInfo } from './ResizeHandle';
import { filterWorkspacePanelData, hasActiveWorkspacePath } from './workspaceFilter';
import { buildRepoLabels } from './repoLabels';

interface RepoInfo {
  id: string;
  name: string;
  remoteUrl: string;
  path: string;
}

interface WorktreeInfo {
  id: string;
  repoId: string;
  branch: string;
  path: string;
  name: string;
  sessionCount: number;
  isMain?: boolean;
}

interface OrphanSession {
  name: string;
  created: string;
}

interface Props {
  repos: RepoInfo[];
  worktreesByRepo: Record<string, WorktreeInfo[]>;
  orphanSessions: Record<string, OrphanSession[]>;
  activeWorktreeId: string | null;
  activePath: string | null;
  alertedPaths: Set<string>;
  activeOnly: boolean;
  onSelectWorktree: (wt: WorktreeInfo) => void;
  onCreateWorktree: (repoId: string) => void;
  onDeleteWorktree: (wt: WorktreeInfo) => void;
  onRenameBranch: (wtId: string, newName: string) => void;
  onCloneRepo: (url: string, destination: string) => Promise<Response>;
  onAddLocalRepo: (path: string) => void;
  /** `label` is the rendered row name — the destructive confirm shows it,
   *  since the id is a path digest that matches nothing on screen. */
  onDeleteRepo: (repoId: string, label: string) => void;
  onRemoveDir: (dir: string) => void;
  onSelectDirectory: (cwd: string) => void;
  onToggleActiveOnly: () => void;
  onRefresh: () => void;
  onGoHome: () => void;
  onCollapse: () => void;
}

// Sidebar is always rendered as an overlay — width controlled by parent

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}
  </svg>
);

export default function WorkspacePanel({
  repos,
  worktreesByRepo,
  orphanSessions,
  activeWorktreeId,
  activePath,
  alertedPaths,
  activeOnly,
  onSelectWorktree,
  onCreateWorktree,
  onDeleteWorktree,
  onRenameBranch,
  onCloneRepo,
  onAddLocalRepo,
  onDeleteRepo,
  onRemoveDir,
  onSelectDirectory,
  onToggleActiveOnly,
  onRefresh,
  onGoHome,
  onCollapse,
}: Props) {
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set(repos.map((r) => r.id)));
  const [renamingWtId, setRenamingWtId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [addMode, setAddMode] = useState<null | 'clone' | 'clone-dest' | 'browse'>(null);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState('/');
  const [browseDirs, setBrowseDirs] = useState<string[]>([]);
  const [browseIsRepo, setBrowseIsRepo] = useState(false);
  const [dividerPercent, setDividerPercent] = useState(50);

  const sidebarRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Row labels disambiguate same-named checkouts; ids are unique but not
  // readable. See buildRepoLabels.
  const repoLabels = useMemo(() => buildRepoLabels(repos), [repos]);

  // Expand newly added repos
  useEffect(() => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      for (const r of repos) next.add(r.id);
      return next;
    });
  }, [repos]);

  const handleDividerDrag = useCallback(({ y }: DragInfo) => {
    const el = sidebarRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const headerH = 36;
    const dividerH = 24;
    const topPanelHeight = y - rect.top - headerH - dividerH / 2;
    setDividerPercent(Math.min(85, Math.max(15, (topPanelHeight / rect.height) * 100)));
  }, []);

  const dividerDrag = useResizeDrag({ axis: 'y', onDrag: handleDividerDrag });

  // --- Worktree helpers ---
  const toggleRepo = (id: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleDoubleClick = (wt: WorktreeInfo) => {
    setRenamingWtId(wt.id);
    setRenameValue(wt.branch);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const commitRename = useCallback(() => {
    if (renamingWtId && renameValue.trim()) {
      onRenameBranch(renamingWtId, renameValue.trim());
    }
    setRenamingWtId(null);
  }, [renamingWtId, renameValue, onRenameBranch]);

  // --- Clone / Browse ---
  const fetchBrowse = useCallback(async (dirPath: string) => {
    const query = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
    const res = await fetch(`/api/browse${query}`);
    if (res.ok) {
      const data = await res.json();
      setBrowsePath(data.path);
      setBrowseDirs(data.dirs);
      setBrowseIsRepo(data.isGitRepo);
    }
  }, []);

  const handleClonePickDest = () => {
    if (!cloneUrl.trim()) return;
    setAddMode('clone-dest');
    setCloneError(null);
    fetchBrowse('');
  };

  const handleCloneConfirm = async () => {
    if (!cloneUrl.trim()) return;
    setCloning(true);
    setCloneError(null);
    try {
      const slug = cloneUrl.trim().match(/\/([^/]+?)(\.git)?$/)?.[1] || 'repo';
      const dest = browsePath + '/' + slug;
      const res = await onCloneRepo(cloneUrl.trim(), dest);
      if (!res.ok) {
        const data = await res.json();
        setCloneError(data.error || 'Clone failed');
      } else {
        setCloneUrl('');
        setAddMode(null);
      }
    } catch {
      setCloneError('Clone failed');
    }
    setCloning(false);
  };

  const handleBrowseSelect = async () => {
    setCloning(true);
    await onAddLocalRepo(browsePath);
    setCloning(false);
    setAddMode(null);
    setBrowsePath('/');
  };

  const hasAlert = (wsPath: string) => alertedPaths.has(wsPath);
  const { orderedDirs, visibleRepos } = filterWorkspacePanelData({
    repos,
    worktreesByRepo,
    orphanSessions,
    alertedPaths,
    activeOnly,
  });

  return (
    <aside ref={sidebarRef} className={styles.panel} aria-label="Workspaces">
      {/* Header */}
      <TopBar
        left={
          <button style={topBarActionStyle} onClick={onCollapse} title="Close workspaces">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        }
        right={
          <>
            <button
              style={{
                ...topBarActionStyle,
                color: activeOnly ? 'var(--warning, #d29922)' : undefined,
              }}
              onClick={onToggleActiveOnly}
              title={activeOnly ? 'Show all workspaces' : 'Show active sessions only'}
              aria-label={activeOnly ? 'Show all workspaces' : 'Show active sessions only'}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h10" />
                <path d="M3 12h18" />
                <path d="M3 18h10" />
                <circle cx="18" cy="6" r="2.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button style={topBarActionStyle} onClick={onRefresh} title="Refresh">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </>
        }
      >
        <span className={styles.title} onClick={onGoHome} title="Deselect">
          WORKSPACES
        </span>
      </TopBar>

      {/* WORKTREES panel */}
      <div className={styles.panel} style={{ height: `${dividerPercent}%` }}>
        <div className={styles.panelScroll}>
          {visibleRepos.length === 0 && (
            <div className={styles.empty}>
              {activeOnly ? 'No active workspaces.' : 'No repos yet.'}
            </div>
          )}
          {visibleRepos.map(({ repo, worktrees }) => {
            const expanded = expandedRepos.has(repo.id);
            return (
              <div key={repo.id} className={styles.group}>
                <div className={styles.groupHeader}>
                  <button
                    className={styles.expandBtn}
                    onClick={() => toggleRepo(repo.id)}
                    title={expanded ? 'Collapse' : 'Expand'}
                  >
                    <Chevron open={expanded} />
                  </button>
                  <span
                    className={styles.groupName}
                    onClick={() => toggleRepo(repo.id)}
                    title={repo.path}
                  >
                    {repoLabels[repo.id] ?? repo.name}
                  </span>
                  <div className={styles.groupActions}>
                    <button
                      className={styles.actionBtn}
                      onClick={() => onCreateWorktree(repo.id)}
                      title="New worktree"
                    >
                      +
                    </button>
                    <button
                      className={styles.actionBtn}
                      onClick={() => onDeleteRepo(repo.id, repoLabels[repo.id] ?? repo.name)}
                      title="Remove repo"
                    >
                      ×
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className={styles.itemList}>
                    {worktrees.map((wt) => (
                      <div
                        key={wt.id}
                        className={`${styles.item} ${wt.path === activePath ? styles.active : ''}`}
                        onClick={() => onSelectWorktree(wt)}
                        onDoubleClick={wt.isMain ? undefined : () => handleDoubleClick(wt)}
                        title={wt.isMain ? wt.branch : `${wt.branch} — double-click to rename`}
                      >
                        {renamingWtId === wt.id ? (
                          <input
                            ref={renameInputRef}
                            className={styles.renameInput}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename();
                              if (e.key === 'Escape') setRenamingWtId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                          <>
                            {hasAlert(wt.path) ? (
                              <span className={styles.alertDot} />
                            ) : (
                              wt.sessionCount > 0 && <span className={styles.sessionDot} />
                            )}
                            <span className={styles.itemName}>{wt.branch}</span>
                            {!wt.isMain && (
                              <button
                                className={`${styles.actionBtn} ${styles.deleteBtn}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDeleteWorktree(wt);
                                }}
                                title="Remove worktree"
                              >
                                ×
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Divider */}
      <div className={styles.divider} {...dividerDrag}>
        <span className={styles.dividerLabel}>OTHERS</span>
      </div>

      {/* OTHERS panel */}
      <div className={styles.panel} style={{ flex: 1 }}>
        <div className={styles.panelScroll}>
          {orderedDirs.map(([dir]) => {
            const isHome = dir.match(/^\/home\/[^/]+$/) || dir.match(/^\/Users\/[^/]+$/);
            const shortDir = isHome
              ? '$HOME'
              : dir.replace(/^\/home\/[^/]+/, '$HOME').replace(/^\/Users\/[^/]+/, '$HOME');
            const isActive = activePath === dir;
            return (
              <div
                key={dir}
                className={`${styles.dirItem} ${isActive ? styles.active : ''}`}
                onClick={() => onSelectDirectory(dir)}
                title={dir}
              >
                {hasAlert(dir) ? (
                  <span className={styles.alertDot} />
                ) : (
                  hasActiveWorkspacePath(dir, 0, orphanSessions, new Set()) && (
                    <span className={styles.sessionDot} />
                  )
                )}
                <span className={styles.itemName}>{shortDir}</span>
                {!isHome && (
                  <button
                    className={`${styles.actionBtn} ${styles.deleteBtn}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveDir(dir);
                    }}
                    title="Remove directory"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        {cloneError && <div className={styles.errorMsg}>{cloneError}</div>}

        {addMode === null && (
          <div className={styles.addMenu}>
            <button
              className={styles.addBtn}
              onClick={() => {
                setAddMode('clone');
                setCloneError(null);
              }}
              title="Clone a repository from a URL"
            >
              Clone
            </button>
            <button
              className={styles.addBtn}
              onClick={() => {
                setAddMode('browse');
                fetchBrowse('');
              }}
              title="Add a repo or directory"
            >
              Add
            </button>
          </div>
        )}

        {addMode === 'clone' && (
          <div className={styles.dialog}>
            <input
              className={styles.dialogInput}
              placeholder="git@github.com:user/repo.git"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleClonePickDest();
                if (e.key === 'Escape') setAddMode(null);
              }}
              autoFocus
              disabled={cloning}
            />
            <div className={styles.dialogActions}>
              <button
                className={styles.primaryBtn}
                onClick={handleClonePickDest}
                disabled={!cloneUrl.trim()}
              >
                Next: Pick Folder
              </button>
              <button className={styles.secondaryBtn} onClick={() => setAddMode(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {addMode === 'clone-dest' && (
          <div className={styles.dialog}>
            <div className={styles.browsePath}>Clone to: {browsePath}/</div>
            <div className={styles.browseList}>
              <div
                className={styles.browseItem}
                onClick={() => fetchBrowse(browsePath.replace(/\/[^/]+$/, '') || '/')}
              >
                ..
              </div>
              {browseDirs.map((d) => (
                <div
                  key={d}
                  className={styles.browseItem}
                  onClick={() => fetchBrowse(`${browsePath}/${d}`)}
                >
                  {d}
                </div>
              ))}
            </div>
            <div className={styles.dialogActions}>
              <button className={styles.primaryBtn} onClick={handleCloneConfirm} disabled={cloning}>
                {cloning ? 'Cloning...' : 'Clone Here'}
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() => setAddMode('clone')}
                disabled={cloning}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {addMode === 'browse' && (
          <div className={styles.dialog}>
            <div className={styles.browsePath}>{browsePath}</div>
            <div className={styles.browseList}>
              {browsePath !== '/' && (
                <div
                  className={styles.browseItem}
                  onClick={() => fetchBrowse(browsePath.replace(/\/[^/]+$/, '') || '/')}
                >
                  ..
                </div>
              )}
              {browseDirs.map((d) => (
                <div
                  key={d}
                  className={styles.browseItem}
                  onClick={() => fetchBrowse(`${browsePath}/${d}`)}
                >
                  {d}
                </div>
              ))}
            </div>
            <div className={styles.dialogActions}>
              <button className={styles.primaryBtn} onClick={handleBrowseSelect} disabled={cloning}>
                {cloning ? 'Adding...' : browseIsRepo ? 'Add Repo' : 'Add Dir'}
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() => setAddMode(null)}
                disabled={cloning}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
