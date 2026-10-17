'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import WorkspacePanel, { WorkspaceHeaderActions } from './components/WorkspacePanel';
import TabBar, { renderTabIcon, type CreateMenuEntry, type TabMenuItem } from './components/TabBar';
import Sidebar, { WORKSPACES_SECTION } from './components/Sidebar';
import StatusBar from './components/StatusBar';
import SettingsPanel from './components/SettingsPanel';
import ConfirmDialog from './components/ConfirmDialog';
import { SettingsIcon, SidebarIcon } from './components/icons';
import type {
  HostApi,
  IframeTabsLayerState,
  MainContentContext,
  SidebarPanel,
  Tab,
} from './types';
import { FULL_PANE_STYLE } from './types';
import { ResizeHandle } from './components/ResizeHandle';
import {
  MIN_SPLIT_CONTENT_WIDTH,
  activeAfterRemoval,
  clampRatio,
  closeSplit,
  focusPane,
  followActive,
  moveToOtherSide,
  openToSide,
  resolvePanes,
  selectTab,
  sideOf,
  type PaneSide,
  parseSplitViews,
  restoreSplit,
  singlePane,
  toPersisted,
  type PersistedSplit,
  type SplitResult,
  type SplitState,
} from './splitView';
import { shouldResetWorkspaceTabs } from './workspaceSelection';
import { worktreeDeleteUrl, worktreeStatusUrl, probeIsDirty } from './worktreeDelete';
import { initClientTelemetry, track } from './telemetryClient';
import { MOBILE_MAX_WIDTH } from './breakpoints';
import {
  mergeTabOrder,
  neighbourAfterRemoval,
  parseTabOrders,
  placeBySavedOrder,
  type TabOrders,
} from './workspacePanelState';
import type { WorkspacesPanelMode, BrowserInspectorPosition } from '../lib/settings';
import type { WorkspaceEntry } from '../lib/workspaces';
import { on } from './events';
import { hasAlertElsewhere } from './components/workspaceList';

export type {
  HostApi,
  Tab,
  PluginIntegration,
  MainContentContext,
  IframeTabsLayerState,
  PaneSide,
  SidebarPanel,
} from './types';
export { composeIntegrations, FULL_PANE_STYLE, paneStyleResolver } from './types';
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

/** The `{ error }` a failed workspace route answers with, or a status fallback. */
async function errorMessage(res: Response, fallback = 'Request failed'): Promise<string> {
  const body = await res.json().catch(() => null);
  return body && typeof body.error === 'string' ? body.error : `${fallback} (${res.status}).`;
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
  /** Replace/update the tab list. Tabs that newly appear and have a saved
   *  position for this workspace are slotted back into it (see
   *  `placeBySavedOrder`), so integrations can restore asynchronously in any
   *  order without fighting the user's arrangement. */
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
  hostApi: HostApi;
  isMobile: boolean;
  settingsHydrated: boolean;
  /** Placement of the DevTools inspector inside browser tabs. */
  browserInspectorPosition: BrowserInspectorPosition;
  refreshWorkspaces: () => Promise<void>;

  // Host-internal (consumed by Home itself; integrations should ignore)
  /** Side-by-side split of the content area (see app/splitView.ts). The
   *  focused pane always shows `activeTabId`. */
  split: SplitState;
  /** Apply a split transition: `fn` gets the current split, active tab and
   *  strip ids and returns the next split + active tab, set together. */
  applySplit: (
    fn: (split: SplitState, activeTabId: string | null, tabIds: string[]) => SplitResult,
  ) => void;
  /** Divider drag: set the ratio without other side effects. */
  setSplitRatio: (ratio: number) => void;
  /** GET /api/workspaces: tracked folders, each followed by its linked worktrees. */
  workspaces: WorkspaceEntry[];
  workspacesOpen: boolean;
  workspacesPanelMode: WorkspacesPanelMode;
  workspacesPanelDockedOpen: boolean;
  /** Selected left-sidebar section ("workspaces" or a plugin panel id). */
  sidebarSection: string;
  workspacesWidth: number;
  settingsOpen: boolean;
  settingsPanelWidth: number;
  isResizing: boolean;
  pendingUntrack: { entry: WorkspaceEntry; label: string } | null;
  pendingDeleteWorktree: { wt: WorkspaceEntry; dirty: boolean } | null;
  worktreeDeleteError: string | null;
  setWorkspacesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspacesPanelMode: React.Dispatch<React.SetStateAction<WorkspacesPanelMode>>;
  setWorkspacesPanelDockedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarSection: React.Dispatch<React.SetStateAction<string>>;
  setBrowserInspectorPosition: React.Dispatch<React.SetStateAction<BrowserInspectorPosition>>;
  setWorkspacesWidth: React.Dispatch<React.SetStateAction<number>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingUntrack: React.Dispatch<
    React.SetStateAction<{ entry: WorkspaceEntry; label: string } | null>
  >;
  setPendingDeleteWorktree: React.Dispatch<
    React.SetStateAction<{ wt: WorkspaceEntry; dirty: boolean } | null>
  >;
  setWorktreeDeleteError: React.Dispatch<React.SetStateAction<string | null>>;
  /** Switch to a workspace folder (null deselects). */
  handleSelectWorkspace: (path: string | null) => void;
  /** Track a folder if needed, then switch to it. Resolves to an error message, or null. */
  handleOpenWorkspace: (path: string) => Promise<string | null>;
  /** Clone, track and switch to the clone. Resolves to an error message, or null. */
  handleCloneWorkspace: (url: string, destination: string) => Promise<string | null>;
  handleCreateWorktree: (repo: WorkspaceEntry) => Promise<void>;
  handleDeleteWorktree: (wt: WorkspaceEntry) => Promise<void>;
  handleRenameBranch: (wt: WorkspaceEntry, newName: string) => Promise<void>;
  /** `label` is the row's rendered name, for the confirm prompt. */
  handleUntrackWorkspace: (entry: WorkspaceEntry, label: string) => void;
  confirmUntrackWorkspace: () => Promise<void>;
  confirmDeleteWorktree: () => Promise<void>;
}

