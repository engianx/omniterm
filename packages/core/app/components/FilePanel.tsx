'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { track } from '../telemetryClient';
import FileViewer from './FileViewer';
import DiffViewer from './DiffViewer';
import FileTabBar, { type FileTabKind } from './FileTabBar';
import PreviewPane from './PreviewPane';
import DedicatedViewer from './DedicatedViewer';
import ConfirmDialog from './ConfirmDialog';
import TopBar, { topBarActionStyle } from './TopBar';
import { ResizeHandle, type DragInfo } from './ResizeHandle';
import { isPreviewable, detectViewerKind } from '../../lib/previewable';

interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
}

interface FileTab {
  /** Composite tab id: "${kind}::${path}". Stable across renders and used as the React key + active selector. */
  id: string;
  /** Path relative to dirPath. May be shared by a source/preview pair. */
  path: string;
  /** "source" = editor (FileViewer/DiffViewer), "preview" = rendered iframe. */
  kind: FileTabKind;
  content: string;
  language: string;
  size: number;
  /** HEAD content for diff view (changesOnly mode). null if not in diff mode or git-show failed. */
  originalContent: string | null;
  isDirty: boolean;
}

function tabId(kind: FileTabKind, filePath: string): string {
  return `${kind}::${filePath}`;
}

interface Props {
  dirPath: string;
  width: number;
  isMobile?: boolean;

  onClose?: () => void;
  onWidthChange: (width: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /**
   * Plugin-contributed file-context-menu entries. For each entry, if
   * the right-clicked file's basename matches `pattern` (glob with `*`),
   * the menu shows `label`; clicking invokes `onSelect(absPath)`.
   */
  fileHandlers?: ReadonlyArray<{
    pattern: string;
    label: string;
    onSelect: (absPath: string) => void;
  }>;
  /**
   * Absolute paths that should render a small indicator next to the
   * filename (e.g. files currently open in a plugin tab). Undefined or
   * empty set → no indicators.
   */
  fileIndicatorPaths?: Set<string>;
}

/**
 * Match a basename against a glob-like pattern ("*.test.yaml" etc.).
 * Only `*` is supported; other regex chars are escaped.
 */
function matchesGlob(pattern: string, basename: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(basename);
}

const MIN_WIDTH = 250;
const MAX_WIDTH = 9999; // capped dynamically in resize handler
const MAX_TREE_WIDTH = 640;

function gitStatusColor(xy: string | undefined): string | undefined {
  if (!xy) return undefined;
  if (xy === '??') return 'var(--success, #3fb950)';
  if (xy[0] === 'A' || xy[1] === 'A') return 'var(--success, #3fb950)';
  if (xy[0] === 'D' || xy[1] === 'D') return 'var(--danger, #f85149)';
  if (xy[0] === 'M' || xy[1] === 'M') return 'var(--warning, #d29922)';
  if (xy[0] === 'R') return 'var(--warning, #d29922)';
  return undefined;
}

function buildDirStatus(gitStatus: Record<string, string>): Record<string, string> {
  const dirColors: Record<string, string> = {};
  for (const [filePath, xy] of Object.entries(gitStatus)) {
    const color = gitStatusColor(xy);
    if (!color) continue;
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirColors[dir]) dirColors[dir] = color;
    }
  }
  return dirColors;
}

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

function ContextMenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{
        ...S.contextMenuItem,
        background: hover ? 'var(--accent)' : 'transparent',
        color: hover ? 'var(--text-bright)' : 'var(--text)',
      }}
      onClick={onClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {children}
    </div>
  );
}

