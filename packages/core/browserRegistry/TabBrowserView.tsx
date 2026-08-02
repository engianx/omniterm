'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ResizeHandle, type DragInfo } from '../app/components/ResizeHandle';

export interface Browser {
  id: string;
  label: string;
  startedAt: number;
  browserCdpUrl: string;
  pageCdpUrlTemplate: string;
  devtoolsFrontendUrl: string;
}

interface CdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

interface Props {
  /** Tab id whose browsers this view renders. */
  tabId: string;
  /**
   * URL prefix for this tab's registry routes (no trailing slash). The
   * component appends `/browsers`, `/events`, and `/b/:id/...` to this.
   * Pass `/t/<tabId>` for the terminal plugin or `/a/<tabId>` for the
   * agent plugin. Defaults to `/t/<tabId>` to keep the terminal
   * call-sites that haven't been updated working.
   */
  tabBaseUrl?: string;
  /**
   * Pixel width of the panel. When provided, the component renders a
   * draggable left-edge resize handle that calls `onWidthChange` with
   * new values. When undefined, the panel is full-width (mobile mode
   * uses this). Min width is enforced internally (300px).
   */
  width?: number;
  onWidthChange?: (width: number) => void;
  /** Optional callbacks bracketing a resize drag — useful when the
   *  outer layout wants to suppress hover interactions during drag. */
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /**
   * Optional close handler. When provided, renders an inline [×] in the
   * tab strip. Used on mobile, where the browser view replaces the
   * terminal full-screen and the top-bar toggle is hidden — without this,
   * the user has no way back. On desktop the top-bar icon handles toggle,
   * so the parent doesn't pass `onClose` and the [×] doesn't render.
   */
  onClose?: () => void;
}

const MIN_WIDTH = 300;

/**
 * TabBrowserView — an embedded browser live-view for a single left-side tab.
 *
 * Given a list of browsers (filtered by the parent tab to only those it owns),
 * renders a tab strip across the top with one entry per Chromium instance,
 * each expandable into its open Chromium pages. The selected page is
 * displayed inline via the embedded DevTools frontend bundled under
 * /devtools/, connected through the OmniTerm proxy (`/b/:id/browser` +
 * `/b/:id/page/:targetId`).
 *
 * No self-managed SSE or fetches — the parent is responsible for keeping
 * `browsers` current. No resize/close affordances — the parent owns layout.
 */