/**
 * Options for `useHomeState`. Currently just a hook for plugins to
 * participate in the host's workspace refresh — the testbox composer
 * passes the aggregated `composeIntegrations(...).onWorkspaceRefresh`
 * here so that every refresh path (panel ⟳ button + internal callers
 * like delete-repo) refreshes plugin-owned state too.
 */
export interface UseHomeStateOptions {
  /** Runs alongside the workspace list fetch, on every `refreshWorkspaces()`.
   *  Identity is snapshot via a ref each render, so callers don't need to
   *  ref-stabilize themselves; pass any inline closure. */
  onRefreshWorkspaces?: () => void | Promise<void>;
}

export function useHomeState(options?: UseHomeStateOptions): HomeState {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [tabs, setTabsRaw] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [workspacesPanelMode, setWorkspacesPanelMode] = useState<WorkspacesPanelMode>('docked');
  const [workspacesPanelDockedOpen, setWorkspacesPanelDockedOpen] = useState(true);
  const [sidebarSection, setSidebarSection] = useState<string>(WORKSPACES_SECTION);
  const [browserInspectorPosition, setBrowserInspectorPosition] =
    useState<BrowserInspectorPosition>('hidden');
  const [workspacesWidth, setWorkspacesWidth] = useState(280);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(420);
  const [isResizing, setIsResizing] = useState(false);
  const [pendingUntrack, setPendingUntrack] = useState<{
    entry: WorkspaceEntry;
    label: string;
  } | null>(null);
  const [pendingDeleteWorktree, setPendingDeleteWorktree] = useState<{
    wt: WorkspaceEntry;
    dirty: boolean;
  } | null>(null);
  const [worktreeDeleteError, setWorktreeDeleteError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [split, setSplit] = useState<SplitState>(() => singlePane());

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_MAX_WIDTH);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // ----- per-workspace tab order -----
  // `tabOrderRef[path]` is the saved left-to-right id order (including ids of
  // tabs not restored yet). Read synchronously by the tab setters below, so it
  // lives in a ref; persisted by the effect further down.
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const tabOrderRef = useRef<TabOrders>({});
  const persistedTabOrderRef = useRef<TabOrders>({});
  const splitRef = useRef(split);
  splitRef.current = split;
  /** Saved split per workspace (from settings, then from our own writes). */
  const splitByPathRef = useRef<Record<string, PersistedSplit>>({});

  const setTabs = useCallback<React.Dispatch<React.SetStateAction<Tab[]>>>((update) => {
    setTabsRaw((prev) => {
      const next = typeof update === 'function' ? update(prev) : update;
      if (next === prev) return prev;
      const path = activePathRef.current;
      return path ? placeBySavedOrder(prev, next, tabOrderRef.current[path]) : next;
    });
  }, []);

  /** Forget a closed tab's slot so reopening something with the same id
   *  doesn't jump back to where the old one was. */
  const forgetTabPosition = useCallback((id: string) => {
    const path = activePathRef.current;
    const saved = path ? tabOrderRef.current[path] : undefined;
    if (!path || !saved?.includes(id)) return;
    tabOrderRef.current = { ...tabOrderRef.current, [path]: saved.filter((x) => x !== id) };
  }, []);

  /** Drop a tab; if it was active, activate its right neighbour, else left. */
  const removeTabInternal = useCallback(
    (id: string) => {
      setTabsRaw((prev) => {
        // Unknown id → silent no-op (integrations call this speculatively), and
        // its saved slot is kept: it may be a tab that is about to be restored.
        if (!prev.some((t) => t.id === id)) return prev;
        forgetTabPosition(id);
        const neighbour = neighbourAfterRemoval(prev, id);
        // In a split, closing the focused tab focuses the other pane; the
        // split itself collapses in the followActive effect.
        const ids = prev.map((t) => t.id);
        const curSplit = splitRef.current;
        setActiveTabId((cur) => activeAfterRemoval(curSplit, cur, ids, id, neighbour));
        return prev.filter((t) => t.id !== id);
      });
    },
    [forgetTabPosition],
  );
  /** Fetch the workspace list; resolves to it (or null on failure) for callers
   *  that need the fresh entries before state has re-rendered. */
  const fetchWorkspaces = useCallback(async (): Promise<WorkspaceEntry[] | null> => {
    try {
      const res = await fetch('/api/workspaces');
      if (!res.ok) return null;
      const data = ((await res.json()) as { workspaces: WorkspaceEntry[] }).workspaces;
      setWorkspaces(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  // Snapshot via ref so refreshWorkspaces' identity stays stable even if
  // the consumer passes a fresh closure each render (composeIntegrations
  // does, since its aggregated handler list changes shape over time).
  const onRefreshWorkspacesRef = useRef(options?.onRefreshWorkspaces);
  onRefreshWorkspacesRef.current = options?.onRefreshWorkspaces;

  const refreshWorkspaces = useCallback(async () => {
    await Promise.all([fetchWorkspaces(), onRefreshWorkspacesRef.current?.()]);
  }, [fetchWorkspaces]);

  // Initial hydration from /api/settings + the workspace list.
  useEffect(() => {
    refreshWorkspaces();
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        if (data.activePath) setActivePath(data.activePath);
        if (data.activeTabId) setActiveTabId(data.activeTabId);
        // Legacy `workspacePanelState` / `filesPanelMode` / `browserPanelMode`
        // (side-panel era) are deliberately ignored.
        splitByPathRef.current = parseSplitViews(data.splitView);
        const orders = parseTabOrders(data.tabOrder);
        tabOrderRef.current = orders;
        persistedTabOrderRef.current = orders;
        if (typeof data.sidebarSection === 'string' && data.sidebarSection) {
          setSidebarSection(data.sidebarSection);
        }
        if (data.workspacesPanelMode === 'overlay' || data.workspacesPanelMode === 'docked') {
          setWorkspacesPanelMode(data.workspacesPanelMode);
        }
        if (typeof data.workspacesPanelDockedOpen === 'boolean') {
          setWorkspacesPanelDockedOpen(data.workspacesPanelDockedOpen);
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
        workspacesPanelMode,
        workspacesPanelDockedOpen,
        sidebarSection,
        browserInspectorPosition,
      }),
    });
  }, [
    settingsHydrated,
    activePath,
    activeTabId,
    workspacesPanelMode,
    workspacesPanelDockedOpen,
    sidebarSection,
    browserInspectorPosition,
  ]);

  // Persist the active workspace's tab order whenever the strip changes
  // (open / close / reorder). Merging with the saved order keeps the slots of
  // tabs that haven't been restored yet, so a half-restored strip right after
  // a switch or reload never truncates it.
  useEffect(() => {
    if (!settingsHydrated || !activePath) return;
    const merged = mergeTabOrder(
      tabs.map((t) => t.id),
      tabOrderRef.current[activePath] ?? [],
    );
    tabOrderRef.current = { ...tabOrderRef.current, [activePath]: merged };
    const persisted = persistedTabOrderRef.current[activePath] ?? [];
    if (persisted.length === merged.length && persisted.every((id, i) => id === merged[i])) return;
    persistedTabOrderRef.current = { ...persistedTabOrderRef.current, [activePath]: merged };
    const path = activePath;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabOrder: { [path]: merged } }),
    })
      .then((res) => {
        // Forget a failed write so the next change retries it.
        if (!res.ok && persistedTabOrderRef.current[path] === merged)
          delete persistedTabOrderRef.current[path];
      })
      .catch(() => {
        if (persistedTabOrderRef.current[path] === merged) delete persistedTabOrderRef.current[path];
      });
  }, [settingsHydrated, activePath, tabs]);

  // ----- split view: per-workspace reset, async restore, persistence -----
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  /** A saved split waiting for its tabs to restore. */
  const pendingSplitRef = useRef<{ path: string; saved: PersistedSplit } | null>(null);
  /** Last activeTabId the followActive effect saw (or a split transition set). */
  const lastActiveRef = useRef(activeTabId);
  /** Set split + active tab together, keeping the refs the effects below
   *  compare against in step (so they never read the update as external). */
  const commitSplit = useCallback((r: SplitResult) => {
    splitRef.current = r.split;
    lastActiveRef.current = r.activeTabId;
    activeTabIdRef.current = r.activeTabId;
    setSplit(r.split);
    setActiveTabId(r.activeTabId);
  }, []);
  /** Bumped when a pending restore is abandoned, so persistence re-runs. */
  const [splitRestoreEpoch, setSplitRestoreEpoch] = useState(0);

  useEffect(() => {
    const saved = activePath ? splitByPathRef.current[activePath] : undefined;
    const reset = singlePane(saved?.ratio);
    // Ref first: effects later in this commit still hold the previous
    // workspace's split and must see it as stale (see the persist effect).
    splitRef.current = reset;
    setSplit(reset);
    if (!activePath || !saved?.secondaryTabId) {
      pendingSplitRef.current = null;
      return;
    }
    const pending = { path: activePath, saved };
    pendingSplitRef.current = pending;
    // Give slow restores (browser pages come back via registry polling) a
    // while, then drop the split: its tab is not coming back.
    const timer = setTimeout(() => {
      if (pendingSplitRef.current !== pending) return;
      pendingSplitRef.current = null;
      setSplitRestoreEpoch((n) => n + 1);
    }, 15_000);
    return () => clearTimeout(timer);
  }, [activePath]);

  useEffect(() => {
    const pending = pendingSplitRef.current;
    if (!pending || pending.path !== activePath) return;
    const r = restoreSplit(
      pending.saved,
      activeTabId,
      tabs.map((t) => t.id),
    );
    if (r === 'wait') return;
    pendingSplitRef.current = null;
    commitSplit(r);
  }, [activePath, tabs, activeTabId]);

  // Keep the split consistent when activeTabId / tabs change outside a split
  // transition (integration activateTab, removals, prunes).
  useEffect(() => {
    // A split transition was committed after this render; the next render's
    // run sees it (reading this render's values now would undo it).
    if (activeTabId !== activeTabIdRef.current) return;
    const prev = lastActiveRef.current;
    lastActiveRef.current = activeTabId;
    const ids = tabs.map((t) => t.id);
    setSplit((s) => followActive(s, prev, activeTabId, ids));
  }, [activeTabId, tabs]);

  const applySplit = useCallback<HomeState['applySplit']>((fn) => {
    const r = fn(
      splitRef.current,
      activeTabIdRef.current,
      tabsRef.current.map((t) => t.id),
    );
    // A user arrangement supersedes a restore still waiting for its tabs.
    pendingSplitRef.current = null;
    commitSplit(r);
  }, [commitSplit]);

  const setSplitRatio = useCallback((ratio: number) => {
    setSplit((s) => (s.ratio === ratio ? s : { ...s, ratio }));
  }, []);

  const lastPersistedSplitRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!settingsHydrated || !activePath || isResizing) return;
    if (pendingSplitRef.current?.path === activePath) return;
    // Stale render: a newer split is already committed and will run this again.
    if (split !== splitRef.current || activeTabId !== activeTabIdRef.current) return;
    const entry = toPersisted(
      split,
      activeTabId,
      tabs.map((t) => t.id),
    );
    const serialized = JSON.stringify(entry);
    const savedBefore = splitByPathRef.current[activePath];
    splitByPathRef.current = { ...splitByPathRef.current, [activePath]: entry };
    // First look at this workspace: compare with what is on disk (or the
    // default), so merely visiting a workspace writes nothing.
    const baseline =
      lastPersistedSplitRef.current[activePath] ??
      JSON.stringify(savedBefore ?? toPersisted(singlePane(), null, []));
    if (baseline === serialized) {
      lastPersistedSplitRef.current[activePath] = serialized;
      return;
    }
    lastPersistedSplitRef.current[activePath] = serialized;
    const path = activePath;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ splitView: { [path]: entry } }),
    })
      .then((res) => {
        if (!res.ok && lastPersistedSplitRef.current[path] === serialized)
          delete lastPersistedSplitRef.current[path];
      })
      .catch(() => {
        if (lastPersistedSplitRef.current[path] === serialized)
          delete lastPersistedSplitRef.current[path];
      });
  }, [settingsHydrated, activePath, split, activeTabId, tabs, isResizing, splitRestoreEpoch]);

  const hostApi: HostApi = useMemo(
    () => ({
      openTab(tab, options) {
        const after = options?.after;
        setTabsRaw((prev) => {
          if (prev.some((t) => t.id === tab.id)) return prev;
          const afterIndex = after ? prev.findIndex((t) => t.id === after) : -1;
          if (afterIndex !== -1) {
            // Explicit placement wins over the saved order.
            const next = [...prev];
            next.splice(afterIndex + 1, 0, tab);
            return next;
          }
          const next = [...prev, tab];
          const path = activePathRef.current;
          return path ? placeBySavedOrder(prev, next, tabOrderRef.current[path]) : next;
        });
        if (options?.activate !== false) setActiveTabId(tab.id);
      },
      updateTab(id, patch) {
        setTabsRaw((prev) => {
          const i = prev.findIndex((t) => t.id === id);
          if (i === -1) return prev;
          const cur = prev[i];
          const changed = (Object.keys(patch) as Array<keyof typeof patch>).some(
            (k) => cur[k] !== patch[k],
          );
          if (!changed) return prev;
          const next = [...prev];
          next[i] = { ...cur, ...patch, id: cur.id, type: cur.type };
          return next;
        });
      },
      removeTab(id) {
        removeTabInternal(id);
      },
      activateTab(id) {
        // Checked inside an updater so an openTab queued in the same tick
        // counts as present. Returning `prev` makes this a no-op render-wise.
        setTabsRaw((prev) => {
          if (prev.some((t) => t.id === id)) setActiveTabId(id);
          return prev;
        });
      },
    }),
    [removeTabInternal],
  );

  const handleSelectWorkspace = useCallback(
    (nextPath: string | null) => {
      if (!shouldResetWorkspaceTabs(activePath, nextPath)) return;
      setActivePath(nextPath);
      setTabs([]);
      setActiveTabId(null);
      if (nextPath) track('workspace_switched', { kind: 'workspace' });
    },
    [activePath, setTabs],
  );

  /** POST a workspace route and switch to the entry it answers with. */
  const trackAndSelect = useCallback(
    async (url: string, body: unknown): Promise<string | null> => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) return await errorMessage(res);
        const entry: WorkspaceEntry = await res.json();
        await refreshWorkspaces();
        handleSelectWorkspace(entry.path);
        return null;
      } catch {
        return 'Could not reach the server.';
      }
    },
    [refreshWorkspaces, handleSelectWorkspace],
  );

  const handleOpenWorkspace = useCallback(
    (path: string) => {
      // Already listed under this spelling: switch without a round-trip.
      if (workspaces.some((w) => w.path === path)) {
        handleSelectWorkspace(path);
        return Promise.resolve(null);
      }
      return trackAndSelect('/api/workspaces', { path });
    },
    [workspaces, handleSelectWorkspace, trackAndSelect],
  );

  const handleCloneWorkspace = useCallback(
    (url: string, destination: string) =>
      trackAndSelect('/api/workspaces/clone', { url, destination: destination || undefined }),
    [trackAndSelect],
  );

  const handleCreateWorktree = useCallback(
    async (repo: WorkspaceEntry) => {
      await trackAndSelect('/api/workspaces/worktrees', { path: repo.path, newBranch: true });
    },
    [trackAndSelect],
  );

  const handleDeleteWorktree = useCallback(async (wt: WorkspaceEntry) => {
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

  const clearActiveIf = useCallback(
    (gone: (path: string) => boolean) => {
      if (activePath && gone(activePath)) {
        setActivePath(null);
        setTabs([]);
        setActiveTabId(null);
      }
    },
    [activePath, setTabs],
  );

  const confirmDeleteWorktree = useCallback(async () => {
    const pending = pendingDeleteWorktree;
    setPendingDeleteWorktree(null);
    if (!pending) return;
    const { wt, dirty } = pending;
    try {
      const res = await fetch(worktreeDeleteUrl(wt.path, dirty), { method: 'DELETE' });
      if (!res.ok) {
        // The user confirmed a destructive action and it didn't happen (the
        // worktree went dirty between probe and confirm → 409, a locked worktree,
        // or a 5xx). Surface the server's reason instead of silently leaving a
        // blank panel, and don't clobber the still-live active session for a
        // worktree that wasn't actually removed.
        setWorktreeDeleteError(await errorMessage(res, 'Delete failed'));
        await refreshWorkspaces();
        return;
      }
      clearActiveIf((p) => p === wt.path);
      await refreshWorkspaces();
    } catch {
      // Network error reaching the server — the user confirmed but nothing
      // happened; surface it rather than leaving a blank panel (mirrors the
      // probe's fail-safe catch above).
      setWorktreeDeleteError('Delete failed — could not reach the server.');
      await refreshWorkspaces();
    }
  }, [pendingDeleteWorktree, clearActiveIf, refreshWorkspaces]);

  const handleRenameBranch = useCallback(
    async (wt: WorkspaceEntry, newName: string) => {
      await fetch(`/api/worktrees/${encodeURIComponent(wt.id)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      });
      await refreshWorkspaces();
    },
    [refreshWorkspaces],
  );

  const handleUntrackWorkspace = useCallback((entry: WorkspaceEntry, label: string) => {
    setPendingUntrack({ entry, label });
  }, []);

  const confirmUntrackWorkspace = useCallback(async () => {
    const entry = pendingUntrack?.entry;
    setPendingUntrack(null);
    if (!entry) return;
    await fetch(`/api/workspaces?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
    // Its auto-listed worktrees leave the list with it.
    const nested = new Set(workspaces.filter((w) => w.parent === entry.path).map((w) => w.path));
    clearActiveIf((p) => p === entry.path || nested.has(p));
    await refreshWorkspaces();
  }, [pendingUntrack, workspaces, clearActiveIf, refreshWorkspaces]);

  return {
    activePath,
    activeTabId,
    tabs,
    setTabs,
    setActiveTabId,
    hostApi,
    isMobile,
    settingsHydrated,
    refreshWorkspaces,
    split,
    applySplit,
    setSplitRatio,
    workspaces,
    workspacesOpen,
    workspacesPanelMode,
    workspacesPanelDockedOpen,
    sidebarSection,
    browserInspectorPosition,
    workspacesWidth,
    settingsOpen,
    settingsPanelWidth,
    isResizing,
    pendingUntrack,
    pendingDeleteWorktree,
    worktreeDeleteError,
    setWorkspacesOpen,
    setWorkspacesPanelMode,
    setWorkspacesPanelDockedOpen,
    setSidebarSection,
    setBrowserInspectorPosition,
    setWorkspacesWidth,
    setSettingsOpen,
    setSettingsPanelWidth,
    setIsResizing,
    setPendingUntrack,
    setPendingDeleteWorktree,
    setWorktreeDeleteError,
    handleSelectWorkspace,
    handleOpenWorkspace,
    handleCloneWorkspace,
    handleCreateWorktree,
    handleDeleteWorktree,
    handleRenameBranch,
    handleUntrackWorkspace,
    confirmUntrackWorkspace,
    confirmDeleteWorktree,
  };
}


// =========================================================================
// Home — pure renderer. State must be threaded in via the `state` prop.
// =========================================================================

const EMPTY_PATH_SET: ReadonlySet<string> = new Set();
const EMPTY_TAB_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_ORPHANS: Record<string, { name: string; created: string }[]> = {};
const EMPTY_PANELS: ReadonlyArray<SidebarPanel> = [];

export interface HomeProps {
  /** Required: the host state instance, obtained from `useHomeState()`. */
  state: HomeState;
  /**
   * Render slot for the active tab's component-mode content. Plugin
   * integrations contribute via `composeIntegrations(...)`.
   */
  mainContent?: (ctx: MainContentContext) => ReactNode;
  /** Render slot for the iframe overlay (pane-aware: see `paneStyleFor`). */
  iframeTabsLayer?: (state: IframeTabsLayerState) => ReactNode;
  /** @deprecated The file tree is an integration-owned sidebar panel now; the
   *  files integration consumes these. Accepted (and ignored) so a spread of
   *  `composeIntegrations(...)` still type-checks. */
  fileHandlers?: ReadonlyArray<{
    pattern: string;
    label: string;
    onSelect: (absPath: string, api: HostApi) => void | Promise<void>;
  }>;
  /** @deprecated See `fileHandlers`. */
  fileIndicatorPaths?: ReadonlySet<string>;
  ephemeralTabTypes?: ReadonlySet<string>;
  onCloseTab?: (tab: Tab) => void;
  /** Composed veto for user-initiated closes (resolve `false` to keep the tab). */
  beforeCloseTab?: (tab: Tab) => boolean | Promise<boolean>;
  /** Composed per-tab icon (null → the host's per-type default). */
  tabIcon?: (tab: Tab) => ReactNode | null;
  /** Integration-contributed left-sidebar sections, after Workspaces. */
  sidebarPanels?: ReadonlyArray<SidebarPanel>;
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
    onCloseTab,
    beforeCloseTab,
    tabIcon,
    sidebarPanels,
    tabTypeChoices,
    alertedPaths,
    alertedTabIds,
    workspaceOrphans,
    workspaceReady,
  } = props;

  const effectiveAlertedPaths = alertedPaths ?? EMPTY_PATH_SET;
  const effectiveAlertedTabIds = alertedTabIds ?? EMPTY_TAB_ID_SET;
  const effectiveOrphans = workspaceOrphans ?? EMPTY_ORPHANS;
  const panels = sidebarPanels ?? EMPTY_PANELS;

  // Narrow viewports always use overlay regardless of the user's preference.
  const effectiveSidebarMode: WorkspacesPanelMode = host.isMobile
    ? 'overlay'
    : host.workspacesPanelMode;
  const isDocked = effectiveSidebarMode === 'docked';
  const sidebarVisible = isDocked ? host.workspacesPanelDockedOpen : host.workspacesOpen;

  // [+] entries need a workspace: every tab is scoped to one.
  const createMenu = useMemo<CreateMenuEntry[]>(() => {
    if (!host.activePath) return [];
    return (tabTypeChoices ?? []).map((c) => ({
      type: c.type,
      label: c.label,
      onSelect: () => {
        void c.onCreate(host.hostApi);
      },
    }));
  }, [tabTypeChoices, host.hostApi, host.activePath]);

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
      ...host.hostApi,
      openTab: (tab, options) => host.hostApi.openTab(tab, { ...options, activate: false }),
      activateTab: () => {},
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

  // User-initiated close: ask the owning integration first (e.g. an unsaved
  // file prompt), then notify, then drop the tab and focus its neighbour.
  const closingRef = useRef<Set<string>>(new Set());
  const tabsRef = useRef(host.tabs);
  tabsRef.current = host.tabs;
  const handleCloseTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || closingRef.current.has(tabId)) return;
      closingRef.current.add(tabId);
      try {
        if (beforeCloseTab) {
          let allowed: boolean;
          try {
            allowed = (await beforeCloseTab(tab)) !== false;
          } catch (err) {
            // A throwing guard keeps the tab: losing unsaved work is worse.
            console.warn(
              '[home] beforeCloseTab failed; keeping the tab:',
              err instanceof Error ? err.message : String(err),
            );
            allowed = false;
          }
          if (!allowed) return;
        }
        // The tab may have gone away while the guard was prompting.
        const current = tabsRef.current.find((t) => t.id === tabId) ?? tab;
        onCloseTab?.(current);
        track('tab_closed', { type: current.type });
        host.hostApi.removeTab(tabId);
      } finally {
        closingRef.current.delete(tabId);
      }
    },
    [host.hostApi, beforeCloseTab, onCloseTab],
  );

  const handleCloseSidebar = useCallback(() => {
    if (isDocked) host.setWorkspacesPanelDockedOpen(false);
    else host.setWorkspacesOpen(false);
  }, [host, isDocked]);

  const handleToggleSidebar = useCallback(() => {
    if (isDocked) host.setWorkspacesPanelDockedOpen((prev) => !prev);
    else host.setWorkspacesOpen((v) => !v);
    track('panel_toggled', { panel: 'workspaces' });
  }, [host, isDocked]);

  const openSidebarOn = useCallback(
    (section: string) => {
      host.setSidebarSection(section);
      if (isDocked) host.setWorkspacesPanelDockedOpen(true);
      else host.setWorkspacesOpen(true);
    },
    [host, isDocked],
  );

  const handleSelectWorkspaceAndClose = useCallback(
    (path: string) => {
      host.handleSelectWorkspace(path);
      // Docked mode keeps the sidebar pinned — selecting a worktree shouldn't hide it.
      if (!isDocked) host.setWorkspacesOpen(false);
    },
    [host, isDocked],
  );

  /** Wrap a track-and-switch action so a success dismisses the overlay sidebar. */
  const closingOnSuccess = useCallback(
    <A extends unknown[]>(action: (...args: A) => Promise<string | null>) =>
      async (...args: A) => {
        const err = await action(...args);
        if (!err && !isDocked) host.setWorkspacesOpen(false);
        return err;
      },
    [host, isDocked],
  );
  const handleOpenWorkspaceAndClose = useMemo(
    () => closingOnSuccess(host.handleOpenWorkspace),
    [closingOnSuccess, host.handleOpenWorkspace],
  );
  const handleCloneWorkspaceAndClose = useMemo(
    () => closingOnSuccess(host.handleCloneWorkspace),
    [closingOnSuccess, host.handleCloneWorkspace],
  );

  // Cross-area requests (see app/events.ts): other sections ask to switch
  // workspace or to reveal a sidebar section.
  useEffect(
    () =>
      on('omniterm:open-workspace', ({ path }) => {
        void handleOpenWorkspaceAndClose(path).then((err) => {
          if (err) console.warn(`[home] could not open workspace ${path}: ${err}`);
        });
      }),
    [handleOpenWorkspaceAndClose],
  );
  useEffect(() => on('omniterm:show-sidebar', ({ section }) => openSidebarOn(section)), [
    openSidebarOn,
  ]);

  // When the user switches display mode while the sidebar is visible, carry
  // the visibility across: the two modes use independent flags
  // (workspacesOpen for overlay, workspacesPanelDockedOpen for docked).
  const handleSidebarModeChange = useCallback(
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

  const alertedPathSet = useMemo(
    () =>
      effectiveAlertedPaths instanceof Set
        ? (effectiveAlertedPaths as Set<string>)
        : new Set(effectiveAlertedPaths),
    [effectiveAlertedPaths],
  );

  const workspacePanelElement = (
    <WorkspacePanel
      workspaces={host.workspaces}
      orphanSessions={effectiveOrphans}
      activePath={host.activePath}
      alertedPaths={alertedPathSet}
      onSelect={handleSelectWorkspaceAndClose}
      onOpenPath={handleOpenWorkspaceAndClose}
      onClone={handleCloneWorkspaceAndClose}
      onCreateWorktree={host.handleCreateWorktree}
      onDeleteWorktree={host.handleDeleteWorktree}
      onRenameBranch={host.handleRenameBranch}
      onUntrack={host.handleUntrackWorkspace}
    />
  );

  const workspacesActions = (
    <WorkspaceHeaderActions
      onRefresh={() => void host.refreshWorkspaces()}
      onGoHome={() => {
        host.handleSelectWorkspace(null);
        if (!isDocked) host.setWorkspacesOpen(false);
      }}
    />
  );

  const hasAlerts = useMemo(
    () =>
      hasAlertElsewhere(host.workspaces, effectiveOrphans, effectiveAlertedPaths, host.activePath),
    [host.workspaces, effectiveOrphans, effectiveAlertedPaths, host.activePath],
  );

  // The badge surfaces alerts in other workspaces, but only while the sidebar
  // is hidden — once visible, the in-list highlight already shows where.
  const topBarLeft = (
    <button
      className="ot-icon-btn"
      onClick={handleToggleSidebar}
      title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
      aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
      aria-pressed={sidebarVisible}
    >
      <SidebarIcon size={18} />
      {hasAlerts && !sidebarVisible && <span style={S.alertBadge} />}
    </button>
  );

  const topBarRight = (
    <button
      className="ot-icon-btn"
      onClick={() => host.setSettingsOpen(true)}
      title="Settings"
      aria-label="Settings"
    >
      <SettingsIcon size={18} />
    </button>
  );

  const alertedTabIdSet = useMemo(
    () =>
      effectiveAlertedTabIds instanceof Set
        ? (effectiveAlertedTabIds as Set<string>)
        : new Set(effectiveAlertedTabIds),
    [effectiveAlertedTabIds],
  );

  const activeTab = host.tabs.find((t) => t.id === host.activeTabId) ?? null;

  // ----- split view layout -----
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setContentWidth(el.clientWidth);
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setContentWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Mobile / narrow windows: no split UI, only the focused pane (the split
  // state is kept, so it comes back when the window widens).
  const splitAllowed = !host.isMobile && contentWidth >= MIN_SPLIT_CONTENT_WIDTH;
  const tabIds = useMemo(() => host.tabs.map((t) => t.id), [host.tabs]);
  const panes = resolvePanes(host.split, host.activeTabId, tabIds);
  const splitShown = splitAllowed && panes.secondary !== null;
  const ratioPct = Math.round(clampRatio(host.split.ratio) * 10000) / 100;

  /** Visible panes and their boxes. Style objects are memoised on the layout
   *  so memo'd panes (FilePane) only re-render when it really changes. */
  const layout = useMemo(() => {
    const boxes = new Map<string, { side: PaneSide; style: React.CSSProperties }>();
    if (splitShown && panes.primary && panes.secondary) {
      boxes.set(panes.primary, {
        side: 'primary',
        style: { position: 'absolute', top: 0, bottom: 0, left: 0, right: `calc(${100 - ratioPct}% + 1px)` },
      });
      boxes.set(panes.secondary, {
        side: 'secondary',
        style: { position: 'absolute', top: 0, bottom: 0, left: `calc(${ratioPct}% + 1px)`, right: 0 },
      });
    } else if (host.activeTabId) {
      boxes.set(host.activeTabId, { side: panes.focused, style: FULL_PANE_STYLE });
    }
    return boxes;
  }, [splitShown, panes.primary, panes.secondary, panes.focused, ratioPct, host.activeTabId]);

  const paneStyleFor = useCallback((tabId: string) => layout.get(tabId)?.style ?? null, [layout]);
  const sideBoxStyle = (side: PaneSide): React.CSSProperties => {
    for (const box of layout.values()) if (box.side === side) return box.style;
    return FULL_PANE_STYLE;
  };

  const { applySplit } = host;
  const handleSelectTab = useCallback(
    (tabId: string) => applySplit((sp, active, ids) => selectTab(sp, active, ids, tabId)),
    [applySplit],
  );
  const handleFocusPane = useCallback(
    (side: PaneSide) => applySplit((sp, active, ids) => focusPane(sp, active, ids, side)),
    [applySplit],
  );

  // Focus follows the pane the user works in. Clicks inside an iframe
  // (terminal, DevTools, preview) never reach this document, so watch for the
  // focus moving INTO an iframe: the window blurs and `activeElement` becomes
  // that iframe. Focus can then hop between iframes without another blur, so
  // poll activeElement while the window is blurred.
  const splitShownRef = useRef(splitShown);
  splitShownRef.current = splitShown;
  const ratioRef = useRef(host.split.ratio);
  ratioRef.current = host.split.ratio;
  useEffect(() => {
    if (!splitShown) return;
    const sideAtX = (clientX: number): PaneSide | null => {
      const el = contentRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return null;
      return clientX - r.left < r.width * clampRatio(ratioRef.current) ? 'primary' : 'secondary';
    };
    let lastFrame: Element | null = null;
    const checkActiveElement = () => {
      const el = document.activeElement;
      if (el === lastFrame) return;
      lastFrame = el;
      if (!(el instanceof HTMLIFrameElement) || !contentRef.current?.contains(el)) return;
      const b = el.getBoundingClientRect();
      const side = sideAtX(b.left + b.width / 2);
      if (side) handleFocusPane(side);
    };
    let poll: ReturnType<typeof setInterval> | null = null;
    const onBlur = () => {
      setTimeout(checkActiveElement, 0);
      if (!poll) poll = setInterval(checkActiveElement, 250);
    };
    const onFocus = () => {
      if (poll) clearInterval(poll);
      poll = null;
      lastFrame = document.activeElement;
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || !contentRef.current?.contains(target)) return;
      if (target.closest('.ot-split-divider')) return;
      const side = sideAtX(e.clientX);
      if (side) handleFocusPane(side);
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('pointerdown', onPointerDown, true);
    if (!document.hasFocus()) onBlur();
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('pointerdown', onPointerDown, true);
      if (poll) clearInterval(poll);
    };
  }, [splitShown, handleFocusPane]);

  // ----- divider drag -----
  const dragRectRef = useRef<DOMRect | null>(null);
  const handleDividerStart = useCallback(() => {
    dragRectRef.current = contentRef.current?.getBoundingClientRect() ?? null;
    host.setIsResizing(true);
  }, [host]);
  const handleDividerDrag = useCallback(
    ({ x }: { x: number }) => {
      const r = dragRectRef.current;
      if (!r || r.width <= 0) return;
      host.setSplitRatio(clampRatio((x - r.left) / r.width));
    },
    [host],
  );
  const handleDividerEnd = useCallback(() => {
    dragRectRef.current = null;
    host.setIsResizing(false);
  }, [host]);

  // ----- tab drag onto the content area -----
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<PaneSide | null>(null);
  const showDropOverlay = splitAllowed && draggingTabId !== null && host.tabs.length >= 2;
  const dropSideAt = (e: React.DragEvent<HTMLDivElement>): PaneSide => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX - r.left < r.width / 2 ? 'primary' : 'secondary';
  };

  const tabMenu = useCallback(
    (tab: Tab): TabMenuItem[] => {
      const items: TabMenuItem[] = [];
      if (splitAllowed) {
        const visibleSide = splitShown ? sideOf(panes, tab.id) : null;
        if (visibleSide) {
          items.push({
            label: 'Move to other side',
            onSelect: () =>
              host.applySplit((sp, active, ids) => moveToOtherSide(sp, active, ids, tab.id)),
          });
        } else {
          items.push({
            label: 'Open to the side',
            disabled: host.tabs.length < 2,
            onSelect: () =>
              host.applySplit((sp, active, ids) => openToSide(sp, active, ids, tab.id)),
          });
        }
        if (splitShown) {
          items.push({
            label: 'Close split',
            onSelect: () => host.applySplit((sp, active) => closeSplit(sp, active)),
          });
        }
      }
      if (items.length > 0) {
        items.push({ label: 'Close tab', separatorBefore: true, onSelect: () => void handleCloseTab(tab.id) });
      }
      return items;
    },
    [splitAllowed, splitShown, panes, host, handleCloseTab],
  );

  const visiblePanes = [...layout.entries()]
    .map(([tabId, box]) => ({ tabId, ...box, tab: host.tabs.find((t) => t.id === tabId) ?? null }))
    // Stable DOM order (by id, not by side): moving a keyed element in the DOM
    // reloads any iframe inside it, so swapping sides must only change styles.
    .sort((a, b) => (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0));

  const emptyState = (() => {
    if (activeTab || host.tabs.length > 0) return null;
    // Restoring: integrations will add tabs shortly; don't flash a prompt.
    if (host.activePath && (workspaceReady === false || !host.settingsHydrated)) return null;
    if (!host.activePath) {
      return (
        <div style={S.empty}>
          <div style={S.emptyTitle}>No workspace selected</div>
          <div style={S.emptyHint}>Pick a folder to work in.</div>
          <div style={S.emptyActions}>
            <button className="ot-empty-btn" onClick={() => openSidebarOn(WORKSPACES_SECTION)}>
              <SidebarIcon size={14} />
              Choose a workspace
            </button>
          </div>
        </div>
      );
    }
    return (
      <div style={S.empty}>
        <div style={S.emptyTitle}>No tabs open</div>
        {createMenu.length === 0 ? (
          <div style={S.emptyHint}>No tab type registered.</div>
        ) : (
          <div style={S.emptyActions}>
            {createMenu.map((c) => (
              <button key={`${c.type}:${c.label}`} className="ot-empty-btn" onClick={c.onSelect}>
                {renderTabIcon({ type: c.type, id: '', name: c.label }, tabIcon, 14)}
                New {c.label.toLowerCase()}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  })();

  return (
    <div style={S.root}>
      <Sidebar
        mode={effectiveSidebarMode}
        open={sidebarVisible}
        isMobile={host.isMobile}
        width={host.workspacesWidth}
        onWidthChange={host.setWorkspacesWidth}
        onResizeStart={() => host.setIsResizing(true)}
        onResizeEnd={() => host.setIsResizing(false)}
        onClose={handleCloseSidebar}
        section={host.sidebarSection}
        onSectionChange={host.setSidebarSection}
        workspaces={workspacePanelElement}
        workspacesActions={workspacesActions}
        panels={panels}
      />
      <main style={S.center}>
        <TabBar
          tabs={host.tabs}
          activeTabId={host.activeTabId}
          secondaryTabId={
            splitShown ? (panes.focused === 'primary' ? panes.secondary : panes.primary) : null
          }
          tabMenu={tabMenu}
          onTabDragStart={(id) => setDraggingTabId(id)}
          onTabDragEnd={() => {
            setDraggingTabId(null);
            setDropSide(null);
          }}
          alertedTabIds={alertedTabIdSet}
          compact={host.isMobile}
          leftAction={topBarLeft}
          rightAction={topBarRight}
          onSelect={handleSelectTab}
          onClose={(id) => void handleCloseTab(id)}
          createMenu={createMenu}
          tabIcon={tabIcon}
          onRename={(tabId, name) => host.hostApi.updateTab(tabId, { name })}
          onReorder={(from, to) => {
            host.setTabs((prev) => {
              const next = [...prev];
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              return next;
            });
          }}
        />
        <div ref={contentRef} style={S.content}>
          {host.isResizing && <div style={S.resizeShield} />}
          {activeTab
            ? visiblePanes.map(({ tabId, tab, side, style }) =>
                tab ? (
                  <div key={tabId} data-pane={side} style={{ ...style, display: 'flex', minWidth: 0 }}>
                    {mainContent?.({
                      activeTab: tab,
                      browserPanelOpen: false,
                      pane: side,
                      focused: tabId === host.activeTabId,
                      resizing: host.isResizing,
                    }) ?? null}
                  </div>
                ) : null,
              )
            : emptyState}
          {iframeTabsLayer?.({ activeTabId: host.activeTabId, paneStyleFor })}
          {splitShown && (
            <>
              <div
                aria-hidden
                style={{ ...sideBoxStyle(panes.focused), ...S.focusOutline }}
              />
              <div style={{ ...S.dividerLine, left: `calc(${ratioPct}% - 1px)` }} />
              <ResizeHandle
                axis="x"
                variant="edge"
                grip="hover"
                style={{ left: `calc(${ratioPct}% - 3px)`, zIndex: 20 }}
                onStart={handleDividerStart}
                onDrag={handleDividerDrag}
                onEnd={handleDividerEnd}
                className="ot-split-divider"
              />
            </>
          )}
          {showDropOverlay && (
            <div
              style={S.dropOverlay}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const side = dropSideAt(e);
                if (side !== dropSide) setDropSide(side);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropSide(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = draggingTabId;
                const side = dropSideAt(e);
                setDraggingTabId(null);
                setDropSide(null);
                if (id) host.applySplit((sp, active, ids) => openToSide(sp, active, ids, id, side));
              }}
            >
              {dropSide && (
                <div
                  style={{
                    ...S.dropHint,
                    left: dropSide === 'primary' ? 0 : '50%',
                    right: dropSide === 'primary' ? '50%' : 0,
                  }}
                >
                  {dropSide === 'primary' ? 'Open on the left' : 'Open on the right'}
                </div>
              )}
            </div>
          )}
        </div>
        <StatusBar cwd={host.activePath} isMobile={host.isMobile} />
      </main>

      {host.pendingUntrack && (
        <ConfirmDialog
          title="Remove Workspace"
          message={
            host.pendingUntrack.entry.git?.isMainWorktree
              ? `Remove "${host.pendingUntrack.label}" from workspaces? Its terminal sessions are closed and clean worktrees removed; the folder stays on disk.`
              : `Remove "${host.pendingUntrack.label}" from workspaces? The folder stays on disk.`
          }
          buttons={[
            { label: 'Remove', danger: true, action: host.confirmUntrackWorkspace },
            { label: 'Cancel', action: () => host.setPendingUntrack(null) },
          ]}
          onClose={() => host.setPendingUntrack(null)}
        />
      )}
      {host.pendingDeleteWorktree && (
        <ConfirmDialog
          title="Delete Worktree"
          message={
            <>
              Delete worktree &quot;{host.pendingDeleteWorktree.wt.git?.branch ?? host.pendingDeleteWorktree.wt.name}&quot; and its folder?
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
            onWorkspacesPanelModeChange={handleSidebarModeChange}
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
  content: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0,
  },
  resizeShield: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
  },
  focusOutline: {
    pointerEvents: 'none',
    zIndex: 15,
    boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--link) 55%, transparent)',
  },
  dividerLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '2px',
    background: 'var(--border)',
    zIndex: 16,
    pointerEvents: 'none',
  },
  dropOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 30,
  },
  dropHint: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    margin: '6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    border: '1px dashed var(--link)',
    background: 'color-mix(in srgb, var(--link) 14%, transparent)',
    color: 'var(--text-bright)',
    fontSize: '12px',
    pointerEvents: 'none',
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '24px 16px',
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: '13px',
    color: 'var(--text)',
  },
  emptyHint: {
    fontSize: '12px',
    color: 'var(--text-muted)',
  },
  emptyActions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '8px',
    marginTop: '8px',
  },
  alertBadge: {
    position: 'absolute',
    top: '7px',
    right: '7px',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--warning)',
  },
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
