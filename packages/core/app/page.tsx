'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import WorkspacePanel from './components/WorkspacePanel';
import TabBar from './components/TabBar';
import FilePanel from './components/FilePanel';
import SettingsPanel from './components/SettingsPanel';
import ConfirmDialog from './components/ConfirmDialog';
import { ResizeHandle, type DragInfo } from './components/ResizeHandle';
import type { HostApi, MainContentContext, Tab } from './types';
import { shouldResetWorkspaceTabs } from './workspaceSelection';
import { worktreeDeleteUrl, worktreeStatusUrl, probeIsDirty } from './worktreeDelete';
import { initClientTelemetry, track } from './telemetryClient';
import { MOBILE_MAX_WIDTH } from './breakpoints';
import {
  resolveWorkspacePanelState,
  updateWorkspacePanelState,
  type WorkspacePanelStates,
} from './workspacePanelState';
import type {
  WorkspacesPanelMode,
  FilesPanelMode,
  BrowserPanelMode,
  BrowserInspectorPosition,
} from '../lib/settings';

export type { HostApi, Tab, PluginIntegration, MainContentContext } from './types';
export { composeIntegrations } from './types';
export type {
  WorkspacesPanelMode,
  FilesPanelMode,
  BrowserPanelMode,
  BrowserInspectorPosition,
} from '../lib/settings';

// =========================================================================
// Host state — owned by `useHomeState`. Consumers thread this object into
// their plugin integrations AND into `<Home state={...} />` so both sides
// see the same instance of the state.
// =========================================================================

interface WorktreeInfo {
  id: string;
  repoId: string;
  branch: string;
  path: string;
  name: string;
  sessionCount: number;
  isMain?: boolean;
}

interface RepoInfo {
  id: string;
  name: string;
  remoteUrl: string;
  path: string;
  addedAt: string;
}

/**
 * Public surface of the host's state — the part integrations read/write.
 * Internal-only fields used by Home's own UI live on the same object but
 * aren't part of the documented contract for plugin authors.
 */
export interface HomeState {
  // Plugin-facing
  activePath: string | null;
  activeTabId: string | null;
  tabs: Tab[];
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
  hostApi: HostApi;
  isMobile: boolean;
  filesPanelOpen: boolean;
  browserPanelOpen: boolean;
  setBrowserPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  settingsHydrated: boolean;
  refreshWorkspaces: () => Promise<void>;

  // Host-internal (consumed by Home itself; integrations should ignore)
  repos: RepoInfo[];
  worktreesByRepo: Record<string, WorktreeInfo[]>;
  activeWorktree: WorktreeInfo | null;
  workspacesOpen: boolean;
  workspacesPanelMode: WorkspacesPanelMode;
  workspacesPanelDockedOpen: boolean;
  filesPanelMode: FilesPanelMode;
  filesPanelDockedOpen: boolean;
  browserPanelMode: BrowserPanelMode;
  browserInspectorPosition: BrowserInspectorPosition;
  workspaceFilterActiveOnly: boolean;
  filesPanelMounted: boolean;
  filesPanelWidth: number;
  workspacesWidth: number;
  settingsOpen: boolean;
  settingsPanelWidth: number;
  isResizing: boolean;
  pendingDeleteRepo: { id: string; label: string } | null;
  pendingDeleteWorktree: { wt: WorktreeInfo; dirty: boolean } | null;
  worktreeDeleteError: string | null;
  setWorkspacesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspacesPanelMode: React.Dispatch<React.SetStateAction<WorkspacesPanelMode>>;
  setWorkspacesPanelDockedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setFilesPanelMode: React.Dispatch<React.SetStateAction<FilesPanelMode>>;
  setFilesPanelDockedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setBrowserPanelMode: React.Dispatch<React.SetStateAction<BrowserPanelMode>>;
  setBrowserInspectorPosition: React.Dispatch<React.SetStateAction<BrowserInspectorPosition>>;
  setWorkspaceFilterActiveOnly: React.Dispatch<React.SetStateAction<boolean>>;
  setFilesPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setFilesPanelMounted: React.Dispatch<React.SetStateAction<boolean>>;
  setFilesPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  setWorkspacesWidth: React.Dispatch<React.SetStateAction<number>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingDeleteRepo: React.Dispatch<
    React.SetStateAction<{ id: string; label: string } | null>
  >;
  setPendingDeleteWorktree: React.Dispatch<
    React.SetStateAction<{ wt: WorktreeInfo; dirty: boolean } | null>
  >;
  setWorktreeDeleteError: React.Dispatch<React.SetStateAction<string | null>>;
  handleSelectWorktree: (wt: WorktreeInfo | null) => void;
  handleSelectDirectory: (cwd: string) => void;
  handleCreateWorktree: (repoId: string) => Promise<void>;
  handleDeleteWorktree: (wt: WorktreeInfo) => Promise<void>;
  handleRenameBranch: (wtId: string, newName: string) => Promise<void>;
  handleCloneRepo: (url: string, destination: string) => Promise<Response>;
  handleAddLocalRepo: (localPath: string) => Promise<void>;
  handleDeleteRepo: (repoId: string, label: string) => void;
  confirmDeleteRepo: () => Promise<void>;
  confirmDeleteWorktree: () => Promise<void>;
  handleRemoveDir: (dir: string) => Promise<void>;
}