export default function TabBrowserView({
  tabId,
  tabBaseUrl,
  width,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
  onClose,
}: Props) {
  const baseUrl = tabBaseUrl ?? `/t/${encodeURIComponent(tabId)}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Restored from the pre-rename BrowserPanel — drag the left edge to
  // resize. Width is owned by the parent so it can persist or sync with
  // other layout state; this component just emits onWidthChange. Only
  // wired when onWidthChange is provided (see render guard below).
  const handleResizeDrag = useCallback(
    (info: DragInfo) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const parentRect = containerRef.current?.parentElement?.getBoundingClientRect();
      const rightEdge = rect?.right ?? window.innerWidth;
      const maxW = parentRect ? Math.max(MIN_WIDTH, parentRect.width - 40) : window.innerWidth - 40;
      const rawWidth = rightEdge - info.x;
      onWidthChange?.(Math.min(maxW, Math.max(MIN_WIDTH, rawWidth)));
    },
    [onWidthChange],
  );

  // Fetch snapshot + subscribe to live updates under the registry base URL.
  useEffect(() => {
    let cancelled = false;
    setBrowsers([]);
    setSelectedId(null);
    (async () => {
      try {
        const res = await fetch(`${baseUrl}/browsers`);
        if (!res.ok) return;
        const data = (await res.json()) as { browsers: Browser[] };
        if (!cancelled) setBrowsers(data.browsers ?? []);
      } catch {}
    })();
    const es = new EventSource(`${baseUrl}/events`);
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'added' && evt.data) {
          const added = evt.data as Browser;
          setBrowsers((prev) => {
            const i = prev.findIndex((b) => b.id === added.id);
            if (i >= 0) {
              const next = [...prev];
              next[i] = added;
              return next;
            }
            return [...prev, added];
          });
        } else if (evt.type === 'removed' && evt.data?.id) {
          const removedId = evt.data.id as string;
          setBrowsers((prev) => prev.filter((b) => b.id !== removedId));
        }
      } catch {}
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [baseUrl]);

  // Keep `selectedId` valid: prefer the existing selection, otherwise the
  // most recently started browser.
  useEffect(() => {
    if (browsers.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) => {
      if (prev && browsers.some((b) => b.id === prev)) return prev;
      const newest = browsers.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
      return newest.id;
    });
  }, [browsers]);

  const selected = browsers.find((b) => b.id === selectedId) ?? null;

  // Target discovery is only needed when a browser is selected
  const targetState = useTargets(baseUrl, selected?.id ?? null);
  const pages = useMemo(
    () => targetState.targets.filter((t) => t.type === 'page'),
    [targetState.targets],
  );

  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  // Track previous page count per browser so we can auto-select a freshly-
  // opened page (matches the user's expectation when they invoke `$BROWSER url`
  // — they want to see what they just opened, not the previously-active tab).
  // Keyed by browser.id so opening Chrome A doesn't auto-switch in Chrome B.
  // `lastSelectedRef` lets us detect "user just switched browsers" so we
  // don't fire spurious auto-select against stale counts from a previous
  // viewing of the same browser.
  const prevPageCountRef = useRef<Map<string, number>>(new Map());
  const lastSelectedRef = useRef<string | null>(null);

  // Prune ref entries for browsers that no longer exist. Without this, a
  // future browser registered with the same id (e.g. after a server restart)
  // would inherit the stale count and suppress auto-select for its first page.
  useEffect(() => {
    const liveIds = new Set(browsers.map((b) => b.id));
    for (const id of prevPageCountRef.current.keys()) {
      if (!liveIds.has(id)) prevPageCountRef.current.delete(id);
    }
  }, [browsers]);
  useEffect(() => {
    if (!selected) {
      lastSelectedRef.current = null;
      setSelectedTargetId(null);
      return;
    }
    const justSwitchedBrowser = lastSelectedRef.current !== selected.id;
    lastSelectedRef.current = selected.id;
    const prevCount = prevPageCountRef.current.get(selected.id) ?? 0;
    prevPageCountRef.current.set(selected.id, pages.length);
    if (!justSwitchedBrowser && pages.length > prevCount && pages.length > 0) {
      // New page(s) appeared — jump to the most recently added one. mergeTargets
      // appends new targets, so the last entry is the newest.
      setSelectedTargetId(pages[pages.length - 1].targetId);
    } else if (!selectedTargetId && pages.length > 0) {
      setSelectedTargetId(pages[0].targetId);
    } else if (selectedTargetId && !pages.some((p) => p.targetId === selectedTargetId)) {
      setSelectedTargetId(pages[0]?.targetId ?? null);
    }
  }, [selected, pages, selectedTargetId]);

  useEffect(() => {
    setSelectedTargetId(null);
  }, [selected?.id]);

  // Bring the selected target to the foreground so headless Chrome paints
  // it. Without this, switching to a background tab shows blank screencast.
  useEffect(() => {
    if (!selectedTargetId || !targetState.connected) return;
    targetState.sendCommand('Target.activateTarget', { targetId: selectedTargetId });
  }, [selectedTargetId, targetState]);

  const wsHost = typeof window !== 'undefined' ? window.location.host : '';
  const wsScheme =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const iframeSrc =
    selected && selectedTargetId
      ? `${baseUrl}/b/${selected.id}/devtools/inspector.html?${wsScheme}=${wsHost}${baseUrl}/b/${selected.id}/page/${selectedTargetId}`
      : null;

  const containerStyle: React.CSSProperties = {
    ...S.container,
    ...(typeof width === 'number' ? { width: `${width}px`, flexShrink: 0 } : {}),
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      {onWidthChange && (
        <ResizeHandle
          axis="x"
          variant="edge"
          style={{ left: -3 }}
          onStart={onResizeStart}
          onDrag={handleResizeDrag}
          onEnd={onResizeEnd}
        />
      )}
      <div style={S.tabsStrip}>
        {browsers.map((b) => {
          const isActive = b.id === selectedId;
          // Show chevron whenever the active browser has any pages, not just
          // 2+. With per-page close in the menu, a single-page browser still
          // benefits from the chevron — it's the only way to close the
          // lingering page (e.g., an OAuth tab whose calling tool was Ctrl-C'd).
          const showChevron = isActive && pages.length >= 1;
          const currentPage = pages.find((p) => p.targetId === selectedTargetId) ?? pages[0];
          return (
            <div
              key={b.id}
              style={{ ...S.tab, ...(isActive ? S.tabActive : {}) }}
              onClick={() => setSelectedId(b.id)}
              title={`${b.label} · ${formatUptime(Date.now() - b.startedAt)}`}
            >
              <span style={S.tabLabel}>{b.label}</span>
              {showChevron && currentPage && (
                <TargetChevronMenu
                  pages={pages}
                  selectedTargetId={currentPage.targetId}
                  onSelect={setSelectedTargetId}
                  onCloseTarget={(targetId) =>
                    targetState.sendCommand('Target.closeTarget', { targetId })
                  }
                />
              )}
            </div>
          );
        })}
        <div style={S.tabsSpacer} />
        {onClose && (
          <button style={S.closeButton} onClick={onClose} title="Close browser view">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div style={S.body}>
        {browsers.length === 0 ? (
          <div style={S.empty}>No browsers running for this tab</div>
        ) : selected ? (
          <div style={S.viewport}>
            {targetState.error && <div style={S.error}>{targetState.error}</div>}
            {!targetState.error && iframeSrc && (
              <iframe
                key={iframeSrc}
                src={iframeSrc}
                style={S.iframe}
                title={`DevTools for ${selected.label}`}
                allow="clipboard-read; clipboard-write"
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- Target chevron menu (per-browser page picker) -----------------------

interface TargetChevronMenuProps {
  pages: CdpTarget[];
  selectedTargetId: string;
  onSelect: (targetId: string) => void;
  /**
   * Optional callback fired when the user clicks the [×] next to a page.
   * Parent should send `Target.closeTarget` over CDP. The menu does not
   * close itself — the page disappears via the `Target.targetDestroyed`
   * event flowing through useTargets, so the dropdown stays open and the
   * user can close more pages without re-opening the menu.
   */
  onCloseTarget?: (targetId: string) => void;
}

function TargetChevronMenu({
  pages,
  selectedTargetId,
  onSelect,
  onCloseTarget,
}: TargetChevronMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuRect({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onViewportChange = () => setOpen(false);
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  const menu =
    open && menuRect
      ? createPortal(
          <ul
            ref={menuRef}
            style={{ ...S.dropdownMenu, top: menuRect.top, right: menuRect.right, width: 360 }}
          >
            {pages.map((p) => {
              const isSelected = p.targetId === selectedTargetId;
              return (
                <li
                  key={p.targetId}
                  style={{ ...S.dropdownItem, ...(isSelected ? S.dropdownItemSelected : {}) }}
                  onClick={() => {
                    onSelect(p.targetId);
                    setOpen(false);
                  }}
                  title={p.url}
                >
                  <div style={S.dropdownItemContent}>
                    <div style={S.dropdownItemTitle}>{p.title || p.url}</div>
                    <div style={S.dropdownItemUrl}>{p.url}</div>
                  </div>
                  {onCloseTarget && (
                    <button
                      type="button"
                      style={S.dropdownItemClose}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTarget(p.targetId);
                      }}
                      title="Close this page"
                      aria-label="Close page"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        style={S.chevronButton}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={`Select page (${pages.length} open)`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {menu}
    </>
  );
}

// --- Target discovery via CDP -------------------------------------------

function useTargets(baseUrl: string, browserId: string | null) {
  const [targets, setTargets] = useState<CdpTarget[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const msgIdRef = useRef(1);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setTargets([]);
    setConnected(false);
    setError(null);
    wsRef.current = null;
    if (!browserId) return;

    const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${wsScheme}://${window.location.host}${baseUrl}/b/${browserId}/browser`,
    );
    wsRef.current = ws;

    const send = (method: string, params?: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const id = msgIdRef.current++;
      ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    };

    ws.addEventListener('open', () => {
      setConnected(true);
      send('Target.setDiscoverTargets', { discover: true });
      send('Target.getTargets');
    });
    ws.addEventListener('error', () => setError('Failed to connect to browser via OmniTerm proxy'));
    ws.addEventListener('close', () => setConnected(false));
    ws.addEventListener('message', (event) => {
      let msg: {
        id?: number;
        method?: string;
        params?: { targetInfos?: CdpTarget[]; targetInfo?: CdpTarget; targetId?: string };
        result?: { targetInfos?: CdpTarget[] };
      };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.result?.targetInfos) {
        setTargets((prev) => mergeTargets(prev, msg.result!.targetInfos!));
        return;
      }
      if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo) {
        setTargets((prev) => mergeTargets(prev, [msg.params!.targetInfo!]));
        return;
      }
      if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo) {
        setTargets((prev) => mergeTargets(prev, [msg.params!.targetInfo!]));
        return;
      }
      if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
        setTargets((prev) => prev.filter((t) => t.targetId !== msg.params!.targetId));
        return;
      }
    });

    return () => {
      wsRef.current = null;
      try {
        ws.close();
      } catch {}
    };
  }, [baseUrl, browserId]);

  const sendCommand = useCallback((method: string, params?: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = msgIdRef.current++;
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  }, []);

  return { targets, connected, error, sendCommand };
}

