/**
 * Terminal plugin — React integration for the omniterm host.
 *
 * Owns all terminal-specific state that previously lived in `Home`:
 *   - sessionMap (port/url/etc per tmux session id; each terminal tab is 1:1
 *     with a session, so tab.id === sessionId)
 *   - orphanSessions (tmux sessions outside known repos — used by the
 *     host's workspace panel)
 *   - alertedPaths / alertedSessionIds (driven by the session-silence SSE)
 *
 * Returns a `PluginIntegration` plus a few terminal-specific extras the
 * host's workspace UI needs (orphanSessions). The host composes this
 * with debugger/agent integrations via `composeIntegrations`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from 'react';
import {
  FULL_PANE_STYLE,
  paneStyleResolver,
  type HostApi,
  type IframeTabsLayerState,
  type PluginIntegration,
  type Tab,
} from '../../app/types';
import { track } from '../../app/telemetryClient';
import { TerminalIcon } from '../../app/components/icons';
import { on } from '../../app/events';
import { FILE_PATH_DRAG_MIME, basename, isInside } from '../../app/files/fileOps';
import TerminalView from './components/TerminalView';
import MobileInputChrome from './components/MobileInputChrome';
import { sendData } from './lib/terminalInput';
import { pathDropText } from './lib/shellQuote';
import {
  buildWarmRenderList,
  mergeRestoredTabs,
  pruneSessionsFromByPath,
  restoreTabsFromSnapshot,
  survivingTerminalTabs,
  type SessionInfo,
  type WarmSnapshot,
} from './warmWorkspaces';

// `WarmSnapshot` is the parked terminal state for one workspace; every workspace
// that has ≥1 terminal stays in `byPath` (kept alive, like a background browser
// tab). No LRU cap: the live set is bounded by how many workspaces you actually
// have terminals in, and a workspace is pruned when its last terminal closes.

export type OrphanSessions = Record<string, { name: string; created: string }[]>;

export interface UseTerminalIntegrationArgs {
  /** Active workspace path (host owns; integration reacts to changes). */
  activePath: string | null;
  /** Active tab id (host owns; integration reads). */
  activeTabId: string | null;
  /** Host's full tab list (integration reads; manipulates via setters). */
  tabs: ReadonlyArray<Tab>;
  /** Host's tab list setter — terminal integration uses to add/remove its own tabs. */
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  /** Host's active-tab setter. */
  setActiveTabId: Dispatch<SetStateAction<string | null>>;
  /** Tab types declared ephemeral by other plugins (debugger, agent, ...).
   *  When restoring from saved settings, entries with these types are
   *  dropped to avoid ghosted indicators on reload. */
  ephemeralTabTypes?: ReadonlySet<string>;
  /** Mobile-narrow layout flag. Drives the mobile key bar / compose field. */
  isMobile: boolean;
  /** True once the host has loaded /api/settings. The integration must
   *  not write terminalTabs before this, or it would clobber server-side
   *  defaults. */
  settingsHydrated: boolean;
  /** Refresh repos/worktrees in the host. Triggered by terminal SSE
   *  lifecycle events (session-created/closed/adopted). */
  refreshWorkspaces: () => void | Promise<void>;
}

export interface TerminalIntegrationResult {
  /** Slots the host composes with other plugins. */
  integration: PluginIntegration;
  /** Tmux sessions outside known repos — surfaced in the workspace panel. */
  orphanSessions: OrphanSessions;
  /** Manual refresh trigger for the workspace panel. */
  refreshOrphanSessions: () => Promise<void>;
}

