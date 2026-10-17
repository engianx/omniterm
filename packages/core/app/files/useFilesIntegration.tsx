'use client';

/**
 * Files as a plugin integration of the unified tab strip.
 *
 * One store per workspace (reset + rehydrated whenever `activePath` changes)
 * holds the open files, the tree, git status and the changes-only filter. Two
 * surfaces render from it:
 *   - `sidebarPanels[files]` — the tree, in the left sidebar;
 *   - `iframeTabsLayer`      — keep-alive viewer panes, one per open file,
 *                              shown only while that file's host tab is visible
 *                              (in the host's pane box: `paneStyleFor`).
 *
 * The store is the source of truth for which files are open; the host tab
 * strip is a mirror kept in step by one reconcile effect (see planReconcile).
 * User opens only touch the store; the reconcile opens the host tab (and
 * activates it when the open came from the user).
 *
 * Window events (app/events.ts): listens for 'omniterm:open-file' (paths in the
 * active workspace only) and 'omniterm:git-changed'; the tree emits
 * 'omniterm:open-terminal' and 'omniterm:open-workspace'.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { track } from '../telemetryClient';
import {
  paneStyleResolver,
  type HostApi,
  type IframeTabsLayerState,
  type PluginIntegration,
  type Tab,
} from '../types';
import { BranchIcon, FileIcon, FolderIcon, ImageIcon, PreviewIcon } from '../components/icons';
import ConfirmDialog from '../components/ConfirmDialog';
import { detectViewerKind } from '../../lib/previewable';
import { emit, on } from '../events';
import FileTree, { type DirEntry } from './FileTree';
import FilePane, { type DiffMode, type OpenFile } from './FilePane';
import { joinRel, parentOf, relativeTo, remapPath } from './fileOps';
import {
  FILE_TAB_TYPE,
  desiredHostTabs,
  fileTabId,
  orderByHost,
  parseFileTabId,
  parsePersisted,
  planReconcile,
  serializePersisted,
  type FileRef,
  type FileTabKind,
} from './fileTabs';

interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
}

export interface UseFilesIntegrationArgs {
  activePath: string | null;
  isMobile: boolean;
  settingsHydrated: boolean;
  tabs: ReadonlyArray<Tab>;
  activeTabId: string | null;
  host: HostApi;
  fileHandlers?: PluginIntegration['fileHandlers'];
  fileIndicatorPaths?: ReadonlySet<string>;
  /** Show a tab in the other pane of the split view ("Open to the side").
   *  Absent → the tree doesn't offer it. */
  openToSide?: (tabId: string) => void;
}

/** How long a closed/removed id is shielded from reconcile re-adds while the
 *  host and the store commit their halves of the close. */
const SUPPRESS_MS = 3000;