/**
 * Options for `useHomeState`. Currently just a hook for plugins to
 * participate in the host's workspace refresh — the testbox composer
 * passes the aggregated `composeIntegrations(...).onWorkspaceRefresh`
 * here so that every refresh path (panel ⟳ button + internal callers
 * like delete-repo) refreshes plugin-owned state too.
 */
export interface UseHomeStateOptions {
  /** Runs after repos+worktrees are fetched, on every `refreshWorkspaces()`.
   *  Identity is snapshot via a ref each render, so callers don't need to
   *  ref-stabilize themselves; pass any inline closure. */
  onRefreshWorkspaces?: () => void | Promise<void>;
}

export function useHomeState(options?: UseHomeStateOptions): HomeState {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [worktreesByRepo, setWorktreesByRepo] = useState<Record<string, WorktreeInfo[]>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeWorktree, setActiveWorktree] = useState<WorktreeInfo | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [workspacesPanelMode, setWorkspacesPanelMode] = useState<WorkspacesPanelMode>('docked');
  const [workspacesPanelDockedOpen, setWorkspacesPanelDockedOpen] = useState(true);
  const [filesPanelMode, setFilesPanelMode] = useState<FilesPanelMode>('docked');
  const [browserPanelMode, setBrowserPanelMode] = useState<BrowserPanelMode>('docked');
  const [browserInspectorPosition, setBrowserInspectorPosition] =
    useState<BrowserInspectorPosition>('hidden');
  const [workspaceFilterActiveOnly, setWorkspaceFilterActiveOnly] = useState(false);
  const [workspacePanelStates, setWorkspacePanelStates] = useState<WorkspacePanelStates>({});
  const [filesPanelMounted, setFilesPanelMounted] = useState(false);
  const [filesPanelWidth, setFilesPanelWidth] = useState(900);
  const [workspacesWidth, setWorkspacesWidth] = useState(280);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(420);
  const [isResizing, setIsResizing] = useState(false);
  const [pendingDeleteRepo, setPendingDeleteRepo] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [pendingDeleteWorktree, setPendingDeleteWorktree] = useState<{
    wt: WorktreeInfo;
    dirty: boolean;
  } | null>(null);
  const [worktreeDeleteError, setWorktreeDeleteError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_MAX_WIDTH);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const { browserOpen: browserPanelOpen, filesOpen: filesPanelOpen } = useMemo(
    () => resolveWorkspacePanelState(workspacePanelStates, activePath, isMobile),
    [workspacePanelStates, activePath, isMobile],
  );
  const setBrowserPanelOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (update) => {
      setWorkspacePanelStates((states) =>
        updateWorkspacePanelState(states, activePath, 'browserOpen', update, isMobile),
      );
    },
    [activePath, isMobile],
  );
  const setFilesPanelOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (update) => {
      setWorkspacePanelStates((states) =>
        updateWorkspacePanelState(states, activePath, 'filesOpen', update, isMobile),
      );
    },
    [activePath, isMobile],
  );
  // File-pane visibility is one conceptual setting across docked, overlay, and
  // mobile presentations. Keep the existing HomeState aliases so integrations
  // and callers do not need to understand the presentation mode.
  const filesPanelDockedOpen = filesPanelOpen;
  const setFilesPanelDockedOpen = setFilesPanelOpen;

  const fetchRepos = useCallback(async () => {
    const res = await fetch('/api/repos');
    if (res.ok) {
      const data: RepoInfo[] = await res.json();
      setRepos(data);
      return data;
    }
    return [];
  }, []);

  const fetchAllWorktrees = useCallback(async (repoList: RepoInfo[]) => {
    // Fetch concurrently — serial awaits made refresh latency scale with repo count.
    const entries = await Promise.all(
      repoList.map(async (repo) => {
        const res = await fetch(`/api/repos/${repo.id}/worktrees`);
        return res.ok ? ([repo.id, await res.json()] as const) : null;
      }),
    );
    const byRepo: Record<string, WorktreeInfo[]> = {};
    for (const entry of entries) {
      if (entry) byRepo[entry[0]] = entry[1];
    }
    setWorktreesByRepo(byRepo);
  }, []);

  // Snapshot via ref so refreshWorkspaces' identity stays stable even if
  // the consumer passes a fresh closure each render (composeIntegrations
  // does, since its aggregated handler list changes shape over time).
  const onRefreshWorkspacesRef = useRef(options?.onRefreshWorkspaces);
  onRefreshWorkspacesRef.current = options?.onRefreshWorkspaces;

  const refreshWorkspaces = useCallback(async () => {
    const repoList = await fetchRepos();
    await Promise.all([fetchAllWorktrees(repoList), onRefreshWorkspacesRef.current?.()]);
  }, [fetchRepos, fetchAllWorktrees]);

  // Initial hydration from /api/settings + repos/worktrees.
  useEffect(() => {
    refreshWorkspaces();
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        if (data.activePath) setActivePath(data.activePath);
        if (data.activeTabId) setActiveTabId(data.activeTabId);
        if (data.workspacePanelState && typeof data.workspacePanelState === 'object') {
          setWorkspacePanelStates(data.workspacePanelState);
        }
        if (data.workspacesPanelMode === 'overlay' || data.workspacesPanelMode === 'docked') {
          setWorkspacesPanelMode(data.workspacesPanelMode);
        }
        if (typeof data.workspacesPanelDockedOpen === 'boolean') {
          setWorkspacesPanelDockedOpen(data.workspacesPanelDockedOpen);
        }
        if (typeof data.workspaceFilterActiveOnly === 'boolean') {
          setWorkspaceFilterActiveOnly(data.workspaceFilterActiveOnly);
        }
        if (data.filesPanelMode === 'overlay' || data.filesPanelMode === 'docked') {
          setFilesPanelMode(data.filesPanelMode);
        }
        if (data.browserPanelMode === 'overlay' || data.browserPanelMode === 'docked') {
          setBrowserPanelMode(data.browserPanelMode);
        }
        if (
          data.browserInspectorPosition === 'hidden' ||
          data.browserInspectorPosition === 'right' ||
          data.browserInspectorPosition === 'bottom'
        ) {
          setBrowserInspectorPosition(data.browserInspectorPosition);
        }
      })
      .catch(() => {})
      .finally(() => setSettingsHydrated(true));
  }, [refreshWorkspaces]);

  // Front-end telemetry: init from the server gate, then record app load time.
  useEffect(() => {
    const loadMs = Math.round(performance.now());
    void initClientTelemetry().then(() => track('app_loaded', { load_ms: loadMs }));
  }, []);

  // Persist host-level settings only.
  useEffect(() => {
    if (!settingsHydrated) return;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activePath,
        activeTabId,
        workspacePanelState: workspacePanelStates,
        workspacesPanelMode,
        workspacesPanelDockedOpen,
        workspaceFilterActiveOnly,
        filesPanelMode,
        browserPanelMode,
        browserInspectorPosition,
      }),
    });
  }, [
    settingsHydrated,
    activePath,
    activeTabId,
    workspacePanelStates,
    workspacesPanelMode,
    workspacesPanelDockedOpen,
    workspaceFilterActiveOnly,
    filesPanelMode,
    browserPanelMode,
    browserInspectorPosition,
  ]);

  const hostApi: HostApi = useMemo(
    () => ({
      openTab(tab, options) {
        setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
        if (options?.activate !== false) setActiveTabId(tab.id);
      },
    }),
    [],
  );

  const handleSelectWorktree = useCallback(
    (wt: WorktreeInfo | null) => {
      const nextPath = wt?.path ?? null;
      if (!shouldResetWorkspaceTabs(activePath, nextPath)) {
        setActiveWorktree((prev) => (prev?.id === wt?.id ? prev : wt));
        return;
      }
      setActivePath(nextPath);
      setActiveWorktree(wt);
      setTabs([]);
      setActiveTabId(null);
      track('workspace_switched', { kind: 'worktree' });
    },
    [activePath],
  );

  const handleSelectDirectory = useCallback(
    (cwd: string) => {
      if (!shouldResetWorkspaceTabs(activePath, cwd)) {
        setActiveWorktree((prev) => (prev === null ? prev : null));
        setWorkspacesOpen(false);
        return;
      }
      setActiveWorktree(null);
      setActivePath(cwd);
      setTabs([]);
      setActiveTabId(null);
      setWorkspacesOpen(false);
      track('workspace_switched', { kind: 'directory' });
    },
    [activePath],
  );

  const handleCreateWorktree = useCallback(
    async (repoId: string) => {
      const res = await fetch(`/api/repos/${repoId}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newBranch: true }),
      });
      if (res.ok) {
        const wt: WorktreeInfo = await res.json();
        await refreshWorkspaces();
        handleSelectWorktree({ ...wt, sessionCount: 0 });
      }
    },
    [refreshWorkspaces, handleSelectWorktree],
  );

  const handleDeleteWorktree = useCallback(async (wt: WorktreeInfo) => {
    // Probe uncommitted-changes state so the confirm dialog can warn before we
    // discard work. probeIsDirty fails safe to dirty (see its doc) so a failed
    // or garbled probe still warns and forces rather than silently omitting.
    let dirty = true;
    try {
      const res = await fetch(worktreeStatusUrl(wt.id));
      dirty = probeIsDirty(res.ok, res.ok ? await res.json() : null);
    } catch {
      dirty = true;
    }
    setPendingDeleteWorktree({ wt, dirty });
  }, []);

  const confirmDeleteWorktree = useCallback(async () => {
    const pending = pendingDeleteWorktree;
    setPendingDeleteWorktree(null);
    if (!pending) return;
    const { wt, dirty } = pending;
    try {
      const res = await fetch(worktreeDeleteUrl(wt.id, dirty), { method: 'DELETE' });
      if (!res.ok) {
        // The user confirmed a destructive action and it didn't happen (the
        // worktree went dirty between probe and confirm → 409, a locked worktree,
        // or a 5xx). Surface the server's reason instead of silently leaving a
        // blank panel, and don't clobber the still-live active session for a
        // worktree that wasn't actually removed.
        const reason = await res
          .json()
          .then((b) => (b && typeof b.error === 'string' ? (b.error as string) : null))
          .catch(() => null);
        setWorktreeDeleteError(reason ?? `Delete failed (${res.status}).`);
        await refreshWorkspaces();
        return;
      }
      if (activeWorktree?.id === wt.id) {
        setActiveWorktree(null);
        setActivePath(null);
        setTabs([]);
        setActiveTabId(null);
      }
      await refreshWorkspaces();
    } catch {
      // Network error reaching the server — the user confirmed but nothing
      // happened; surface it rather than leaving a blank panel (mirrors the
      // probe's fail-safe catch above).
      setWorktreeDeleteError('Delete failed — could not reach the server.');
      await refreshWorkspaces();
    }
  }, [pendingDeleteWorktree, activeWorktree, refreshWorkspaces]);

  const handleRenameBranch = useCallback(
    async (wtId: string, newName: string) => {
      await fetch(`/api/worktrees/${wtId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      });
      await refreshWorkspaces();
    },
    [refreshWorkspaces],
  );

  const handleCloneRepo = useCallback(
    async (url: string, destination: string) => {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, destination }),
      });
      await refreshWorkspaces();
      return res;
    },
    [refreshWorkspaces],
  );

  const handleAddLocalRepo = useCallback(
    async (localPath: string) => {
      await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath }),
      });
      await refreshWorkspaces();
    },
    [refreshWorkspaces],
  );

  // `label` is the row's rendered name (see buildRepoLabels) — the repo id is a
  // path digest and would name nothing the user can see in a destructive prompt.
  const handleDeleteRepo = useCallback((repoId: string, label: string) => {
    setPendingDeleteRepo({ id: repoId, label });
  }, []);

  const confirmDeleteRepo = useCallback(async () => {
    const repoId = pendingDeleteRepo?.id;
    setPendingDeleteRepo(null);
    if (!repoId) return;
    await fetch(`/api/repos/${repoId}`, { method: 'DELETE' });
    if (activeWorktree?.repoId === repoId) {
      setActiveWorktree(null);
      setActivePath(null);
      setTabs([]);
      setActiveTabId(null);
    }
    await refreshWorkspaces();
  }, [pendingDeleteRepo, activeWorktree, refreshWorkspaces]);

  const handleRemoveDir = useCallback(
    async (dir: string) => {
      const settings = await fetch('/api/settings').then((r) => r.json());
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackedDirs: (settings.trackedDirs || []).filter((d: string) => d !== dir),
        }),
      });
      if (activePath === dir) {
        setActivePath(null);
        setTabs([]);
        setActiveTabId(null);
      }
      await refreshWorkspaces();
    },
    [activePath, refreshWorkspaces],
  );

  return {
    activePath,
    activeTabId,
    tabs,
    setTabs,
    setActiveTabId,
    hostApi,
    isMobile,
    filesPanelOpen,
    browserPanelOpen,
    setBrowserPanelOpen,
    settingsHydrated,
    refreshWorkspaces,
    repos,
    worktreesByRepo,
    activeWorktree,
    workspacesOpen,
    workspacesPanelMode,
    workspacesPanelDockedOpen,
    filesPanelMode,
    filesPanelDockedOpen,
    browserPanelMode,
    browserInspectorPosition,
    workspaceFilterActiveOnly,
    filesPanelMounted,
    filesPanelWidth,
    workspacesWidth,
    settingsOpen,
    settingsPanelWidth,
    isResizing,
    pendingDeleteRepo,
    pendingDeleteWorktree,
    worktreeDeleteError,
    setWorkspacesOpen,
    setWorkspacesPanelMode,
    setWorkspacesPanelDockedOpen,
    setFilesPanelMode,
    setFilesPanelDockedOpen,
    setBrowserPanelMode,
    setBrowserInspectorPosition,
    setWorkspaceFilterActiveOnly,
    setFilesPanelOpen,
    setFilesPanelMounted,
    setFilesPanelWidth,
    setWorkspacesWidth,
    setSettingsOpen,
    setSettingsPanelWidth,
    setIsResizing,
    setPendingDeleteRepo,
    setPendingDeleteWorktree,
    setWorktreeDeleteError,
    handleSelectWorktree,
    handleSelectDirectory,
    handleCreateWorktree,
    handleDeleteWorktree,
    handleRenameBranch,
    handleCloneRepo,
    handleAddLocalRepo,
    handleDeleteRepo,
    confirmDeleteRepo,
    confirmDeleteWorktree,
    handleRemoveDir,
  };
}