export default function FilePanel({
  dirPath,
  width,
  isMobile,
  onClose,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
  fileHandlers,
  fileIndicatorPaths,
}: Props) {
  const [tree, setTree] = useState<DirEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, DirEntry[]>>({});
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // dirPath the current `tabs` were loaded for; guards persist effect against the workspace-switch stale-closure race.
  const [hydratedDirPath, setHydratedDirPath] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<string | null>(null);
  const [changesOnlyConfirm, setChangesOnlyConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mobileView, setMobileView] = useState<'tree' | 'editor'>('tree');
  const editorContentRefs = useRef<Map<string, string>>(new Map());
  /** Per-tab nonce; bumped when the user reloads a preview. Keyed by tab id. */
  const [previewReload, setPreviewReload] = useState<Record<string, number>>({});
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    path: string;
    kind: FileTabKind;
  } | null>(null);
  const [treeWidth, setTreeWidth] = useState(220);
  const containerRef = useRef<HTMLDivElement>(null);
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  const [changesOnly, setChangesOnly] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    absPath: string;
    relPath: string;
  } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const hasTabs = tabs.length > 0;
  const activeTab = activeTabId ? (tabs.find((t) => t.id === activeTabId) ?? null) : null;
  // Sidebar selection / fileIndicator highlights track the active SOURCE
  // file's path. (Preview tabs share the path; treating them the same in
  // the tree avoids the selection jumping when the user toggles preview.)
  const activeTabPath = activeTab?.path ?? null;

  const openContextMenu = useCallback(
    (clientX: number, clientY: number, relPath: string) => {
      const absPath = relPath ? `${dirPath}/${relPath}` : dirPath;
      const MENU_W = 180;
      // Estimate height from the visible item count so we don't clip the
      // menu off the bottom of the viewport when a file matches multiple
      // plugin handlers. Items render at ~32px; "Copy path", an optional
      // "Open Preview", and every matching handler each contribute one item.
      const basename = absPath.split('/').pop() ?? '';
      const matching = (fileHandlers ?? []).filter((h) => matchesGlob(h.pattern, basename)).length;
      const previewable = relPath && isPreviewable(relPath) ? 1 : 0;
      const MENU_ITEM_H = 32;
      const menuH = (1 + previewable + matching) * MENU_ITEM_H + 8;
      const x = Math.min(clientX, window.innerWidth - MENU_W - 8);
      const y = Math.min(clientY, window.innerHeight - menuH - 8);
      setContextMenu({ x: Math.max(0, x), y: Math.max(0, y), absPath, relPath });
    },
    [dirPath, fileHandlers],
  );

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [tabContextMenu]);

  const fetchDir = useCallback(
    async (subPath: string) => {
      const fullPath = subPath ? `${dirPath}/${subPath}` : dirPath;
      const res = await fetch(`/api/fs?path=${encodeURIComponent(fullPath)}&mode=list`);
      if (res.ok) {
        const data = await res.json();
        return data.entries as DirEntry[];
      }
      return [];
    },
    [dirPath],
  );

  /**
   * Fetch a single file and return a FileTab (or null on failure).
   * In changesOnly mode, also fetches the HEAD version for diff view.
   */
  const fetchFileTab = useCallback(
    async (filePath: string, withDiff: boolean): Promise<FileTab | null> => {
      const fullPath = `${dirPath}/${filePath}`;
      try {
        if (withDiff) {
          const [fileRes, origRes] = await Promise.all([
            fetch(`/api/fs?path=${encodeURIComponent(fullPath)}&mode=read`),
            fetch(
              `/api/git/show?cwd=${encodeURIComponent(dirPath)}&path=${encodeURIComponent(filePath)}`,
            ),
          ]);
          if (!fileRes.ok) return null;
          const data: FileContent = await fileRes.json();
          let originalContent: string | null = null;
          if (origRes.ok) {
            const orig = await origRes.json();
            originalContent = orig.content;
          }
          return {
            id: tabId('source', filePath),
            path: filePath,
            kind: 'source',
            content: data.content,
            language: data.language,
            size: data.size,
            originalContent,
            isDirty: false,
          };
        }
        const res = await fetch(`/api/fs?path=${encodeURIComponent(fullPath)}&mode=read`);
        if (!res.ok) return null;
        const data: FileContent = await res.json();
        return {
          id: tabId('source', filePath),
          path: filePath,
          kind: 'source',
          content: data.content,
          language: data.language,
          size: data.size,
          originalContent: null,
          isDirty: false,
        };
      } catch {
        return null;
      }
    },
    [dirPath],
  );

  /** Open a source tab for a file: activate existing tab, or fetch and append a new one. */
  const openFile = useCallback(
    async (filePath: string) => {
      const id = tabId('source', filePath);
      const existing = tabs.find((t) => t.id === id);
      if (existing) {
        setActiveTabId(id);
        if (isMobile) setMobileView('editor');
        return;
      }
      // Image/PDF/CSV open in place in a dedicated viewer that streams the file
      // from the path-confined raw route itself — so we append a lightweight tab
      // and skip the text read (which would be garbage for binary files).
      const viewerKind = detectViewerKind(filePath);
      if (viewerKind) {
        const viewerTab: FileTab = {
          id,
          path: filePath,
          kind: 'source',
          content: '',
          language: '',
          size: 0,
          originalContent: null,
          isDirty: false,
        };
        setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, viewerTab]));
        setActiveTabId(id);
        track('file_opened_viewer', { kind: viewerKind });
        if (isMobile) setMobileView('editor');
        return;
      }
      setLoading(true);
      const tab = await fetchFileTab(filePath, changesOnly);
      setLoading(false);
      if (!tab) {
        // fetchFileTab returns null on read failure (deleted file, permission
        // error, network blip). Surface so a click that does nothing is
        // debuggable; the panel has no toast system yet.
        console.error(`[files] failed to open ${filePath}`);
        return;
      }
      setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, tab]));
      setActiveTabId(id);
      track('file_opened_editor', { language: tab.language || 'plaintext' });
      if (isMobile) setMobileView('editor');
    },
    [tabs, fetchFileTab, changesOnly, isMobile],
  );

  /** Open (or activate) a preview sub-tab for a file. Inserts next to the source tab if present. */
  const openPreview = useCallback(
    (filePath: string) => {
      const id = tabId('preview', filePath);
      setTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        const previewTab: FileTab = {
          id,
          path: filePath,
          kind: 'preview',
          // Preview tabs render via PreviewPane and don't read these fields,
          // but we keep the shape uniform so reordering / persistence stay simple.
          content: '',
          language: '',
          size: 0,
          originalContent: null,
          isDirty: false,
        };
        const sourceIdx = prev.findIndex((t) => t.id === tabId('source', filePath));
        if (sourceIdx === -1) return [...prev, previewTab];
        return [...prev.slice(0, sourceIdx + 1), previewTab, ...prev.slice(sourceIdx + 1)];
      });
      setActiveTabId(id);
      if (isMobile) setMobileView('editor');
    },
    [isMobile],
  );

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      // If we just closed the active tab, pick a neighbour as the new active.
      setActiveTabId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        const fallbackIdx = Math.min(idx, next.length - 1);
        return next[fallbackIdx].id;
      });
      return next;
    });
    editorContentRefs.current.delete(id);
    setPreviewReload((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const requestCloseTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab?.isDirty) {
        setCloseConfirm(id);
        return;
      }
      closeTab(id);
    },
    [tabs, closeTab],
  );

  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setTabs((prev) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length)
        return prev;
      if (fromIndex === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1 || prev[idx].isDirty === dirty) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], isDirty: dirty };
      return next;
    });
  }, []);

  const handleSave = useCallback(
    async (id: string, filePath: string, content: string) => {
      const fullPath = `${dirPath}/${filePath}`;
      const res = await fetch('/api/fs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath, content }),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      // Cmd+S / save-button paths also clear dirty inside FileViewer (after
      // its own onSave resolves), but the close-dialog "Save & Close" path
      // calls handleSave directly; clearing here keeps the parent's tab
      // state authoritative regardless of caller.
      setTabDirty(id, false);
      // Bump preview reload nonce for any open preview of the same path so
      // the iframe re-fetches from disk after a save.
      const previewId = tabId('preview', filePath);
      setPreviewReload((prev) => ({ ...prev, [previewId]: (prev[previewId] ?? 0) + 1 }));
    },
    [dirPath, setTabDirty],
  );

  const fetchGitStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(dirPath)}`);
      if (res.ok) setGitStatus(await res.json());
    } catch {}
  }, [dirPath]);

  // Reset tree + tab state, then hydrate persisted tabs for this workspace.
  useEffect(() => {
    setTree([]);
    setExpandedDirs({});
    setGitStatus({});
    setTabs([]);
    setActiveTabId(null);
    editorContentRefs.current.clear();
    setPreviewReload({});
    setHydratedDirPath(null);
    fetchDir('').then((entries) => setTree(entries));
    fetchGitStatus();

    let cancelled = false;
    (async () => {
      try {
        const settings = await fetch('/api/settings').then((r) => r.json());
        const persisted = settings?.filePanelTabs?.[dirPath];
        if (cancelled) return;
        if (!persisted || !Array.isArray(persisted.open) || persisted.open.length === 0) {
          setHydratedDirPath(dirPath);
          return;
        }
        // Hydrate is always non-diff: we rely on the user to toggle changesOnly
        // explicitly, so we don't restore stale diffs.
        // Persisted entries are now `{path, kind}` objects; tolerate the
        // legacy plain-string format (older settings files) by treating
        // bare strings as `{path, kind: "source"}`.
        type Persisted = string | { path: string; kind?: FileTabKind };
        const entries: Persisted[] = persisted.open;
        const normalized = entries.map((e) =>
          typeof e === 'string'
            ? { path: e, kind: 'source' as FileTabKind }
            : { path: e.path, kind: e.kind ?? 'source' },
        );
        const sourceFetches = await Promise.all(
          normalized
            .filter((e) => e.kind === 'source' && !detectViewerKind(e.path))
            .map((e) => fetchFileTab(e.path, false)),
        );
        if (cancelled) return;
        const sourceById = new Map<string, FileTab>();
        for (const t of sourceFetches) {
          if (t) sourceById.set(t.id, t);
        }
        const restored: FileTab[] = [];
        for (const e of normalized) {
          if (e.kind === 'source') {
            // Dedicated-viewer files restore as lightweight tabs (no text read);
            // the viewer fetches the raw route when it mounts.
            if (detectViewerKind(e.path)) {
              restored.push({
                id: tabId('source', e.path),
                path: e.path,
                kind: 'source',
                content: '',
                language: '',
                size: 0,
                originalContent: null,
                isDirty: false,
              });
              continue;
            }
            const t = sourceById.get(tabId('source', e.path));
            if (t) restored.push(t);
          } else {
            restored.push({
              id: tabId('preview', e.path),
              path: e.path,
              kind: 'preview',
              content: '',
              language: '',
              size: 0,
              originalContent: null,
              isDirty: false,
            });
          }
        }
        setTabs(restored);
        const candidateId =
          persisted.active && restored.some((t) => t.id === persisted.active)
            ? persisted.active
            : (restored[0]?.id ?? null);
        setActiveTabId(candidateId);
        setHydratedDirPath(dirPath);
      } catch {
        if (!cancelled) setHydratedDirPath(dirPath);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dirPath, fetchDir, fetchGitStatus, fetchFileTab]);

  // Persist tab list + active tab to settings (per workspace). Only fires on
  // tab structure changes — not on dirty toggles — so we don't spam the API.
  const tabPathsKey = useMemo(() => tabs.map((t) => t.id).join('\n'), [tabs]);
  useEffect(() => {
    // Skip when tabs belong to a prior dirPath — prevents clobbering the new workspace's saved tabs on switch.
    if (hydratedDirPath !== dirPath) return;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePanelTabs: {
          [dirPath]: {
            open: tabs.map((t) => ({ path: t.path, kind: t.kind })),
            active: activeTabId,
          },
        },
      }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only depend on tab id list + active id; ignore isDirty churn.
  }, [hydratedDirPath, dirPath, tabPathsKey, activeTabId]);

  // Re-fetch tree and expanded dirs on file system changes (SSE) or window focus
  const refreshTree = useCallback(async () => {
    const rootEntries = await fetchDir('');
    setTree(rootEntries);
    fetchGitStatus();
    // Refresh expanded directories
    setExpandedDirs((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      Promise.all(keys.map((d) => fetchDir(d).then((entries) => [d, entries] as const))).then(
        (results) => {
          setExpandedDirs((p) => {
            const next = { ...p };
            for (const [d, entries] of results) next[d] = entries;
            return next;
          });
        },
      );
      return prev;
    });
  }, [fetchDir, fetchGitStatus]);

  useEffect(() => {
    window.addEventListener('focus', refreshTree);
    return () => window.removeEventListener('focus', refreshTree);
  }, [refreshTree]);

  // Listen for server-sent file change events
  useEffect(() => {
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
          if (type === 'files-changed') refreshTree();
        } catch {}
      };
    }

    connect();
    return () => {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      es?.close();
    };
  }, [refreshTree]);

  // Build a set of changed file paths and their ancestor directories for
  // filtering. Memoized on gitStatus so editor keystrokes (which trigger
  // re-renders via dirty-state updates) don't rebuild these sets.
  const { changedPaths, changedDirPaths } = useMemo(() => {
    const files = new Set(Object.keys(gitStatus));
    const dirs = new Set<string>();
    for (const filePath of files) {
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }
    return { changedPaths: files, changedDirPaths: dirs };
  }, [gitStatus]);

  // Auto-expand directories containing changed files once when entering changes mode
  useEffect(() => {
    if (!changesOnly) return;
    for (const dir of changedDirPaths) {
      if (expandedDirs[dir] === undefined) {
        fetchDir(dir).then((entries) => {
          setExpandedDirs((prev) => ({ ...prev, [dir]: entries }));
        });
      }
    }
  }, [changesOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toggling changesOnly clears tabs — diff view and edit view need
  // different server data and we don't want to silently reload every tab.
  // If any tab is dirty, prompt first so a switch can't drop unsaved work.
  const performChangesOnlyToggle = useCallback(() => {
    setChangesOnly((v) => !v);
    setTabs([]);
    setActiveTabId(null);
    editorContentRefs.current.clear();
    setPreviewReload({});
  }, []);

  const toggleChangesOnly = useCallback(() => {
    if (tabs.some((t) => t.isDirty)) {
      setChangesOnlyConfirm(true);
      return;
    }
    performChangesOnlyToggle();
  }, [tabs, performChangesOnlyToggle]);

  // Outer panel-width drag (left edge of the file panel).
  const handlePanelDrag = useCallback(
    (info: DragInfo) => {
      const rawWidth = window.innerWidth - info.x;
      if (hasTabs) {
        const maxW = window.innerWidth - 40;
        onWidthChange(Math.min(maxW, Math.max(MIN_WIDTH, rawWidth)));
      } else {
        setTreeWidth(Math.min(MAX_TREE_WIDTH, Math.max(120, rawWidth)));
      }
    },
    [hasTabs, onWidthChange],
  );

  // Inner editor↔tree drag.
  const handleTreeDrag = useCallback((info: DragInfo) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setTreeWidth(Math.min(MAX_TREE_WIDTH, Math.max(120, rect.right - info.x)));
  }, []);

  const toggleDir = useCallback(
    (dirPath: string) => {
      if (expandedDirs[dirPath]) {
        setExpandedDirs((prev) => {
          const next = { ...prev };
          delete next[dirPath];
          return next;
        });
      } else {
        // Expand immediately with empty placeholder, then fill in
        setExpandedDirs((prev) => ({ ...prev, [dirPath]: [] }));
        fetchDir(dirPath).then((entries) => {
          setExpandedDirs((prev) => ({ ...prev, [dirPath]: entries }));
        });
      }
    },
    [expandedDirs, fetchDir],
  );

  const ChevronRight = () => (
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
      <path d="M9 6l6 6-6 6" />
    </svg>
  );

  const ChevronDown = () => (
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
      <path d="M6 9l6 6 6-6" />
    </svg>
  );

  const FolderIcon = ({ open }: { open: boolean }) => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#e8a838"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <path d="M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1" />
          <path d="M20.27 13.73a2.5 2.5 0 0 0-3.54 0l-4.46 4.46a.5.5 0 0 0 0 .71l.7.7a.5.5 0 0 0 .71 0l4.46-4.46a2.5 2.5 0 0 0 0-3.41z" />
          <path d="M5 19h14a2 2 0 0 0 2-2v-5" />
        </>
      ) : (
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      )}
    </svg>
  );

  const FileIcon = ({ color }: { color?: string }) => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || '#58a6ff'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );

  const dirStatusColors = buildDirStatus(gitStatus);

  const renderEntries = (entries: DirEntry[], parentPath: string, depth: number) => {
    return entries
      .filter((entry) => {
        if (!changesOnly) return true;
        const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        return entry.type === 'directory'
          ? changedDirPaths.has(fullPath)
          : changedPaths.has(fullPath);
      })
      .map((entry) => {
        const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        const isExpanded = expandedDirs[fullPath] !== undefined;
        const isDir = entry.type === 'directory';
        const isSelected = activeTabPath === fullPath;
        const statusColor = isDir ? dirStatusColors[fullPath] : gitStatusColor(gitStatus[fullPath]);

        return (
          <div key={fullPath}>
            <div
              style={{
                ...S.entry,
                paddingLeft: `${8 + depth * 16}px`,
                background: isSelected ? 'var(--accent)' : 'transparent',
                color: isSelected ? 'var(--text-bright)' : statusColor || 'var(--text)',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                WebkitTouchCallout: 'none',
              }}
              onClick={() => {
                if (longPressFiredRef.current) {
                  longPressFiredRef.current = false;
                  return;
                }
                if (isDir) {
                  toggleDir(fullPath);
                } else {
                  openFile(fullPath);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openContextMenu(e.clientX, e.clientY, fullPath);
              }}
              onTouchStart={(e) => {
                longPressFiredRef.current = false;
                const t = e.touches[0];
                if (!t) return;
                const cx = t.clientX;
                const cy = t.clientY;
                cancelLongPress();
                longPressTimerRef.current = setTimeout(() => {
                  longPressFiredRef.current = true;
                  openContextMenu(cx, cy, fullPath);
                }, 500);
              }}
              onTouchMove={cancelLongPress}
              onTouchEnd={cancelLongPress}
              onTouchCancel={cancelLongPress}
            >
              <span style={S.chevron}>
                {isDir ? (
                  isExpanded ? (
                    <ChevronDown />
                  ) : (
                    <ChevronRight />
                  )
                ) : (
                  <span style={{ width: 16 }} />
                )}
              </span>
              <span style={S.entryIcon}>
                {isDir ? <FolderIcon open={isExpanded} /> : <FileIcon color={statusColor} />}
              </span>
              <span style={S.entryName}>{entry.name}</span>
              {!isDir && fileIndicatorPaths && fileIndicatorPaths.has(`${dirPath}/${fullPath}`) && (
                <span title="Open in plugin tab" style={S.debugIndicator} />
              )}
            </div>
            {isDir && isExpanded && expandedDirs[fullPath] && (
              <div>{renderEntries(expandedDirs[fullPath], fullPath, depth + 1)}</div>
            )}
          </div>
        );
      });
  };

  const tabBarInfo = useMemo(
    () => tabs.map((t) => ({ id: t.id, path: t.path, kind: t.kind, isDirty: t.isDirty })),
    [tabs],
  );

  const openTabContextMenu = useCallback(
    (clientX: number, clientY: number, tab: { id: string; path: string; kind: FileTabKind }) => {
      // Estimate menu height from item count to avoid clipping near the
      // viewport edges. Items: Close + (Preview if applicable) + (Reload if preview).
      const items =
        1 +
        (tab.kind === 'source' && isPreviewable(tab.path) ? 1 : 0) +
        (tab.kind === 'preview' ? 1 : 0);
      const MENU_W = 200;
      const MENU_ITEM_H = 32;
      const menuH = items * MENU_ITEM_H + 8;
      const x = Math.min(clientX, window.innerWidth - MENU_W - 8);
      const y = Math.min(clientY, window.innerHeight - menuH - 8);
      setTabContextMenu({
        x: Math.max(0, x),
        y: Math.max(0, y),
        tabId: tab.id,
        path: tab.path,
        kind: tab.kind,
      });
    },
    [],
  );

  const renderTabPane = (tab: FileTab, isActive: boolean) => {
    const showDiff = changesOnly && tab.originalContent !== null;
    const viewerKind = tab.kind === 'source' ? detectViewerKind(tab.path) : null;
    return (
      <div
        key={tab.id}
        style={{
          ...S.tabPane,
          display: isActive ? 'flex' : 'none',
        }}
      >
        {tab.kind === 'preview' ? (
          <PreviewPane
            filePath={tab.path}
            dirPath={dirPath}
            reloadKey={previewReload[tab.id]}
            onBack={isMobile ? () => setMobileView('tree') : undefined}
          />
        ) : viewerKind ? (
          <DedicatedViewer
            kind={viewerKind}
            filePath={tab.path}
            dirPath={dirPath}
            onBack={isMobile ? () => setMobileView('tree') : undefined}
          />
        ) : showDiff ? (
          <DiffViewer
            filePath={tab.path}
            original={tab.originalContent!}
            modified={tab.content}
            language={tab.language}
            onBack={isMobile ? () => setMobileView('tree') : undefined}
          />
        ) : (
          <FileViewer
            filePath={tab.path}
            dirPath={dirPath}
            content={tab.content}
            language={tab.language}
            isActive={isActive}
            onDirty={(d) => setTabDirty(tab.id, d)}
            onSave={(c) => handleSave(tab.id, tab.path, c)}
            onContentChange={(c) => editorContentRefs.current.set(tab.id, c)}
            onBack={isMobile ? () => setMobileView('tree') : undefined}
          />
        )}
      </div>
    );
  };

  const editorPane = (
    <>
      <FileTabBar
        tabs={tabBarInfo}
        activeId={activeTabId}
        onSelect={(id) => setActiveTabId(id)}
        onClose={requestCloseTab}
        onReorder={reorderTabs}
        onContextMenu={openTabContextMenu}
      />
      <div style={S.tabPaneStack}>
        {tabs.map((tab) => renderTabPane(tab, tab.id === activeTabId))}
        {loading && tabs.length === 0 && <div style={S.empty}>Loading...</div>}
      </div>
    </>
  );

  const treeRightActions = (
    <div style={{ display: 'flex', gap: '2px' }}>
      <button
        style={{ ...topBarActionStyle, color: changesOnly ? 'var(--warning, #d29922)' : undefined }}
        onClick={toggleChangesOnly}
        title={changesOnly ? 'Show all files' : 'Show changes only'}
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
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </svg>
      </button>
      {onClose && (
        <button
          style={topBarActionStyle}
          onClick={onClose}
          title={isMobile ? 'Back to terminal' : 'Close files'}
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
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}
    </div>
  );

  const treePane = (
    <>
      <TopBar right={treeRightActions}>
        <span style={S.treeTitle}>{changesOnly ? 'CHANGES' : 'FILES'}</span>
      </TopBar>
      <div style={S.treeContent}>
        {tree.length > 0 ? (
          renderEntries(tree, '', 0)
        ) : (
          <div style={S.empty}>{changesOnly ? 'No changes' : 'No files'}</div>
        )}
      </div>
    </>
  );

  return (
    <div
      ref={containerRef}
      style={{
        ...S.container,
        width: width > 0 ? (hasTabs ? `${width}px` : `${treeWidth}px`) : '100%',
      }}
    >
      {/* Close-with-unsaved-changes confirm dialog */}
      {closeConfirm &&
        (() => {
          const tab = tabs.find((t) => t.id === closeConfirm);
          const displayPath = tab?.path ?? closeConfirm;
          return (
            <ConfirmDialog
              title="Unsaved Changes"
              message={`"${displayPath}" has unsaved changes.`}
              buttons={[
                {
                  label: 'Save & Close',
                  primary: true,
                  action: async () => {
                    const content =
                      editorContentRefs.current.get(closeConfirm) ?? tab?.content ?? '';
                    if (!tab) {
                      setCloseConfirm(null);
                      return;
                    }
                    try {
                      await handleSave(tab.id, tab.path, content);
                    } catch (err) {
                      // Keep the dialog open on failure — closing the tab now
                      // would silently lose the user's unsaved content.
                      console.error('[files] save failed:', err);
                      return;
                    }
                    closeTab(closeConfirm);
                    setCloseConfirm(null);
                  },
                },
                {
                  label: 'Discard',
                  danger: true,
                  action: () => {
                    closeTab(closeConfirm);
                    setCloseConfirm(null);
                  },
                },
                {
                  label: 'Cancel',
                  action: () => setCloseConfirm(null),
                },
              ]}
              onClose={() => setCloseConfirm(null)}
            />
          );
        })()}

      {changesOnlyConfirm && (
        <ConfirmDialog
          title="Unsaved Changes"
          message={`Switching mode will discard unsaved changes in ${tabs.filter((t) => t.isDirty).length} file(s).`}
          buttons={[
            {
              label: 'Discard & Switch',
              danger: true,
              action: () => {
                performChangesOnlyToggle();
                setChangesOnlyConfirm(false);
              },
            },
            {
              label: 'Cancel',
              action: () => setChangesOnlyConfirm(false),
            },
          ]}
          onClose={() => setChangesOnlyConfirm(false)}
        />
      )}

      {/* Resize handle on left edge (desktop only) */}
      {!isMobile && (
        <ResizeHandle
          axis="x"
          variant="edge"
          style={{ left: -3 }}
          onStart={onResizeStart}
          onDrag={handlePanelDrag}
          onEnd={onResizeEnd}
        />
      )}

      {isMobile ? (
        /* Mobile: show either tree or editor, full width */
        mobileView === 'editor' && hasTabs ? (
          <div style={{ ...S.viewerPane, width: '100%' }}>{editorPane}</div>
        ) : (
          <div style={{ ...S.treePane, width: '100%' }}>{treePane}</div>
        )
      ) : (
        /* Desktop: side-by-side viewer + tree */
        <>
          {hasTabs && <div style={S.viewerPane}>{editorPane}</div>}

          {hasTabs && <ResizeHandle axis="x" onDrag={handleTreeDrag} />}

          <div style={{ ...S.treePane, width: `${treeWidth}px` }}>{treePane}</div>
        </>
      )}

      {contextMenu && (
        <>
          <div
            style={S.contextMenuBackdrop}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          <div style={{ ...S.contextMenu, left: contextMenu.x, top: contextMenu.y }}>
            <ContextMenuItem
              onClick={async () => {
                await copyToClipboard(contextMenu.absPath);
                setContextMenu(null);
              }}
            >
              Copy path
            </ContextMenuItem>
            {contextMenu.relPath && isPreviewable(contextMenu.relPath) && (
              <ContextMenuItem
                onClick={() => {
                  openPreview(contextMenu.relPath);
                  setContextMenu(null);
                }}
              >
                Open Preview
              </ContextMenuItem>
            )}
            {fileHandlers?.map((handler, i) => {
              const basename = contextMenu.absPath.split('/').pop() ?? '';
              if (!matchesGlob(handler.pattern, basename)) return null;
              return (
                <ContextMenuItem
                  key={`${i}-${handler.pattern}-${handler.label}`}
                  onClick={() => {
                    handler.onSelect(contextMenu.absPath);
                    setContextMenu(null);
                  }}
                >
                  {handler.label}
                </ContextMenuItem>
              );
            })}
          </div>
        </>
      )}

      {tabContextMenu && (
        <>
          <div
            style={S.contextMenuBackdrop}
            onClick={() => setTabContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabContextMenu(null);
            }}
          />
          <div style={{ ...S.contextMenu, left: tabContextMenu.x, top: tabContextMenu.y }}>
            {tabContextMenu.kind === 'source' && isPreviewable(tabContextMenu.path) && (
              <ContextMenuItem
                onClick={() => {
                  openPreview(tabContextMenu.path);
                  setTabContextMenu(null);
                }}
              >
                Open Preview
              </ContextMenuItem>
            )}
            {tabContextMenu.kind === 'preview' && (
              <ContextMenuItem
                onClick={() => {
                  const id = tabContextMenu.tabId;
                  setPreviewReload((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
                  setTabContextMenu(null);
                }}
              >
                Reload Preview
              </ContextMenuItem>
            )}
            <ContextMenuItem
              onClick={() => {
                requestCloseTab(tabContextMenu.tabId);
                setTabContextMenu(null);
              }}
            >
              Close
            </ContextMenuItem>
          </div>
        </>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    borderLeft: '1px solid var(--border)',
    background: 'var(--bg)',
    flexShrink: 0,
  },
  treePane: {
    borderLeft: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    overflow: 'hidden',
    background: 'var(--bg-secondary)',
    marginLeft: 'auto',
  },
  treeHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0 8px',
    height: 'var(--tab-height)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  treeTitle: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.5px',
    color: 'var(--text-muted)',
    paddingLeft: '8px',
  },
  treeContent: {
    flex: 1,
    overflow: 'auto',
    padding: '2px 0',
  },
  entry: {
    display: 'flex',
    alignItems: 'center',
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingRight: '8px',
    cursor: 'pointer',
    fontSize: '13px',
    lineHeight: '22px',
    gap: '4px',
    whiteSpace: 'nowrap' as const,
    borderRadius: 0,
  },
  chevron: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '22px',
    flexShrink: 0,
    color: 'var(--text-muted)',
    borderRadius: '3px',
  },
  entryIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  entryName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  debugIndicator: {
    display: 'inline-block',
    width: 6,
    height: 6,
    marginLeft: 8,
    borderRadius: '50%',
    background: 'var(--accent, #4caf50)',
    flexShrink: 0,
  },
  viewerPane: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  // The stack of per-tab viewers below the tab strip. Tabs share the same
  // box (absolute fill); the active one is `display: flex`, others are
  // `display: none`. CodeMirror state is preserved across switches.
  tabPaneStack: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  tabPane: {
    position: 'absolute',
    inset: 0,
    flexDirection: 'column',
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
  contextMenuBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
  },
  contextMenu: {
    position: 'fixed',
    zIndex: 1001,
    minWidth: 180,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '4px 0',
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    fontSize: '13px',
  },
  contextMenuItem: {
    padding: '6px 12px',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
};