function blankFile(root: string, kind: FileTabKind, path: string): OpenFile {
  return {
    id: fileTabId(root, kind, path),
    path,
    kind,
    content: '',
    language: '',
    size: 0,
    originalContent: null,
    isDirty: false,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** A failed request's `{error}` message (or a generic one); null when ok. */
async function requestError(url: string, init: RequestInit): Promise<string | null> {
  try {
    const res = await fetch(url, init);
    if (res.ok) return null;
    const body = await res.json().catch(() => null);
    return typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`;
  } catch {
    return 'Could not reach the server';
  }
}

function postJson(url: string, body: unknown): Promise<string | null> {
  return requestError(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Files at or under `relPath`. */
const under = (f: { path: string }, relPath: string) => remapPath(f.path, relPath, relPath) !== null;

export function useFilesIntegration(args: UseFilesIntegrationArgs): { integration: PluginIntegration } {
  const {
    activePath,
    isMobile,
    settingsHydrated,
    tabs,
    activeTabId,
    host,
    fileHandlers,
    fileIndicatorPaths,
    openToSide,
  } = args;

  // ----- store -----
  const [files, setFiles] = useState<OpenFile[]>([]);
  /** activePath the current `files` were hydrated for (guards persistence and
   *  stale-tab pruning against the workspace-switch race). */
  const [hydratedPath, setHydratedPath] = useState<string | null>(null);
  const [tree, setTree] = useState<DirEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, DirEntry[]>>({});
  // A file to scroll to and flash in the tree; `seq` re-fires a repeat reveal.
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null);
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  const [changesOnly, setChangesOnly] = useState(false);
  /** Per-preview-tab reload nonce, keyed by tab id. */
  const [previewReload, setPreviewReload] = useState<Record<string, number>>({});
  const [closePrompt, setClosePrompt] = useState<{
    id: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [changesOnlyConfirm, setChangesOnlyConfirm] = useState(false);

  const editorContentRefs = useRef<Map<string, string>>(new Map());
  const filesRef = useRef(files);
  filesRef.current = files;
  const hostRef = useRef(host);
  hostRef.current = host;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const openToSideRef = useRef(openToSide);
  openToSideRef.current = openToSide;
  /** A file tab to put in the other pane once the host shows it. */
  const pendingSideRef = useRef<string | null>(null);
  /** Ids the user just closed (or we just removed): never re-added by reconcile. */
  const suppressedRef = useRef<Map<string, number>>(new Map());
  /** Ids whose next reconcile open should activate (a user-initiated open). */
  const activateOnOpenRef = useRef<Set<string>>(new Set());
  /** Last file tab the host showed as active (persisted as `active`). */
  const lastActiveRef = useRef<FileRef | null>(null);

  const suppress = (id: string) => suppressedRef.current.set(id, Date.now());

  const activeFile = useMemo(
    () => (activeTabId ? (files.find((f) => f.id === activeTabId) ?? null) : null),
    [files, activeTabId],
  );
  if (activeFile) lastActiveRef.current = { path: activeFile.path, kind: activeFile.kind };

  // ----- fetching -----

  const fetchDir = useCallback(
    async (subPath: string): Promise<DirEntry[]> => {
      if (!activePath) return [];
      const fullPath = subPath ? `${activePath}/${subPath}` : activePath;
      try {
        const res = await fetch(`/api/fs?path=${encodeURIComponent(fullPath)}&mode=list`);
        if (res.ok) return ((await res.json()).entries as DirEntry[]) ?? [];
      } catch {}
      return [];
    },
    [activePath],
  );

  /** Read one file as a source tab; with `withDiff`, also its HEAD version. */
  const fetchSource = useCallback(
    async (filePath: string, withDiff: boolean): Promise<OpenFile | null> => {
      if (!activePath) return null;
      const fullPath = `${activePath}/${filePath}`;
      try {
        const [fileRes, origRes] = await Promise.all([
          fetch(`/api/fs?path=${encodeURIComponent(fullPath)}&mode=read`),
          withDiff
            ? fetch(
                `/api/git/show?cwd=${encodeURIComponent(activePath)}&path=${encodeURIComponent(filePath)}`,
              )
            : Promise.resolve(null),
        ]);
        if (!fileRes.ok) return null;
        const data: FileContent = await fileRes.json();
        let originalContent: string | null = null;
        if (origRes?.ok) originalContent = (await origRes.json()).content;
        return {
          ...blankFile(activePath, 'source', filePath),
          content: data.content,
          language: data.language,
          size: data.size,
          originalContent,
        };
      } catch {
        return null;
      }
    },
    [activePath],
  );

  /** A diff tab's content from the git API. Never reads the file itself, so a
   *  file deleted in the working tree shows as an empty modified side. */
  const fetchDiff = useCallback(
    async (root: string, filePath: string, mode: DiffMode): Promise<OpenFile | null> => {
      const q = `cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(`${root}/${filePath}`)}`;
      try {
        const res = await fetch(`/api/git/diff?${q}${mode === 'staged' ? '&staged=1' : ''}`);
        if (!res.ok) return null;
        const d = await res.json();
        return {
          ...blankFile(root, 'diff', filePath),
          content: typeof d.modified === 'string' ? d.modified : '',
          originalContent: typeof d.original === 'string' ? d.original : '',
          language: typeof d.language === 'string' ? d.language : '',
          diffMode: mode,
        };
      } catch {
        return null;
      }
    },
    [],
  );

  const fetchGitStatus = useCallback(async () => {
    if (!activePath) return;
    try {
      const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(activePath)}`);
      if (res.ok && activePathRef.current === activePath) setGitStatus(await res.json());
    } catch {}
  }, [activePath]);

  // ----- workspace switch: reset, then hydrate persisted tabs -----

  useEffect(() => {
    // Drop the previous workspace's tabs from the strip (a no-op when the host
    // already cleared its list on the switch).
    for (const f of filesRef.current) {
      suppress(f.id);
      hostRef.current.removeTab(f.id);
    }
    setFiles([]);
    setTree([]);
    setExpandedDirs({});
    setGitStatus({});
    setPreviewReload({});
    setHydratedPath(null);
    editorContentRefs.current.clear();
    activateOnOpenRef.current.clear();
    lastActiveRef.current = null;
    if (!activePath || !settingsHydrated) return;

    const root = activePath;
    let cancelled = false;
    fetchDir('').then((entries) => !cancelled && setTree(entries));
    void fetchGitStatus();

    (async () => {
      try {
        const settings = await fetch('/api/settings').then((r) => r.json());
        if (cancelled) return;
        const persisted = parsePersisted(settings?.filePanelTabs?.[root]);
        // Hydrate is always non-diff: changes-only is an explicit per-session
        // toggle, so stale diffs are never restored.
        const sources = await Promise.all(
          persisted.open
            .filter((e) => e.kind === 'source' && !detectViewerKind(e.path))
            .map((e) => fetchSource(e.path, false)),
        );
        if (cancelled) return;
        const byPath = new Map(sources.flatMap((t) => (t ? [[t.path, t] as const] : [])));
        const restored: OpenFile[] = [];
        for (const e of persisted.open) {
          if (e.kind === 'preview' || detectViewerKind(e.path)) {
            // Previews and dedicated viewers fetch their own content on mount.
            restored.push(blankFile(root, e.kind, e.path));
          } else {
            const t = byPath.get(e.path);
            if (t) restored.push(t);
          }
        }
        for (const f of restored) suppressedRef.current.delete(f.id);
        setFiles(restored);
        const active = persisted.active
          ? (persisted.open.find((o) => `${o.kind}::${o.path}` === persisted.active) ?? null)
          : null;
        lastActiveRef.current = active;
      } catch {
        // fall through: an unreadable settings file just means no restored tabs
      }
      if (!cancelled) setHydratedPath(root);
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the workspace; fetchers are derived from activePath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, settingsHydrated]);

  // ----- reconcile store → host strip -----

  useEffect(() => {
    const now = Date.now();
    for (const [id, at] of suppressedRef.current) {
      if (now - at > SUPPRESS_MS) suppressedRef.current.delete(id);
    }
    // Until the store is hydrated for THIS workspace, `files` may still be the
    // previous workspace's (the render that switches activePath runs this
    // effect before the reset lands) — touch nothing then.
    const ready = activePath !== null && hydratedPath === activePath;
    if (activePath !== null && !ready) return;
    const desired = ready ? desiredHostTabs(activePath, files) : [];
    const plan = planReconcile({
      desired,
      hostTabs: tabs,
      suppressed: new Set(suppressedRef.current.keys()),
      pruneStale: true,
    });
    const h = hostRef.current;
    for (const id of plan.remove) h.removeTab(id);
    for (const { tab, after } of plan.open) {
      const activate = activateOnOpenRef.current.delete(tab.id);
      h.openTab(tab, after ? { activate, after } : { activate });
    }
    for (const { id, patch } of plan.update) h.updateTab(id, patch);
  }, [files, tabs, activePath, hydratedPath]);

  // ----- persistence (per workspace) -----

  const persistKey = useMemo(() => {
    if (!activePath || hydratedPath !== activePath) return null;
    const ordered = orderByHost(files, (f) => f.id, tabs);
    return JSON.stringify(
      serializePersisted(
        ordered.map((f) => ({ path: f.path, kind: f.kind })),
        lastActiveRef.current,
      ),
    );
    // activeTabId: re-evaluate the persisted `active` when the user switches tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, hydratedPath, files, tabs, activeTabId]);

  const lastPersistedRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!persistKey || !activePath) return;
    if (lastPersistedRef.current[activePath] === persistKey) return;
    lastPersistedRef.current[activePath] = persistKey;
    const dir = activePath;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePanelTabs: { [dir]: JSON.parse(persistKey) } }),
    })
      .then((res) => {
        if (!res.ok && lastPersistedRef.current[dir] === persistKey) delete lastPersistedRef.current[dir];
      })
      .catch(() => {
        if (lastPersistedRef.current[dir] === persistKey) delete lastPersistedRef.current[dir];
      });
  }, [persistKey, activePath]);

  // ----- tree refresh: SSE files-changed, window focus -----

  const refreshTree = useCallback(async () => {
    if (!activePath) return;
    const root = activePath;
    const rootEntries = await fetchDir('');
    if (activePathRef.current !== root) return;
    setTree(rootEntries);
    void fetchGitStatus();
    setExpandedDirs((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      Promise.all(keys.map((d) => fetchDir(d).then((entries) => [d, entries] as const))).then(
        (results) => {
          if (activePathRef.current !== root) return;
          setExpandedDirs((p) => {
            const next = { ...p };
            // Only refresh dirs that are still expanded.
            for (const [d, entries] of results) if (d in next) next[d] = entries;
            return next;
          });
        },
      );
      return prev;
    });
  }, [activePath, fetchDir, fetchGitStatus]);

  useEffect(() => {
    if (!activePath) return;
    window.addEventListener('focus', refreshTree);
    return () => window.removeEventListener('focus', refreshTree);
  }, [activePath, refreshTree]);

  useEffect(() => {
    if (!activePath) return;
    let es: EventSource | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function resetWatchdog() {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (closed) return;
        console.warn('[files] SSE watchdog timeout, reconnecting');
        es?.close();
        connect();
      }, 45_000);
    }

    function connect() {
      if (closed) return;
      es = new EventSource('/api/events');
      es.onopen = () => resetWatchdog();
      es.onerror = () => resetWatchdog();
      es.onmessage = (e) => {
        resetWatchdog();
        try {
          const { type } = JSON.parse(e.data);
          if (type === 'files-changed') void refreshTree();
        } catch {}
      };
    }

    connect();
    return () => {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      es?.close();
    };
  }, [activePath, refreshTree]);

  // Auto-expand directories holding changed files when entering changes mode.
  useEffect(() => {
    if (!changesOnly) return;
    const dirs = new Set<string>();
    for (const p of Object.keys(gitStatus)) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const dir of dirs) {
      if (expandedDirs[dir] === undefined) {
        void fetchDir(dir).then((entries) => setExpandedDirs((prev) => ({ ...prev, [dir]: entries })));
      }
    }
  }, [changesOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDir = useCallback(
    (dir: string) => {
      if (expandedDirs[dir]) {
        setExpandedDirs((prev) => {
          const next = { ...prev };
          delete next[dir];
          return next;
        });
      } else {
        setExpandedDirs((prev) => ({ ...prev, [dir]: [] }));
        void fetchDir(dir).then((entries) => setExpandedDirs((prev) => ({ ...prev, [dir]: entries })));
      }
    },
    [expandedDirs, fetchDir],
  );

  // ----- open / close / save -----

  /** Add a file to the store and have reconcile open (and, unless `activate`
   *  is false, activate) its host tab; if it is already open, just focus it. */
  const showFile = useCallback((f: OpenFile, activate = true) => {
    suppressedRef.current.delete(f.id);
    const existing = filesRef.current.some((x) => x.id === f.id);
    if (existing) {
      if (activate) hostRef.current.activateTab(f.id);
      return;
    }
    if (activate) activateOnOpenRef.current.add(f.id);
    setFiles((prev) => {
      if (prev.some((x) => x.id === f.id)) return prev;
      if (f.kind === 'source') return [...prev, f];
      // Previews and diffs sit right after their source in the store too (persist order).
      const srcIdx = prev.findIndex((x) => x.kind === 'source' && x.path === f.path);
      return srcIdx === -1 ? [...prev, f] : [...prev.slice(0, srcIdx + 1), f, ...prev.slice(srcIdx + 1)];
    });
  }, []);

  const openFile = useCallback(
    async (filePath: string, activate = true) => {
      const root = activePathRef.current;
      if (!root) return;
      const id = fileTabId(root, 'source', filePath);
      if (filesRef.current.some((f) => f.id === id)) {
        showFile(blankFile(root, 'source', filePath), activate);
        return;
      }
      // Image/PDF/CSV open in a dedicated viewer that streams the raw route
      // itself — skip the text read (garbage for binary files).
      const viewerKind = detectViewerKind(filePath);
      if (viewerKind) {
        showFile(blankFile(root, 'source', filePath), activate);
        track('file_opened_viewer', { kind: viewerKind });
        return;
      }
      const tab = await fetchSource(filePath, changesOnly);
      if (activePathRef.current !== root) return;
      if (!tab) {
        console.error(`[files] failed to open ${filePath}`);
        return;
      }
      showFile(tab, activate);
      track('file_opened_editor', { language: tab.language || 'plaintext' });
    },
    [fetchSource, changesOnly, showFile],
  );

  /** "Open to the side": open the file without focusing it, then hand its
   *  tab to the split view once the host strip has it (effect below). */
  const openFileToSide = useCallback(
    (filePath: string) => {
      const root = activePathRef.current;
      if (!root) return;
      const id = fileTabId(root, 'source', filePath);
      if (tabsRef.current.some((t) => t.id === id)) {
        openToSideRef.current?.(id);
        return;
      }
      pendingSideRef.current = id;
      void openFile(filePath, false);
    },
    [openFile],
  );

  useEffect(() => {
    const id = pendingSideRef.current;
    if (!id || !tabs.some((t) => t.id === id)) return;
    pendingSideRef.current = null;
    openToSideRef.current?.(id);
  }, [tabs]);

  /** Open (or refresh and focus) a read-only diff tab for a file. */
  const openDiff = useCallback(
    async (filePath: string, mode: DiffMode) => {
      const root = activePathRef.current;
      if (!root) return;
      const tab = await fetchDiff(root, filePath, mode);
      if (activePathRef.current !== root) return;
      if (!tab) {
        console.error(`[files] failed to load changes for ${filePath}`);
        return;
      }
      setFiles((prev) => prev.map((f) => (f.id === tab.id ? tab : f)));
      showFile(tab);
    },
    [fetchDiff, showFile],
  );

  // Diff tabs show git state at one moment: re-read them when it changes.
  const refreshDiffs = useCallback(async () => {
    const root = activePathRef.current;
    if (!root) return;
    const diffs = filesRef.current.filter((f) => f.kind === 'diff');
    const fresh = await Promise.all(diffs.map((f) => fetchDiff(root, f.path, f.diffMode ?? 'worktree')));
    if (activePathRef.current !== root) return;
    const byId = new Map(fresh.flatMap((t) => (t ? [[t.id, t] as const] : [])));
    if (byId.size === 0) return;
    setFiles((prev) => prev.map((f) => byId.get(f.id) ?? f));
  }, [fetchDiff]);

  useEffect(
    () =>
      on('omniterm:git-changed', () => {
        void fetchGitStatus();
        void refreshDiffs();
      }),
    [fetchGitStatus, refreshDiffs],
  );

  // Other areas (Changes list, terminal links...) open files by absolute path.
  useEffect(
    () =>
      on('omniterm:open-file', ({ path, diff }) => {
        const root = activePathRef.current;
        const rel = root && typeof path === 'string' ? relativeTo(root, path) : null;
        if (!rel) return;
        if (diff) void openDiff(rel, diff);
        else void openFile(rel);
      }),
    [openDiff, openFile],
  );

  // "Reveal in Files": switch to the tree, load every ancestor folder, then
  // hand the tree the path to scroll to once its row exists.
  useEffect(
    () =>
      on('omniterm:reveal-file', ({ path }) => {
        const root = activePathRef.current;
        const rel = root && typeof path === 'string' ? relativeTo(root, path) : null;
        if (!rel) return;
        emit('omniterm:show-sidebar', { section: 'files' });
        const parts = rel.split('/');
        const dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
        void Promise.all(dirs.map(fetchDir)).then((loaded) => {
          if (activePathRef.current !== root) return;
          setExpandedDirs((prev) => {
            const next = { ...prev };
            dirs.forEach((d, i) => (next[d] = loaded[i]));
            return next;
          });
          setReveal((prev) => ({ path: rel, seq: (prev?.seq ?? 0) + 1 }));
        });
      }),
    [fetchDir],
  );

  const openPreview = useCallback(
    (filePath: string) => {
      const root = activePathRef.current;
      if (!root) return;
      showFile(blankFile(root, 'preview', filePath));
    },
    [showFile],
  );

  const dropFromStore = useCallback((id: string) => {
    setFiles((prev) => (prev.some((f) => f.id === id) ? prev.filter((f) => f.id !== id) : prev));
    editorContentRefs.current.delete(id);
    activateOnOpenRef.current.delete(id);
    setPreviewReload((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    setFiles((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      if (idx === -1 || prev[idx].isDirty === dirty) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], isDirty: dirty };
      return next;
    });
  }, []);

  const save = useCallback(
    async (id: string, filePath: string, content: string) => {
      const root = activePathRef.current;
      if (!root) throw new Error('no workspace');
      const res = await fetch('/api/fs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `${root}/${filePath}`, content }),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      // FileViewer clears its own dirty flag after onSave resolves, but the
      // close dialog's "Save & Close" calls this directly.
      setDirty(id, false);
      // Re-fetch any open preview of the same file.
      const previewId = fileTabId(root, 'preview', filePath);
      setPreviewReload((prev) => ({ ...prev, [previewId]: (prev[previewId] ?? 0) + 1 }));
    },
    [setDirty],
  );

  // ----- file operations (tree context menu) -----

  const expandDir = useCallback(
    (dir: string) => {
      if (expandedDirs[dir] === undefined) toggleDir(dir);
    },
    [expandedDirs, toggleDir],
  );

  const createEntry = useCallback(
    async (parent: string, name: string, kind: 'file' | 'folder'): Promise<string | null> => {
      const root = activePathRef.current;
      if (!root) return 'No workspace';
      const rel = joinRel(parent, name);
      const err = await postJson(kind === 'file' ? '/api/fs/create' : '/api/fs/mkdir', {
        path: `${root}/${rel}`,
      });
      if (err) return err;
      await refreshTree();
      if (kind === 'file') void openFile(rel);
      return null;
    },
    [refreshTree, openFile],
  );

  const renameEntry = useCallback(
    async (from: string, newName: string): Promise<string | null> => {
      const root = activePathRef.current;
      if (!root) return 'No workspace';
      const to = joinRel(parentOf(from), newName);
      const moved = filesRef.current.filter((f) => under(f, from));
      // An open editor's unsaved edits belong to the old path; don't strand them.
      if (moved.some((f) => f.isDirty)) return 'Save or close its open files with unsaved changes first';
      const err = await postJson('/api/fs/rename', { from: `${root}/${from}`, to: `${root}/${to}` });
      if (err) return err;
      if (activePathRef.current !== root) return null;
      // Re-key the moved tabs in place: open each new id right after its old
      // one (keeping focus), then drop the old id.
      const next = filesRef.current.map((f) => {
        const p = remapPath(f.path, from, to);
        return p === null ? f : { ...f, path: p, id: fileTabId(root, f.kind, p) };
      });
      const desired = new Map(desiredHostTabs(root, next).map((t) => [t.id, t]));
      const h = hostRef.current;
      for (const f of moved) {
        const tab = desired.get(fileTabId(root, f.kind, remapPath(f.path, from, to)!));
        suppress(f.id);
        editorContentRefs.current.delete(f.id);
        if (tab) h.openTab(tab, { after: f.id, activate: f.id === activeTabIdRef.current });
        h.removeTab(f.id);
      }
      setFiles(next);
      setExpandedDirs((prev) => {
        const out: Record<string, DirEntry[]> = {};
        for (const [d, entries] of Object.entries(prev)) out[remapPath(d, from, to) ?? d] = entries;
        return out;
      });
      await refreshTree();
      return null;
    },
    [refreshTree],
  );

  const deleteEntry = useCallback(
    async (relPath: string): Promise<string | null> => {
      const root = activePathRef.current;
      if (!root) return 'No workspace';
      const err = await requestError(`/api/fs?path=${encodeURIComponent(`${root}/${relPath}`)}`, {
        method: 'DELETE',
      });
      if (err) return err;
      if (activePathRef.current !== root) return null;
      for (const f of filesRef.current.filter((x) => under(x, relPath))) {
        suppress(f.id);
        hostRef.current.removeTab(f.id);
        dropFromStore(f.id);
      }
      setExpandedDirs((prev) => {
        const out: Record<string, DirEntry[]> = {};
        for (const [d, entries] of Object.entries(prev)) if (!under({ path: d }, relPath)) out[d] = entries;
        return out;
      });
      await refreshTree();
      return null;
    },
    [refreshTree, dropFromStore],
  );

  const dirtyCountUnder = useCallback(
    (relPath: string) => filesRef.current.filter((f) => f.isDirty && under(f, relPath)).length,
    [],
  );

  const rememberContent = useCallback((id: string, content: string) => {
    editorContentRefs.current.set(id, content);
  }, []);

  const reloadPreview = useCallback((id: string) => {
    setPreviewReload((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  // Toggling changes-only drops every file tab: diff and edit views need
  // different server data and we don't silently reload them all.
  const performChangesOnlyToggle = useCallback(() => {
    setChangesOnly((v) => !v);
    for (const f of filesRef.current) {
      suppress(f.id);
      hostRef.current.removeTab(f.id);
    }
    setFiles([]);
    editorContentRefs.current.clear();
    activateOnOpenRef.current.clear();
    setPreviewReload({});
  }, []);

  const toggleChangesOnly = useCallback(() => {
    if (filesRef.current.some((f) => f.isDirty)) setChangesOnlyConfirm(true);
    else performChangesOnlyToggle();
  }, [performChangesOnlyToggle]);

  // ----- host-facing slots -----

  const beforeCloseTab = useCallback((tab: Tab): boolean | Promise<boolean> => {
    if (tab.type !== FILE_TAB_TYPE) return true;
    const f = filesRef.current.find((x) => x.id === tab.id);
    if (!f?.isDirty) {
      suppress(tab.id);
      return true;
    }
    return new Promise<boolean>((resolve) => {
      setClosePrompt((cur) => {
        cur?.resolve(false); // a second prompt supersedes (cancels) the first
        return {
          id: tab.id,
          resolve: (ok) => {
            if (ok) suppress(tab.id);
            resolve(ok);
          },
        };
      });
    });
  }, []);

  const onCloseTab = useCallback(
    (tab: Tab) => {
      if (tab.type !== FILE_TAB_TYPE) return;
      suppress(tab.id);
      dropFromStore(tab.id);
    },
    [dropFromStore],
  );

  const tabIcon = useCallback(
    (tab: Tab) => {
      if (tab.type !== FILE_TAB_TYPE) return null;
      const parsed = parseFileTabId(tab.id);
      if (!parsed) return <FileIcon size={14} />;
      if (parsed.kind === 'preview') return <PreviewIcon size={14} />;
      if (parsed.kind === 'diff') return <BranchIcon size={14} />;
      if (detectViewerKind(parsed.absPath)) return <ImageIcon size={14} />;
      return <FileIcon size={14} />;
    },
    [],
  );

  const closePromptFile = closePrompt ? files.find((f) => f.id === closePrompt.id) : undefined;

  const dialogs = (
    <>
      {closePrompt &&
        createPortal(
          <ConfirmDialog
            title="Unsaved Changes"
            message={`"${closePromptFile?.path ?? parseFileTabId(closePrompt.id)?.absPath ?? closePrompt.id}" has unsaved changes.`}
            buttons={[
              {
                label: 'Save & Close',
                primary: true,
                action: async () => {
                  const p = closePrompt;
                  const f = filesRef.current.find((x) => x.id === p.id);
                  if (!f) {
                    p.resolve(true);
                    return;
                  }
                  const content = editorContentRefs.current.get(f.id) ?? f.content;
                  try {
                    await save(f.id, f.path, content);
                  } catch (err) {
                    // Keep the tab — closing it now would lose the edits.
                    console.error('[files] save failed:', err);
                    return; // onClose below resolves false
                  }
                  p.resolve(true);
                },
              },
              {
                label: 'Discard',
                danger: true,
                action: () => closePrompt.resolve(true),
              },
              { label: 'Cancel', action: () => closePrompt.resolve(false) },
            ]}
            // ConfirmDialog calls onClose after every button too; resolving an
            // already-settled promise is a no-op, so this only lands for
            // Cancel / backdrop / failed save.
            onClose={() => {
              closePrompt.resolve(false);
              setClosePrompt(null);
            }}
          />,
          document.body,
        )}
      {changesOnlyConfirm &&
        createPortal(
          <ConfirmDialog
            title="Unsaved Changes"
            message={`Switching mode will discard unsaved changes in ${files.filter((f) => f.isDirty).length} file(s).`}
            buttons={[
              { label: 'Discard & Switch', danger: true, action: performChangesOnlyToggle },
              { label: 'Cancel', action: () => {} },
            ]}
            onClose={() => setChangesOnlyConfirm(false)}
          />,
          document.body,
        )}
    </>
  );

  const iframeTabsLayer = (state: IframeTabsLayerState) => {
    if (!activePath && !closePrompt && !changesOnlyConfirm) return null;
    const styleFor = paneStyleResolver(state);
    return (
      <Fragment key="files-layer">
        {activePath &&
          hydratedPath === activePath &&
          files.map((f) => (
            <FilePane
              key={f.id}
              file={f}
              dirPath={activePath}
              paneStyle={styleFor(f.id)}
              diff={f.kind === 'diff' || (changesOnly && f.originalContent !== null)}
              reloadKey={previewReload[f.id]}
              onDirty={setDirty}
              onSave={save}
              onContentChange={rememberContent}
              onOpenPreview={openPreview}
              onReloadPreview={reloadPreview}
            />
          ))}
        {dialogs}
      </Fragment>
    );
  };

  const sidebarPanels = [
    {
      id: 'files',
      label: 'Files',
      icon: <FolderIcon size={16} />,
      render: ({ isMobile: mobile, closeSidebar }: { isMobile: boolean; closeSidebar: () => void }) => {
        // Opening something on a phone hides the overlay sidebar to show it.
        const thenClose =
          <A extends unknown[]>(fn: (...a: A) => void) =>
          (...a: A) => {
            fn(...a);
            if (mobile || isMobile) closeSidebar();
          };
        return (
          <FileTree
            rootPath={activePath}
            tree={tree}
            expandedDirs={expandedDirs}
            gitStatus={gitStatus}
            changesOnly={changesOnly}
            activeRelPath={activeFile?.path ?? null}
            reveal={reveal}
            fileHandlers={fileHandlers}
            fileIndicatorPaths={fileIndicatorPaths ?? EMPTY_SET}
            host={host}
            canSplit={!!openToSide && !(mobile || isMobile)}
            draggable={!(mobile || isMobile)}
            onToggleDir={toggleDir}
            onExpandDir={expandDir}
            onOpenFile={thenClose((p: string) => void openFile(p))}
            onOpenPreview={thenClose(openPreview)}
            onOpenToSide={openFileToSide}
            onOpenDiff={thenClose((p: string, mode: DiffMode) => void openDiff(p, mode))}
            onOpenTerminal={thenClose((cwd: string) => emit('omniterm:open-terminal', { cwd }))}
            onOpenWorkspace={thenClose((path: string) => emit('omniterm:open-workspace', { path }))}
            onCreate={createEntry}
            onRename={renameEntry}
            onDelete={deleteEntry}
            dirtyCountUnder={dirtyCountUnder}
            onToggleChangesOnly={toggleChangesOnly}
            onRefresh={() => void refreshTree()}
          />
        );
      },
    },
  ];

  return {
    integration: {
      beforeCloseTab,
      onCloseTab,
      tabIcon,
      iframeTabsLayer,
      paneAware: true,
      sidebarPanels,
      // Files restore themselves from `filePanelTabs`; the host must not.
      ephemeralTabTypes: FILE_EPHEMERAL,
    },
  };
}

const FILE_EPHEMERAL: ReadonlySet<string> = new Set([FILE_TAB_TYPE]);