export function useTerminalIntegration(
  args: UseTerminalIntegrationArgs,
): TerminalIntegrationResult {
  const {
    activePath,
    activeTabId,
    tabs,
    setTabs,
    setActiveTabId,
    ephemeralTabTypes,
    isMobile,
    settingsHydrated,
    refreshWorkspaces,
  } = args;

  // "Flat" state = the *active* workspace's live terminal state. Alerts, SSE,
  // and layout persistence all read these as-is. Background workspaces live in
  // `byPath` (see below) and only render; they never feed the flat state until
  // they become active again.
  const [sessionMap, setSessionMap] = useState<Record<string, SessionInfo>>({});

  // ----- warm-workspace cache (instant switching) -----
  /** Parked snapshots for every workspace that has terminals, keyed by path.
   *  The active workspace is also snapshotted here continuously so it is
   *  available the instant `activePath` flips during a switch. No eviction:
   *  entries are added when a workspace gains terminals and removed when it
   *  loses its last one. */
  const [byPath, setByPath] = useState<Record<string, WarmSnapshot>>({});
  /** Which path the flat state currently represents. Lags `activePath` for one
   *  render during a switch; the render layer keys off this to stay
   *  remount-safe (see warmWorkspaces.ts). */
  const [flatPath, setFlatPath] = useState<string | null>(null);

  const [orphanSessions, setOrphanSessions] = useState<OrphanSessions>({});
  const [alertedPaths, setAlertedPaths] = useState<Set<string>>(new Set());
  const [alertedSessionIds, setAlertedSessionIds] = useState<Set<string>>(new Set());

  // Refs for SSE handler to avoid tearing down EventSource on every state change.
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const sessionMapRef = useRef(sessionMap);
  sessionMapRef.current = sessionMap;
  const ephemeralRef = useRef(ephemeralTabTypes);
  ephemeralRef.current = ephemeralTabTypes;
  // Read the latest snapshots inside the switch effect without making `byPath`
  // a dependency (which would re-run the switch logic on every snapshot write).
  const byPathRef = useRef(byPath);
  byPathRef.current = byPath;
  /** Paths whose last cold restore could NOT read saved settings. The tabs we
   *  built for them are a default-named guess, so the persistence effect must
   *  not write them back (it would clobber the real saved names on disk). */
  const restoreReadFailedRef = useRef<Record<string, boolean>>({});

  /** Path whose `fetchSessionsForPath` has resolved; powers `workspaceReady`. */
  const [restoredPath, setRestoredPath] = useState<string | null>(null);

  // ----- helpers -----

  const pathMatchesWorkspace = useCallback((workspacePath: string | null, alertPath: string) => {
    if (!workspacePath) return false;
    return alertPath === workspacePath || alertPath.startsWith(`${workspacePath}/`);
  }, []);

  // ----- continuously snapshot the active workspace into the warm cache -----
  // Keeping byPath[activePath] fresh means that the instant `activePath` flips
  // during a switch, the workspace we are leaving is already parked and renders
  // from its snapshot without unmounting its iframes. Guarded on
  // flatPath===activePath so we never key a snapshot under the wrong path while
  // a switch is mid-flight, and on restoredPath so the empty post-switch state
  // can't clobber a good snapshot.
  useEffect(() => {
    if (!activePath || flatPath !== activePath || restoredPath !== activePath) return;
    const terminalTabs = tabs.filter((t) => t.type === 'terminal');
    setByPath((prev) => {
      // No terminals → the workspace is inactive; nothing to keep alive. Prune
      // its entry (covers closing the last terminal in the active workspace).
      if (terminalTabs.length === 0) {
        if (!(activePath in prev)) return prev;
        const next = { ...prev };
        delete next[activePath];
        return next;
      }
      return {
        ...prev,
        // `allTabs` keeps the workspace's other tabs (browser pages, files)
        // in strip order so a warm switch back restores the whole strip.
        [activePath]: { sessions: sessionMap, tabs: terminalTabs, allTabs: [...tabs], activeTabId },
      };
    });
  }, [activePath, flatPath, restoredPath, sessionMap, tabs, activeTabId]);

  // ----- workspace switch: restore warm / fetch cold -----
  // useLayoutEffect (not useEffect) so a warm restore commits before paint: the
  // host clears tabs on switch, and we want the restored tabs/terminals on
  // screen in the same frame — no empty flash.
  useLayoutEffect(() => {
    const path = activePath;
    if (!path) {
      // Cleared (go-home / deleted active workspace): drop the flat state.
      setSessionMap({});
      setTabs([]);
      setActiveTabId(null);
      setFlatPath(null);
      return;
    }

    const snap = byPathRef.current[path];
    if (snap) {
      // WARM: the workspace is already alive (its iframes never unmounted).
      // Restore the flat state from its snapshot synchronously — instant, and
      // because every live workspace renders from a stable per-path snapshot,
      // no ttyd iframe is remounted. No server reconcile here: the iframes were
      // never torn down, so their sessions are already current; dead sessions
      // are pruned via the SSE `session-closed` handler instead.
      setSessionMap(snap.sessions);
      // The whole strip, not just terminals. Other integrations re-add their
      // own tabs too; the host's openTab is idempotent on id, so whichever
      // runs first wins and nothing is duplicated.
      setTabs(restoreTabsFromSnapshot(snap));
      setActiveTabId(snap.activeTabId);
      setFlatPath(path);
      setRestoredPath(path);
    } else {
      // COLD: clear the flat state and fetch (the previous behavior). flatPath
      // is set when the fetch resolves, so the render layer won't trust flat
      // for this path until its data has actually loaded.
      setSessionMap({});
      setTabs([]);
      setActiveTabId(null);
      void fetchSessionsForPath(path);
    }
    // Keyed on activePath only; the setters and fetchSessionsForPath are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // ----- session creation (used by handleCreateTab) -----

  const createSession = useCallback(
    async (cwd: string): Promise<string | null> => {
      const t0 = performance.now();
      const res = await fetch('/api/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) return null;
      const session: SessionInfo = await res.json();
      const createMs = Math.round(performance.now() - t0);
      console.log(`[perf] create-session API: ${createMs}ms`);
      track('terminal_tab_opened', { create_ms: createMs });
      setSessionMap((prev) => ({ ...prev, [session.id]: session }));
      return session.id;
    },
    [],
  );

  const handleCreateTab = useCallback(
    async (api: HostApi) => {
      if (!activePath) return;
      const sessionId = await createSession(activePath);
      if (!sessionId) return;
      const tab: Tab = { type: 'terminal', id: sessionId, name: `Term ${sessionId.slice(-4)}` };
      api.openTab(tab);
    },
    [activePath, createSession],
  );

  // "Open terminal here": a terminal tab in the active workspace whose shell
  // starts in `cwd` (named after that folder). A cwd outside the workspace is
  // ignored — its session would be listed under another workspace.
  useEffect(
    () =>
      on('omniterm:open-terminal', ({ cwd }) => {
        const root = activePathRef.current;
        if (!root || typeof cwd !== 'string' || !isInside(cwd, root)) return;
        void (async () => {
          const sessionId = await createSession(cwd);
          if (!sessionId || activePathRef.current !== root) return;
          const name = cwd === root ? `Term ${sessionId.slice(-4)}` : basename(cwd);
          setTabs((prev) =>
            prev.some((t) => t.id === sessionId)
              ? prev
              : [...prev, { type: 'terminal', id: sessionId, name }],
          );
          setActiveTabId(sessionId);
        })();
      }),
    [createSession, setTabs, setActiveTabId],
  );

  // ----- restore + reconcile sessions on workspace activate -----

  const fetchSessionsForPath = useCallback(
    async (dirPath: string) => {
      const res = await fetch(`/api/dir-sessions?cwd=${encodeURIComponent(dirPath)}`);
      if (!res.ok) return;
      const data: SessionInfo[] = await res.json();
      // The user may have switched workspaces while this was in flight. The
      // flat state belongs to whatever workspace is active now, so applying a
      // stale fetch would corrupt it (and remount the wrong terminals).
      if (activePathRef.current !== dirPath) return;
      const newMap: Record<string, SessionInfo> = {};
      for (const s of data) newMap[s.id] = s;
      const liveIds = new Set(data.map((s) => s.id));

      // Restore saved terminal tab order + names from server settings. Each
      // terminal tab is 1:1 with a live session (tab.id === sessionId), so we
      // keep only saved entries whose session is still alive; the rest of the
      // live sessions are appended as extras. (Legacy saved entries may carry a
      // `layout` field from the removed split-pane feature — ignored here.)
      let savedTabs: Tab[] | null = null;
      let settingsReadOk = false;
      try {
        const settingsRes = await fetch('/api/settings');
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          settingsReadOk = true;
          const saved = settings.terminalTabs?.[dirPath];
          if (Array.isArray(saved) && saved.length > 0) {
            const restored: Tab[] = [];
            for (const st of saved) {
              const type = typeof st.type === 'string' ? st.type : 'terminal';
              if (type !== 'terminal') continue; // only terminal restores here
              if (ephemeralRef.current?.has(type)) continue;
              if (!liveIds.has(st.id)) continue; // session gone → drop the tab
              restored.push({ type: 'terminal', id: st.id, name: st.name });
            }
            if (restored.length > 0) savedTabs = restored;
          }
        }
      } catch {}

      // The settings fetch is a second suspension point that reopened the
      // stale-switch window; re-check before committing any flat-state writes.
      if (activePathRef.current !== dirPath) return;

      // If saved settings couldn't be read, the tabs below are a default-named
      // guess — record it so the persistence effect won't write them back and
      // clobber the real saved names on disk.
      restoreReadFailedRef.current[dirPath] = !settingsReadOk;

      setSessionMap(newMap);
      setTabs((prevTabs) =>
        mergeRestoredTabs({ prevTabs, savedTabs, liveSessionIds: data.map((s) => s.id) }),
      );

      setActiveTabId((prev) => {
        if (prev && data.some((s) => s.id === prev)) return prev;
        return data.length > 0 ? data[0].id : null;
      });

      setRestoredPath(dirPath);
      // Flat state now genuinely represents `dirPath`; the render layer may
      // trust it for the active workspace from here.
      setFlatPath(dirPath);
    },
    [setTabs, setActiveTabId],
  );

  // ----- orphan sessions for the workspace panel -----

  const refreshOrphanSessions = useCallback(async () => {
    const res = await fetch('/api/discover-sessions');
    if (res.ok) setOrphanSessions(await res.json());
  }, []);

  useEffect(() => {
    void refreshOrphanSessions();
  }, [refreshOrphanSessions]);

  // ----- terminal-tab persistence -----

  /** Last terminal-tab list PUT per path. With instant warm switching the
   *  effect below re-fires on every switch (tabs/restoredPath change); this
   *  dirty-check keeps it from re-PUTting a workspace's unchanged tab list. */
  const lastTabsByPathRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!settingsHydrated || !activePath) return;
    // Don't persist until restoration has run for this workspace — otherwise
    // the empty `tabs` state right after a workspace switch (or page reload)
    // would clobber the saved tab list before fetchSessionsForPath reads it
    // back.
    if (restoredPath !== activePath) return;
    // Restore for this path failed to read saved settings, so the current tabs
    // are a default-named guess — writing them would clobber the real names.
    if (restoreReadFailedRef.current[activePath]) return;
    const entry = tabs
      .filter((t) => t.type === 'terminal')
      .map((t) => ({ id: t.id, name: t.name }));
    // Skip the write when this workspace's tab list is unchanged since we last
    // sent it — a warm switch back and forth must not re-PUT identical data.
    const serialized = JSON.stringify(entry);
    if (lastTabsByPathRef.current[activePath] === serialized) return;
    lastTabsByPathRef.current[activePath] = serialized;
    const persistedPath = activePath;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalTabs: { [persistedPath]: entry } }),
    })
      .then((res) => {
        // Only treat it as saved if the write succeeded — otherwise forget it so
        // the next switch/edit re-attempts. Without this a failed PUT would be
        // recorded as persisted and the dirty-check would suppress every retry,
        // silently losing the tab list on the next cold reload.
        if (!res.ok && lastTabsByPathRef.current[persistedPath] === serialized)
          delete lastTabsByPathRef.current[persistedPath];
      })
      .catch(() => {
        if (lastTabsByPathRef.current[persistedPath] === serialized)
          delete lastTabsByPathRef.current[persistedPath];
      });
  }, [settingsHydrated, activePath, tabs, restoredPath]);

  // Drop dead sessions from the ACTIVE workspace's flat state. Mirrors the
  // byPath prune so a `session-closed` event corrects whichever workspace holds
  // the session — the active one renders from flat, so without this a session
  // that dies on its own (shell exits, tmux killed) lingers as a dead pane.
  // Reads via refs since it runs from the SSE handler.
  const pruneFlatSessions = useCallback(
    (deadIds: Set<string>) => {
      const cur = sessionMapRef.current;
      if (!Object.keys(cur).some((id) => deadIds.has(id))) return;
      const newSessions = { ...cur };
      for (const id of deadIds) delete newSessions[id];
      const liveIds = new Set(Object.keys(newSessions));
      const nextTabs = survivingTerminalTabs(tabsRef.current, liveIds);
      setSessionMap(newSessions);
      setTabs(nextTabs);
      setActiveTabId((prev) =>
        prev && nextTabs.some((t) => t.id === prev) ? prev : (nextTabs[0]?.id ?? null),
      );
    },
    [setTabs, setActiveTabId],
  );

  // ----- session-* SSE -----

  useEffect(() => {
    let es: EventSource | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function resetWatchdog() {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (closed) return;
        console.warn('[alerts] SSE watchdog timeout, reconnecting');
        es?.close();
        connect();
      }, 45_000);
    }

    function connect() {
      if (closed) return;
      es = new EventSource('/api/events');
      es.onopen = () => {
        resetWatchdog();
      };
      es.onerror = () => {
        resetWatchdog();
      };
      es.onmessage = (e) => {
        resetWatchdog();
        try {
          const data = JSON.parse(e.data);

          const curActivePath = activePathRef.current;
          const curActiveTabId = activeTabIdRef.current;
          const curTabs = tabsRef.current;

          const curIsSessionVisible = (sessionId: string, path: string) => {
            if (!curActivePath || !(path === curActivePath || path.startsWith(`${curActivePath}/`)))
              return false;
            const activeTab = curTabs.find((tab) => tab.id === curActiveTabId);
            if (!activeTab || activeTab.type !== 'terminal') return false;
            return activeTab.id === sessionId;
          };
          const curPathMatches = (workspacePath: string | null, alertPath: string) => {
            if (!workspacePath) return false;
            return alertPath === workspacePath || alertPath.startsWith(`${workspacePath}/`);
          };

          if (
            data.type === 'session-created' ||
            data.type === 'session-closed' ||
            data.type === 'session-adopted'
          ) {
            if (data.type === 'session-closed') {
              // Keep the live set accurate without a per-switch reconcile. A
              // single close carries `sessionId`; a bulk close (worktree/repo
              // delete) carries only `worktreeId` + count, so resolve every
              // cached session tagged with that worktree (the server deleted
              // exactly those). Prune both the parked snapshots AND the active
              // flat state (the active workspace renders from flat).
              // NOTE: this relies on the SSE event arriving. A session created
              // out-of-band in a background workspace, or any event dropped
              // during an EventSource reconnect, is not reconciled here — an
              // accepted limitation of the no-per-switch-fetch design.
              let deadIds: Set<string>;
              if (data.sessionId) {
                deadIds = new Set([data.sessionId]);
              } else if (data.worktreeId && data.worktreeId !== '_orphan') {
                // Bulk worktree/repo delete: every cached session tagged with
                // this worktree is gone. Guard against the '_orphan' sentinel —
                // it is shared across unrelated workspaces, so matching it would
                // tear down every adopted terminal everywhere.
                deadIds = new Set<string>();
                for (const snap of Object.values(byPathRef.current))
                  for (const s of Object.values(snap.sessions))
                    if (s.worktreeId === data.worktreeId) deadIds.add(s.id);
                for (const s of Object.values(sessionMapRef.current))
                  if (s.worktreeId === data.worktreeId) deadIds.add(s.id);
              } else {
                deadIds = new Set();
              }
              if (deadIds.size > 0) {
                setByPath((prev) => pruneSessionsFromByPath(prev, deadIds));
                pruneFlatSessions(deadIds);
                setAlertedSessionIds((prev) => {
                  if (![...deadIds].some((id) => prev.has(id))) return prev;
                  const nextSet = new Set(prev);
                  for (const id of deadIds) nextSet.delete(id);
                  return nextSet;
                });
              }
            }
            void refreshWorkspaces();
            return;
          }

          if (data.type === 'session-silence' && data.path && data.sessionId) {
            const isActiveWorkspace = curPathMatches(curActivePath, data.path);
            const activeTabHasSession = curIsSessionVisible(data.sessionId, data.path);
            if (isActiveWorkspace && activeTabHasSession) return;
            if (!isActiveWorkspace) {
              setAlertedPaths((prev) => {
                const next = new Set(prev);
                next.add(data.path);
                return next;
              });
            }
            setAlertedSessionIds((prev) => {
              const next = new Set(prev);
              next.add(data.sessionId);
              return next;
            });
          }
        } catch (error) {
          console.error('[alerts] failed to process SSE message', error, e.data);
        }
      };
    }

    connect();
    return () => {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      es?.close();
    };
    // refreshWorkspaces is intentionally out of deps — handler reads via ref-stable identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss alerts when user switches to the alerted workspace.
  useEffect(() => {
    if (!activePath) return;
    setAlertedPaths((prev) => {
      const toRemove = [...prev].filter((p) => pathMatchesWorkspace(activePath, p));
      if (toRemove.length === 0) return prev;
      const next = new Set(prev);
      for (const p of toRemove) next.delete(p);
      return next;
    });
  }, [activePath, pathMatchesWorkspace]);

  // Drop alertedSessionIds when the matching session becomes visible.
  useEffect(() => {
    if (!activeTabId) return;
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab || activeTab.type !== 'terminal') return;
    // A terminal tab is 1:1 with a session (tab.id === sessionId).
    setAlertedSessionIds((prev) => {
      if (!prev.has(activeTab.id)) return prev;
      const next = new Set(prev);
      next.delete(activeTab.id);
      return next;
    });
  }, [activeTabId, tabs]);

  // Drop alertedSessionIds when the underlying session is gone.
  useEffect(() => {
    const liveSessionIds = new Set(Object.keys(sessionMap));
    setAlertedSessionIds((prev) => {
      const filtered = [...prev].filter((sid) => liveSessionIds.has(sid));
      return filtered.length === prev.size ? prev : new Set(filtered);
    });
  }, [sessionMap]);

  const alertedTabIds = useMemo(() => {
    // A terminal tab is 1:1 with a session (tab.id === sessionId), so an alerted
    // session maps to the tab of the same id when one exists.
    const terminalTabIds = new Set(
      tabs.filter((t) => t.type === 'terminal').map((t) => t.id),
    );
    const next = new Set<string>();
    for (const sessionId of alertedSessionIds) {
      if (sessionId !== activeTabId && terminalTabIds.has(sessionId)) next.add(sessionId);
    }
    return next;
  }, [alertedSessionIds, tabs, activeTabId]);

  // ----- close hook -----

  const onCloseTab = useCallback((tab: Tab) => {
    if (tab.type !== 'terminal') return;
    // A terminal tab is 1:1 with a session (tab.id === sessionId).
    setSessionMap((prev) => {
      const next = { ...prev };
      delete next[tab.id];
      return next;
    });
    fetch(`/api/sessions/${tab.id}`, { method: 'DELETE' });
  }, []);

  // No `mainContent`: terminal panes render in iframeTabsLayer so their ttyd
  // iframes stay mounted across tab switches.

  // Backs the mobile key bar / compose field. Each terminal iframe registers
  // itself by session id; `resolveTerminalWindow(id)` looks up a session's live
  // window at send time. Keying by session (not a sticky ref) means a
  // stale/closed iframe can never receive input meant for another tab: the entry
  // is deleted on unmount, and the caller passes the live active session id, so a
  // switch mid-load is a safe no-op (null) rather than a misdelivery.
  const iframesBySession = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // Stable per-session ref callback so a parent re-render doesn't detach/reattach
  // each iframe's ref every commit (React only re-runs a ref when its identity changes).
  const iframeRefCbs = useRef<Map<string, (el: HTMLIFrameElement | null) => void>>(new Map());
  const registerIframe = useCallback((sessionId: string, el: HTMLIFrameElement | null) => {
    const m = iframesBySession.current;
    if (el) {
      m.set(sessionId, el);
    } else {
      // Unmount: drop both the iframe and its cached ref callback so neither map
      // grows across the page's lifetime of opened/closed terminals.
      m.delete(sessionId);
      iframeRefCbs.current.delete(sessionId);
    }
  }, []);
  const iframeRefFor = useCallback(
    (sessionId: string) => {
      let cb = iframeRefCbs.current.get(sessionId);
      if (!cb) {
        cb = (el: HTMLIFrameElement | null) => registerIframe(sessionId, el);
        iframeRefCbs.current.set(sessionId, cb);
      }
      return cb;
    },
    [registerIframe],
  );
  const resolveTerminalWindow = useCallback(
    // reads a ref (.current) at call time — no render deps needed.
    (sessionId: string | null): Window | null =>
      sessionId ? (iframesBySession.current.get(sessionId)?.contentWindow ?? null) : null,
    [],
  );

  // ----- drop a file-tree path onto a terminal -----
  // The ttyd iframe swallows drag events, so while a tree row is being dragged
  // every visible terminal pane gets a transparent drop target on top of it.
  const [pathDragActive, setPathDragActive] = useState(false);
  const [dropTabId, setDropTabId] = useState<string | null>(null);
  useEffect(() => {
    const onStart = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(FILE_PATH_DRAG_MIME)) setPathDragActive(true);
    };
    const onEnd = () => {
      setPathDragActive(false);
      setDropTabId(null);
    };
    window.addEventListener('dragstart', onStart);
    window.addEventListener('dragend', onEnd);
    window.addEventListener('drop', onEnd);
    return () => {
      window.removeEventListener('dragstart', onStart);
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('drop', onEnd);
    };
  }, []);
  /** Type the shell-quoted path at the prompt (not run) and focus that terminal. */
  const pastePath = useCallback(
    (sessionId: string, absPath: string) => {
      const iframe = iframesBySession.current.get(sessionId);
      if (!sendData(iframe?.contentWindow, pathDropText(absPath))) return;
      setActiveTabId(sessionId);
      iframe?.focus();
    },
    [setActiveTabId],
  );

  const renderTerminalLayer = useCallback(
    (state: IframeTabsLayerState): ReactNode => {
      const { activeTabId } = state;
      // Where each visible tab renders (one pane, or two in a split view);
      // null = hidden but kept mounted.
      const styleFor = paneStyleResolver(state);
      // The active workspace's live state is the "flat" snapshot; every other
      // warm workspace renders from its parked snapshot in `byPath`. Rendering
      // them all through one path-keyed loop (visibility toggled via `display`)
      // is what keeps ttyd iframes mounted across workspace switches — the same
      // trick used for tabs within a workspace, lifted up a level.
      const flatSnap: WarmSnapshot = {
        sessions: sessionMap,
        tabs: tabs.filter((t) => t.type === 'terminal'),
        activeTabId,
      };
      const renderList = buildWarmRenderList<WarmSnapshot>({
        byPath,
        flat: flatSnap,
        flatPath,
        activePath,
      });
      if (renderList.length === 0) return null;

      // The host knows the active tab: position every terminal by the host's
      // layout (a browser page / file tab in front simply leaves the terminals
      // hidden or in the other pane). An activeTabId the host's list does not
      // know yet (mid-switch) is not "another tab" — the panes fall back to
      // their snapshot's active tab, full size, so the surface never blanks.
      const activeHostTab = tabs.find((t) => t.id === activeTabId);

      const styleInEntry = (entry: (typeof renderList)[number], tabId: string): CSSProperties | null => {
        if (!entry.visible) return null;
        const ownsActive = entry.data.tabs.some((t) => t.id === activeTabId);
        const hostLayout = ownsActive || (activeHostTab != null && activeHostTab.type !== 'terminal');
        if (hostLayout) return styleFor(tabId);
        return tabId === entry.data.activeTabId ? FULL_PANE_STYLE : null;
      };

      // Is the FOCUSED tab a visible terminal, and which session (null mid-load)?
      // One source of truth, so the mobile chrome's gate and its target can't
      // diverge. Only the visible workspace that owns activeTabId counts.
      let activeTerminalVisible = false;
      let activeSessionId: string | null = null;
      for (const entry of renderList) {
        if (!entry.visible) continue;
        if (!activeTabId || !entry.data.tabs.some((t) => t.id === activeTabId)) continue;
        if (!styleFor(activeTabId)) continue;
        activeTerminalVisible = true;
        if (entry.data.sessions[activeTabId]) activeSessionId = activeTabId; // tab.id === sessionId
      }

      return (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            // Lift the ttyd surfaces above the soft keyboard AND the mobile input
            // bar so the active prompt stays visible while typing. On Chrome iOS
            // a terminal (iframe) focus does NOT resize the layout viewport
            // (`100dvh` stays full), so the surface would otherwise sit behind the
            // keyboard; a parent-document focus (the compose box) DOES resize it,
            // and then this inset is 0 — no double shrink. The terminal panes are
            // absolutely positioned (inset:0 fills the *padding* box, ignoring any
            // ancestor paddingBottom), so the inset must be applied here as the
            // layer's own bottom. Var is published by MobileInputChrome (keyboard
            // height + its measured height); unset → 0px on desktop / no bar. The
            // bar itself is position:fixed, so shrinking this layer never moves it.
            bottom: 'var(--omniterm-terminal-bottom-inset, 0px)',
            // Click-through everywhere except over a visible terminal pane (the
            // other pane of a split may be a browser page or file underneath).
            pointerEvents: 'none',
          }}
        >
          {renderList.map((entry) => (
            <div
              key={entry.path}
              style={{
                position: 'absolute',
                inset: 0,
                display: entry.visible ? 'block' : 'none',
              }}
            >
              {entry.data.tabs.map((tab) => {
                const paneStyle = styleInEntry(entry, tab.id);
                // A terminal tab is 1:1 with a session (tab.id === sessionId).
                const session = entry.data.sessions[tab.id];

                return (
                  <div
                    key={tab.id}
                    data-terminal-tab={tab.id}
                    style={{
                      ...(paneStyle ?? FULL_PANE_STYLE),
                      display: paneStyle ? 'flex' : 'none',
                      flexDirection: 'column',
                      minWidth: 0,
                      minHeight: 0,
                      background: 'var(--bg, #1e1e1e)',
                      pointerEvents: 'auto',
                    }}
                  >
                    {session && pathDragActive && paneStyle && (
                      <div
                        className="ot-terminal-drop"
                        data-over={dropTabId === tab.id ? 'true' : undefined}
                        onDragOver={(e) => {
                          if (!e.dataTransfer.types.includes(FILE_PATH_DRAG_MIME)) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'copy';
                          if (dropTabId !== tab.id) setDropTabId(tab.id);
                        }}
                        onDragLeave={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTabId(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const p = e.dataTransfer.getData(FILE_PATH_DRAG_MIME);
                          if (p) pastePath(session.id, p);
                        }}
                      />
                    )}
                    {session ? (
                      <TerminalView
                        sessionId={session.id}
                        port={session.port}
                        ref={iframeRefFor(session.id)}
                      />
                    ) : (
                      <div
                        style={{
                          flex: 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--text-muted)',
                          fontSize: '14px',
                        }}
                      >
                        Loading…
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {isMobile && activeTerminalVisible && (
            // Gated by `activeTerminalVisible` (so it can't mount over a hidden
            // terminal). Stays mounted across a transient session-load gap;
            // `activeSessionId` (null mid-load) tells it which terminal to
            // target and when to reset on a real switch. Its own wrapper
            // re-enables pointer events (the layer root is click-through).
            <div style={{ pointerEvents: 'auto' }}>
              <MobileInputChrome
                activeSessionId={activeSessionId}
                getWindow={() => resolveTerminalWindow(activeSessionId)}
              />
            </div>
          )}
        </div>
      );
    },
    [
      tabs,
      sessionMap,
      byPath,
      flatPath,
      activePath,
      isMobile,
      iframeRefFor,
      resolveTerminalWindow,
      pathDragActive,
      dropTabId,
      pastePath,
    ],
  );

  // ----- assemble integration -----

  const tabTypeChoice = useMemo(
    () => ({
      type: 'terminal',
      label: 'Terminal',
      onCreate: (api: HostApi) => {
        void handleCreateTab(api);
      },
    }),
    [handleCreateTab],
  );

  const workspaceReady = activePath != null && restoredPath === activePath;

  const tabIcon = useCallback(
    (tab: Tab): ReactNode | null => (tab.type === 'terminal' ? <TerminalIcon size={14} /> : null),
    [],
  );

  const integration: PluginIntegration = useMemo(
    () => ({
      tabTypeChoice,
      onCloseTab,
      tabIcon,
      iframeTabsLayer: renderTerminalLayer,
      paneAware: true,
      alertedPaths,
      alertedTabIds,
      workspaceReady,
      onWorkspaceRefresh: refreshOrphanSessions,
    }),
    [
      tabTypeChoice,
      onCloseTab,
      tabIcon,
      renderTerminalLayer,
      alertedPaths,
      alertedTabIds,
      workspaceReady,
      refreshOrphanSessions,
    ],
  );

  return { integration, orphanSessions, refreshOrphanSessions };
}