// =========================================================================
// Home — pure renderer. State must be threaded in via the `state` prop.
// =========================================================================

const HamburgerIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

const FilesIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

const SettingsIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const BrowserIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const EMPTY_PATH_SET: ReadonlySet<string> = new Set();
const EMPTY_TAB_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_ORPHANS: Record<string, { name: string; created: string }[]> = {};

export interface HomeProps {
  /** Required: the host state instance, obtained from `useHomeState()`. */
  state: HomeState;
  /**
   * Render slot for the active tab's component-mode content. Plugin
   * integrations contribute via `composeIntegrations(...)`.
   */
  mainContent?: (ctx: MainContentContext) => ReactNode;
  /** Render slot for the iframe overlay. */
  iframeTabsLayer?: (state: { activeTabId: string | null }) => ReactNode;
  /** File-panel right-click menu entries. */
  fileHandlers?: ReadonlyArray<{
    pattern: string;
    label: string;
    onSelect: (absPath: string, api: HostApi) => void | Promise<void>;
  }>;
  fileIndicatorPaths?: ReadonlySet<string>;
  ephemeralTabTypes?: ReadonlySet<string>;
  onCloseTab?: (tab: Tab) => void;
  /** Plugin-contributed tab types for the [+] dropdown. */
  tabTypeChoices?: ReadonlyArray<{
    type: string;
    label: string;
    onCreate: (api: HostApi) => void | Promise<void>;
    autoOpenOnLanding?: boolean;
  }>;
  alertedPaths?: ReadonlySet<string>;
  alertedTabIds?: ReadonlySet<string>;
  workspaceOrphans?: Record<string, { name: string; created: string }[]>;
  /** AND of plugins' `workspaceReady` signals; drives the landing-tab auto-spawn. */
  workspaceReady?: boolean;
}