// IMPORTANT: insertion order is meaningful. The auto-select-newest-page
// logic in TabBrowserView relies on `pages[pages.length - 1]` being the
// most recently added target. Map preserves insertion order; keep this
// function append-only (don't sort/reorder) or fix the auto-select callers.
function mergeTargets(prev: CdpTarget[], incoming: CdpTarget[]): CdpTarget[] {
  const byId = new Map(prev.map((t) => [t.targetId, t] as const));
  for (const t of incoming) byId.set(t.targetId, t);
  return [...byId.values()];
}

function formatUptime(ms: number): string {
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

// --- Styles --------------------------------------------------------------

const S: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg)',
    borderLeft: '1px solid var(--border)',
    flexShrink: 0,
    minWidth: 0,
  },
  chevronButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: '6px',
    padding: '2px 4px',
    background: 'transparent',
    color: 'currentColor',
    border: 'none',
    cursor: 'pointer',
    opacity: 0.65,
    borderRadius: '3px',
  },
  tabsSpacer: { flex: 1 },
  closeButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '100%',
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
  },
  dropdownMenu: {
    position: 'fixed',
    maxHeight: '320px',
    overflowY: 'auto' as const,
    listStyle: 'none',
    margin: 0,
    padding: '4px 0',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    zIndex: 100,
  },
  dropdownItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: '12px',
    color: 'var(--text)',
    borderBottom: '1px solid var(--border)',
  },
  dropdownItemSelected: {
    background: 'var(--accent, #2a5fb2)',
    color: 'var(--text-bright, #fff)',
  },
  dropdownItemContent: {
    flex: 1,
    minWidth: 0,
  },
  dropdownItemTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  dropdownItemUrl: {
    fontSize: '10px',
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    marginTop: '2px',
  },
  dropdownItemClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    padding: 0,
    background: 'transparent',
    color: 'currentColor',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    opacity: 0.6,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minHeight: 0,
  },
  tabsStrip: {
    display: 'flex',
    flexDirection: 'row' as const,
    alignItems: 'stretch',
    overflowX: 'auto' as const,
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    height: 'var(--tab-height)',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    maxWidth: '180px',
    padding: '6px 12px',
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
    fontSize: '12px',
    flexShrink: 0,
  },
  tabActive: {
    color: 'var(--text)',
    background: 'var(--bg)',
    borderBottom: '2px solid var(--accent, #58a6ff)',
  },
  tabLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    color: 'var(--text-muted)',
    fontSize: '12px',
    padding: '16px',
    textAlign: 'center' as const,
  },
  viewport: {
    flex: 1,
    background: 'var(--bg)',
    minHeight: 0,
    position: 'relative',
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
  },
  error: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--danger, #f85149)',
    fontSize: '13px',
    textAlign: 'center',
    padding: '16px',
  },
};