export default function Home(props: HomeProps) {
  const {
    state: host,
    mainContent,
    iframeTabsLayer,
    fileHandlers,
    fileIndicatorPaths,
    ephemeralTabTypes: _ephemeralTabTypes,
    onCloseTab,
    tabTypeChoices,
    alertedPaths,
    alertedTabIds,
    workspaceOrphans,
    workspaceReady,
  } = props;

  const indicatorPaths = fileIndicatorPaths ?? EMPTY_PATH_SET;
  // FilePanel wants a mutable Set; the prop is ReadonlySet. Memoized so the
  // reference stays stable when indicatorPaths is unchanged — avoids spurious
  // FilePanel re-renders if it ever adopts React.memo.
  const fileIndicatorPathsSet = useMemo<Set<string>>(
    () =>
      indicatorPaths instanceof Set ? (indicatorPaths as Set<string>) : new Set(indicatorPaths),
    [indicatorPaths],
  );
  const effectiveAlertedPaths = alertedPaths ?? EMPTY_PATH_SET;
  const effectiveAlertedTabIds = alertedTabIds ?? EMPTY_TAB_ID_SET;
  const effectiveOrphans = workspaceOrphans ?? EMPTY_ORPHANS;

  const fileHandlersRef = useRef(fileHandlers);
  fileHandlersRef.current = fileHandlers;

  const workspacesOverlayRef = useRef<HTMLDivElement>(null);
  const workspacesDockedRef = useRef<HTMLDivElement>(null);
  const setWorkspacesWidth = host.setWorkspacesWidth;
  const handleWorkspacesOverlayDrag = useCallback(
    ({ x }: DragInfo) => {
      const overlay = workspacesOverlayRef.current;
      if (!overlay) return;
      const left = overlay.getBoundingClientRect().left;
      const max = window.innerWidth - left - 200;
      setWorkspacesWidth(Math.min(max, Math.max(200, x - left)));
    },
    [setWorkspacesWidth],
  );
  const handleWorkspacesDockedDrag = useCallback(
    ({ x }: DragInfo) => {
      const docked = workspacesDockedRef.current;
      if (!docked) return;
      const left = docked.getBoundingClientRect().left;
      const max = window.innerWidth - left - 200;
      setWorkspacesWidth(Math.min(max, Math.max(200, x - left)));
    },
    [setWorkspacesWidth],
  );

  // Narrow viewports always use overlay regardless of the user's preference.
  const effectiveWorkspacesMode: WorkspacesPanelMode = host.isMobile
    ? 'overlay'
    : host.workspacesPanelMode;
  const isDocked = effectiveWorkspacesMode === 'docked';
  const effectiveFilesMode: FilesPanelMode = host.isMobile ? 'overlay' : host.filesPanelMode;
  const isFilesDocked = effectiveFilesMode === 'docked';
  // In docked mode the panel is permanently mounted alongside main, so
  // visibility is gated by filesPanelDockedOpen instead of filesPanelOpen.
  const filesPanelVisible = isFilesDocked ? host.filesPanelDockedOpen : host.filesPanelOpen;

  const wrappedFileHandlers = useMemo(() => {
    if (!fileHandlers || fileHandlers.length === 0) return undefined;
    return fileHandlers.map((h) => ({
      pattern: h.pattern,
      label: h.label,
      onSelect: (absPath: string) => h.onSelect(absPath, host.hostApi),
    }));
  }, [fileHandlers, host.hostApi]);

  const createMenu = useMemo(() => {
    return (tabTypeChoices ?? []).map((c) => ({
      label: c.label,
      onSelect: () => {
        void c.onCreate(host.hostApi);
      },
    }));
  }, [tabTypeChoices, host.hostApi]);

  // One landing attempt per workspace activation; stays consumed after user closes tabs.
  const landingAttemptRef = useRef<{ path: string | null; consumed: boolean }>({
    path: null,
    consumed: false,
  });

  // Landing-tab sequence: tabTypeChoices[0] focused, then any later
  // choice with autoOpenOnLanding=true, silent.
  const landingChoices = useMemo(() => {
    if (!tabTypeChoices || tabTypeChoices.length === 0) return [];
    const [first, ...rest] = tabTypeChoices;
    return [first, ...rest.filter((c) => c.autoOpenOnLanding)];
  }, [tabTypeChoices]);
  useEffect(() => {
    const path = host.activePath;
    if (!path) return;
    if (!host.settingsHydrated) return;
    if (workspaceReady === false) return;
    if (landingChoices.length === 0) return;
    if (landingAttemptRef.current.path !== path) {
      landingAttemptRef.current = { path, consumed: false };
    }
    if (landingAttemptRef.current.consumed) return;
    landingAttemptRef.current.consumed = true;
    if (host.tabs.length > 0) return;

    const silentApi: HostApi = {
      openTab: (tab) => host.hostApi.openTab(tab, { activate: false }),
    };

    (async () => {
      const [first, ...rest] = landingChoices;
      try {
        await first.onCreate(host.hostApi);
      } catch (err) {
        // Focused tab failed — drop consumption so re-entry retries the whole
        // spawn. Skip background tabs; the landing is already broken.
        if (landingAttemptRef.current.path === path) {
          landingAttemptRef.current.consumed = false;
        }
        console.warn(
          '[home] focused landing tab spawn failed:',
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      // Background tab failures stay scoped: log and continue. Resetting
      // consumption here would re-spawn the already-open focused tab.
      for (const choice of rest) {
        try {
          await choice.onCreate(silentApi);
        } catch (err) {
          console.warn(
            '[home] background landing tab spawn failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    })();
  }, [
    host.activePath,
    host.settingsHydrated,
    host.tabs.length,
    host.hostApi,
    workspaceReady,
    landingChoices,
  ]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = host.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      onCloseTab?.(tab);
      track('tab_closed', { type: tab.type });
      host.setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (tabId === host.activeTabId) {
          host.setActiveTabId(next.length > 0 ? next[0].id : null);
        }
        return next;
      });
    },
    [host, onCloseTab],
  );

  const handleSelectWorktreeAndClose = useCallback(
    (wt: WorktreeInfo) => {
      host.handleSelectWorktree(wt);
      // Docked mode keeps the panel pinned — selecting a worktree shouldn't hide it.
      if (!isDocked) host.setWorkspacesOpen(false);
    },
    [host, isDocked],
  );

  const handleToggleWorkspaces = useCallback(() => {
    if (isDocked) {
      host.setWorkspacesPanelDockedOpen((prev) => !prev);
    } else {
      host.setWorkspacesOpen((v) => !v);
    }
    track('panel_toggled', { panel: 'workspaces' });
  }, [host, isDocked]);

  const handleCollapseWorkspaces = useCallback(() => {
    if (isDocked) {
      host.setWorkspacesPanelDockedOpen(false);
    } else {
      host.setWorkspacesOpen(false);
    }
  }, [host, isDocked]);

  const handleToggleFiles = useCallback(() => {
    if (isFilesDocked) {
      host.setFilesPanelDockedOpen((prev) => !prev);
    } else {
      host.setFilesPanelOpen((prev) => !prev);
      if (!host.filesPanelMounted) host.setFilesPanelMounted(true);
    }
    track('panel_toggled', { panel: 'files' });
  }, [host, isFilesDocked]);

  const handleToggleBrowsers = useCallback(() => {
    host.setBrowserPanelOpen((prev) => !prev);
    track('panel_toggled', { panel: 'browser' });
  }, [host]);

  // When the user switches display mode while a panel is currently visible,
  // carry the visibility state across so the panel does not silently disappear.
  // The two modes use independent visibility flags (workspacesOpen for overlay,
  // workspacesPanelDockedOpen for docked); without this sync, switching from
  // docked-open to overlay would leave both flags inconsistent and the panel
  // hidden until the user toggles it manually.
  const handleWorkspacesPanelModeChange = useCallback(
    (newMode: WorkspacesPanelMode) => {
      if (newMode === 'overlay' && host.workspacesPanelDockedOpen) {
        host.setWorkspacesOpen(true);
      } else if (newMode === 'docked' && host.workspacesOpen) {
        host.setWorkspacesPanelDockedOpen(true);
      }
      host.setWorkspacesPanelMode(newMode);
    },
    [host],
  );

  const handleFilesPanelModeChange = useCallback(
    (newMode: FilesPanelMode) => {
      if (newMode === 'overlay' && host.filesPanelDockedOpen) {
        host.setFilesPanelOpen(true);
        // Overlay path is gated on filesPanelMounted (lazy-mount); ensure it's
        // mounted so the panel actually appears after the mode switch.
        host.setFilesPanelMounted(true);
      } else if (newMode === 'docked' && host.filesPanelOpen) {
        host.setFilesPanelDockedOpen(true);
      }
      host.setFilesPanelMode(newMode);
    },
    [host],
  );

  const workspacePanelElement = (
    <WorkspacePanel
      repos={host.repos}
      worktreesByRepo={host.worktreesByRepo}
      orphanSessions={effectiveOrphans}
      activeWorktreeId={host.activeWorktree?.id || null}
      activePath={host.activePath}
      alertedPaths={
        effectiveAlertedPaths instanceof Set
          ? (effectiveAlertedPaths as Set<string>)
          : new Set(effectiveAlertedPaths)
      }
      activeOnly={host.workspaceFilterActiveOnly}
      onSelectWorktree={handleSelectWorktreeAndClose}
      onCreateWorktree={host.handleCreateWorktree}
      onDeleteWorktree={host.handleDeleteWorktree}
      onRenameBranch={host.handleRenameBranch}
      onCloneRepo={host.handleCloneRepo}
      onAddLocalRepo={host.handleAddLocalRepo}
      onDeleteRepo={host.handleDeleteRepo}
      onRemoveDir={host.handleRemoveDir}
      onSelectDirectory={host.handleSelectDirectory}
      onToggleActiveOnly={() => host.setWorkspaceFilterActiveOnly((prev) => !prev)}
      onRefresh={host.refreshWorkspaces}
      onGoHome={() => {
        host.handleSelectWorktree(null);
        handleCollapseWorkspaces();
      }}
      onCollapse={handleCollapseWorkspaces}
    />
  );

  const hasAlerts = useMemo(() => {
    if (effectiveAlertedPaths.size === 0) return false;
    const workspacePaths: string[] = [];
    for (const wts of Object.values(host.worktreesByRepo)) {
      for (const wt of wts) workspacePaths.push(wt.path);
    }
    for (const dir of Object.keys(effectiveOrphans)) workspacePaths.push(dir);
    return workspacePaths.some((wp) => wp !== host.activePath && effectiveAlertedPaths.has(wp));
  }, [effectiveAlertedPaths, host.worktreesByRepo, effectiveOrphans, host.activePath]);

  // The badge surfaces alerts in workspaces other than the active one, but only
  // when the panel is hidden — once it's visible (overlay open OR docked-expanded),
  // the in-panel item highlight already shows where the alert is.
  const workspacesPanelVisible = isDocked ? host.workspacesPanelDockedOpen : host.workspacesOpen;
  const topBarLeft = (
    <button
      style={{ ...S.tabBarBtn, position: 'relative' as const }}
      onClick={handleToggleWorkspaces}
      title="Workspaces"
    >
      <HamburgerIcon />
      {hasAlerts && !workspacesPanelVisible && <span style={S.alertBadge} />}
    </button>
  );

  const topBarRight = (
    <>
      <button style={S.tabBarBtn} onClick={() => host.setSettingsOpen(true)} title="Settings">
        <SettingsIcon />
      </button>
      <button
        style={S.tabBarBtn}
        onClick={handleToggleBrowsers}
        title={host.browserPanelOpen ? 'Hide browser view' : 'Show browser view'}
      >
        <BrowserIcon />
      </button>
      <button
        style={{
          ...S.tabBarBtn,
          opacity: host.activePath ? 1 : 0.3,
          cursor: host.activePath ? 'pointer' : 'default',
        }}
        onClick={host.activePath ? handleToggleFiles : undefined}
        title={
          host.activePath
            ? filesPanelVisible
              ? 'Close files'
              : 'Open files'
            : 'Select a workspace first'
        }
      >
        <FilesIcon />
      </button>
    </>
  );

  const activeTab = host.tabs.find((t) => t.id === host.activeTabId) ?? null;

  return (
    <div style={S.root}>
      {isDocked && host.workspacesPanelDockedOpen && (
        <div
          ref={workspacesDockedRef}
          style={{ ...S.workspacesDocked, width: `${host.workspacesWidth}px` }}
        >
          {workspacePanelElement}
          <ResizeHandle
            axis="x"
            variant="edge"
            style={{ right: -3 }}
            onDrag={handleWorkspacesDockedDrag}
          />
        </div>
      )}
      <main
        style={{ ...S.center, display: host.isMobile && host.filesPanelOpen ? 'none' : 'flex' }}
      >
        <TabBar
          tabs={host.tabs}
          activeTabId={host.activeTabId}
          alertedTabIds={
            effectiveAlertedTabIds instanceof Set
              ? (effectiveAlertedTabIds as Set<string>)
              : new Set(effectiveAlertedTabIds)
          }
          leftAction={topBarLeft}
          rightAction={topBarRight}
          onSelect={host.setActiveTabId}
          onClose={handleCloseTab}
          onCreate={() => createMenu[0]?.onSelect()}
          createMenu={createMenu}
          onRename={(tabId, name) => {
            host.setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, name } : t)));
          }}
          onReorder={(from, to) => {
            host.setTabs((prev) => {
              const next = [...prev];
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              return next;
            });
          }}
        />
        <div style={{ ...S.terminalContent, position: 'relative' as const }}>
          {host.isResizing && <div style={{ position: 'absolute', inset: 0, zIndex: 10 }} />}
          {(() => {
            if (!activeTab) {
              return (
                <div style={S.noTerminal}>
                  {host.activePath
                    ? createMenu.length > 0
                      ? `Click "+" to open ${createMenu.length === 1 ? `a new ${createMenu[0].label.toLowerCase()}` : 'a new tab'}`
                      : 'No tab type registered'
                    : 'Select a workspace from the ☰ menu'}
                </div>
              );
            }
            return mainContent?.({ activeTab, browserPanelOpen: host.browserPanelOpen }) ?? null;
          })()}
          {iframeTabsLayer?.({ activeTabId: host.activeTabId })}
        </div>
      </main>

      {host.isMobile && host.filesPanelOpen && (
        <div style={S.center}>
          {host.activePath ? (
            <FilePanel
              dirPath={host.activePath}
              width={0}
              isMobile
              onClose={() => host.setFilesPanelOpen(false)}
              onWidthChange={() => {}}
              fileHandlers={wrappedFileHandlers}
              fileIndicatorPaths={fileIndicatorPathsSet}
            />
          ) : (
            <div style={S.noTerminal}>Select a directory or worktree</div>
          )}
        </div>
      )}

      {!host.isMobile &&
        !isFilesDocked &&
        (host.filesPanelMounted || host.filesPanelOpen) && (
        <div style={{ ...S.overlayRight, display: host.filesPanelOpen ? undefined : 'none' }}>
          {host.activePath ? (
            <FilePanel
              dirPath={host.activePath}
              width={host.filesPanelWidth}
              onClose={() => host.setFilesPanelOpen(false)}
              onWidthChange={host.setFilesPanelWidth}
              onResizeStart={() => host.setIsResizing(true)}
              onResizeEnd={() => host.setIsResizing(false)}
              fileHandlers={wrappedFileHandlers}
              fileIndicatorPaths={fileIndicatorPathsSet}
            />
          ) : (
            <div
              style={{
                width: host.filesPanelWidth,
                background: 'var(--bg-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                fontSize: '12px',
                height: '100%',
              }}
            >
              Select a directory or worktree
            </div>
          )}
        </div>
      )}

      {!host.isMobile &&
        isFilesDocked &&
        host.filesPanelDockedOpen &&
        (host.activePath ? (
          <FilePanel
            dirPath={host.activePath}
            width={host.filesPanelWidth}
            onClose={() => host.setFilesPanelDockedOpen(false)}
            onWidthChange={host.setFilesPanelWidth}
            onResizeStart={() => host.setIsResizing(true)}
            onResizeEnd={() => host.setIsResizing(false)}
            fileHandlers={wrappedFileHandlers}
            fileIndicatorPaths={fileIndicatorPathsSet}
          />
        ) : (
          // Mirror the overlay placeholder so the docked panel does not
          // silently disappear when the active workspace is cleared.
          <div
            style={{
              width: host.filesPanelWidth,
              background: 'var(--bg-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontSize: '12px',
              height: '100%',
              borderLeft: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            Select a directory or worktree
          </div>
        ))}

      {!isDocked && host.workspacesOpen && (
        <>
          <div style={S.backdrop} onClick={() => host.setWorkspacesOpen(false)} />
          <div
            ref={workspacesOverlayRef}
            style={
              host.isMobile
                ? S.workspacesOverlayMobile
                : { ...S.workspacesOverlay, width: `${host.workspacesWidth}px` }
            }
          >
            {workspacePanelElement}
            {!host.isMobile && (
              <ResizeHandle
                axis="x"
                variant="edge"
                style={{ right: -3 }}
                onDrag={handleWorkspacesOverlayDrag}
              />
            )}
          </div>
        </>
      )}

      {host.pendingDeleteRepo && (
        <ConfirmDialog
          title="Remove Repository"
          message={`Remove "${host.pendingDeleteRepo.label}" and all its worktrees and sessions?`}
          buttons={[
            { label: 'Remove', danger: true, action: host.confirmDeleteRepo },
            { label: 'Cancel', action: () => host.setPendingDeleteRepo(null) },
          ]}
          onClose={() => host.setPendingDeleteRepo(null)}
        />
      )}
      {host.pendingDeleteWorktree && (
        <ConfirmDialog
          title="Remove Workspace"
          message={
            <>
              Remove workspace &quot;{host.pendingDeleteWorktree.wt.branch}&quot;?
              {host.pendingDeleteWorktree.dirty && (
                <div style={{ color: 'var(--danger)', marginTop: '8px' }}>
                  This workspace has uncommitted changes that will be permanently lost.
                </div>
              )}
            </>
          }
          buttons={[
            { label: 'Remove', danger: true, action: host.confirmDeleteWorktree },
            { label: 'Cancel', action: () => host.setPendingDeleteWorktree(null) },
          ]}
          onClose={() => host.setPendingDeleteWorktree(null)}
        />
      )}
      {host.worktreeDeleteError && (
        <ConfirmDialog
          title="Delete Failed"
          message={host.worktreeDeleteError}
          buttons={[{ label: 'OK', primary: true, action: () => host.setWorktreeDeleteError(null) }]}
          onClose={() => host.setWorktreeDeleteError(null)}
        />
      )}
      {host.settingsOpen && (
        <div style={host.isMobile ? S.settingsOverlayMobile : S.settingsOverlayRight}>
          <SettingsPanel
            width={host.isMobile ? 0 : host.settingsPanelWidth}
            isMobile={host.isMobile}
            onClose={() => host.setSettingsOpen(false)}
            onWidthChange={host.setSettingsPanelWidth}
            onResizeStart={() => host.setIsResizing(true)}
            onResizeEnd={() => host.setIsResizing(false)}
            workspacesPanelMode={host.workspacesPanelMode}
            onWorkspacesPanelModeChange={handleWorkspacesPanelModeChange}
            filesPanelMode={host.filesPanelMode}
            onFilesPanelModeChange={handleFilesPanelModeChange}
            browserPanelMode={host.browserPanelMode}
            onBrowserPanelModeChange={host.setBrowserPanelMode}
            browserInspectorPosition={host.browserInspectorPosition}
            onBrowserInspectorPositionChange={host.setBrowserInspectorPosition}
          />
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    height: '100dvh',
    width: '100vw',
    overflow: 'hidden',
    position: 'relative',
  },
  center: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
  },
  terminalContent: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  noTerminal: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    width: '100%',
    height: '100%',
    color: 'var(--text-muted)',
    fontSize: '14px',
  },
  tabBarBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    flexShrink: 0,
    padding: 0,
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    zIndex: 50,
  },
  workspacesOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    width: '280px',
    zIndex: 51,
    boxShadow: '4px 0 16px rgba(0,0,0,0.5)',
  },
  workspacesDocked: {
    position: 'relative',
    flexShrink: 0,
    height: '100%',
    borderRight: '1px solid var(--border)',
    background: 'var(--bg)',
  },
  workspacesOverlayMobile: {
    position: 'fixed',
    inset: 0,
    zIndex: 51,
    background: 'var(--bg)',
  },
  alertBadge: {
    position: 'absolute',
    top: '6px',
    right: '6px',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--warning, #d29922)',
  },
  overlayRight: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
  },
  // Settings sits above the files overlay (zIndex 50) so it stays usable
  // even when the files panel is open behind it.
  settingsOverlayRight: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
  },
  settingsOverlayMobile: {
    position: 'fixed',
    inset: 0,
    zIndex: 100,
    background: 'var(--bg)',
  },
};
