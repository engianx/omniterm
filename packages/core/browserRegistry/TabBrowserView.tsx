'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ResizeHandle, type DragInfo } from '../app/components/ResizeHandle';
import type { BrowserInspectorPosition } from '../lib/settings';
import { advanceSelection, emptySelectionState } from './pageSelection';

export interface Browser {
  id: string;
  label: string;
  startedAt: number;
  browserCdpUrl: string;
  pageCdpUrlTemplate: string;
  devtoolsFrontendUrl: string;
  /** Chromium's pid, when the registrant reported one. Disambiguates the
   *  switcher: the omniterm-browser shim hardcodes `label`, so every
   *  shim-launched Chrome registers under the same name. */
  pid?: number;
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
  /** DevTools inspector placement around the interactive screencast. */
  inspectorPosition?: BrowserInspectorPosition;
  /**
   * How the panel sits in its parent. `inline` takes part in the parent's flex
   * row. `overlay` floats above it, anchored to the parent's right edge.
   *
   * Overlay positions the panel itself rather than letting the caller wrap it,
   * so that in both modes the panel's parent box stays the full surface it
   * docks into or floats over. `handleResizeDrag` measures the drag limit
   * against that box — a wrapper would shrink-wrap to the panel's own width and
   * make the limit the current width, which turns every outward drag into a
   * shrink.
   */
  presentation?: 'inline' | 'overlay';
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
const DEVTOOLS_SCREENCAST_SHIM_ID = 'omniterm-devtools-screencast-shim';
const DEVTOOLS_SCREENCAST_SHIM_EVENT = 'omniterm:devtools-screencast-shim';
/** Must match SHIM_MESSAGE_TYPE in public/devtools-screencast-shim.js. */
const DEVTOOLS_SHIM_MESSAGE_TYPE = 'omniterm:devtools-shim';

interface DevToolsScreencastShimEventDetail {
  state?: unknown;
  detail?: unknown;
}

/**
 * Chrome's remote-debugging frontend renders its interactive screencast and
 * InspectorView in a private SplitWidget, with the inspector hard-coded on the
 * right. Load a tiny module in the iframe's own realm so it can feature-detect
 * that internal API and apply the requested visibility/orientation. The shim is
 * deliberately optional: if Chrome moves or removes the API, stock DevTools
 * remains untouched.
 *
 * `onReady` fires when the shim reports its state, which is the point from
 * which it listens for `postMessage` updates.
 */
function installDevToolsScreencastShim(
  frame: HTMLIFrameElement,
  inspectorPosition: BrowserInspectorPosition,
  onReady: () => void,
): void {
  try {
    const doc = frame.contentDocument;
    if (!doc || doc.getElementById(DEVTOOLS_SCREENCAST_SHIM_ID)) return;

    frame.contentWindow?.addEventListener(
      DEVTOOLS_SCREENCAST_SHIM_EVENT,
      (event) => {
        onReady();
        const payload = (event as CustomEvent<DevToolsScreencastShimEventDetail>).detail;
        const state = typeof payload?.state === 'string' ? payload.state : 'unknown';
        const detail = typeof payload?.detail === 'string' ? payload.detail : '';
        frame.dataset.omnitermScreencastShimState = state;
        frame.dataset.omnitermScreencastShimDetail = detail;

        const message = `[browser-view] DevTools screencast shim: ${state}${
          detail ? ` (${detail})` : ''
        }`;
        if (state === 'error') console.error(message);
        else if (state === 'unsupported') console.warn(message);
        else console.info(message);
      },
      { once: true },
    );

    const script = doc.createElement('script');
    script.id = DEVTOOLS_SCREENCAST_SHIM_ID;
    script.type = 'module';
    script.src = '/devtools-screencast-shim.js';
    script.dataset.inspectorPosition = inspectorPosition;
    doc.head.appendChild(script);
  } catch {
    // The proxied frontend is expected to be same-origin. If an embedding host
    // changes that contract, preserve the loaded frontend rather than blocking
    // the browser view on an optional presentation enhancement.
  }
}

/**
 * TabBrowserView — an embedded browser live-view for a single left-side tab.
 *
 * The tab strip across the top lists the *pages* of the selected Chromium
 * instance, one chip per page, titled from live CDP target info. That is the
 * common shape: the omniterm-browser shim keeps a single Chrome per
 * user-data-dir and hands every subsequent URL to it as a new tab, so one
 * process with many pages is the normal case and gets the whole strip.
 *
 * A second Chromium only appears when something registers its own CDP
 * endpoint (a Playwright/testbox harness, or an overridden
 * OMNITERM_BROWSER_UDD). For that case a BrowserSwitcher chip is pinned at
 * the strip's left edge — rendered only when more than one browser is
 * registered, so the common case pays nothing for it.
 *
 * The selected page is displayed inline via the embedded DevTools frontend
 * bundled under /devtools/, connected through the OmniTerm proxy
 * (`/b/:id/browser` + `/b/:id/page/:targetId`).
 *
 * The parent owns layout and can provide resize/close affordances. Without an
 * explicit width (the mobile/full-surface path), the view fills its flex parent.
 */
export default function TabBrowserView({
  tabId,
  tabBaseUrl,
  width,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
  inspectorPosition = 'hidden',
  presentation = 'inline',
  onClose,
}: Props) {
  const baseUrl = tabBaseUrl ?? `/t/${encodeURIComponent(tabId)}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const activeChipRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shimReadyRef = useRef(false);
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Talk to the loaded shim instead of reloading the frontend. Both of these
  // are presentation-only, so a frame that never reports ready (stock DevTools
  // moved its internals) simply keeps its startup layout.
  const postToShim = useCallback((message: Record<string, unknown>) => {
    if (!shimReadyRef.current) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: DEVTOOLS_SHIM_MESSAGE_TYPE, ...message },
      window.location.origin,
    );
  }, []);

  useEffect(() => {
    postToShim({ inspectorPosition });
  }, [inspectorPosition, postToShim]);

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
  const { targetsBrowserId, targetsLoaded } = targetState;
  const pages = useMemo(
    () => targetState.targets.filter((t) => t.type === 'page'),
    [targetState.targets],
  );

  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  // Drives hover-reveal of each chip's close button. Inline styles have no
  // :hover, so the hovered chip is tracked explicitly.
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  // All page-selection bookkeeping: per-browser page order and MRU stack,
  // plus which browser was evaluated last. advanceSelection owns every rule
  // that reads or writes it, including pruning browsers that have gone away.
  const selectionRef = useRef(emptySelectionState);
  useEffect(() => {
    if (!selected) {
      selectionRef.current = { ...selectionRef.current, lastBrowserId: null };
      setSelectedTargetId(null);
      return;
    }
    const { state, outcome } = advanceSelection(selectionRef.current, {
      browserId: selected.id,
      pageIds: pages.map((p) => p.targetId),
      selectedTargetId,
      targetsBrowserId,
      targetsLoaded,
      liveBrowserIds: browsers.map((b) => b.id),
    });
    selectionRef.current = state;
    if (outcome.kind === 'select') setSelectedTargetId(outcome.targetId);
  }, [selected, pages, selectedTargetId, targetsBrowserId, targetsLoaded, browsers]);

  useEffect(() => {
    setSelectedTargetId(null);
  }, [selected?.id]);

  // Keep the active chip on screen. Auto-select regularly lands on a page the
  // strip is not scrolled to — `$BROWSER url` appends to the end, and closing
  // a page can jump anywhere by recency — which otherwise reads as the
  // viewport changing with no visible tab selection. `nearest` on both axes
  // scrolls the strip the minimum needed and leaves the page alone.
  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedTargetId]);

  // Bring the selected target to the foreground so headless Chrome paints
  // it. Without this, switching to a background tab shows blank screencast.
  //
  // Depend on the two fields rather than `targetState`, which useTargets
  // rebuilds as a fresh object every render. `sendCommand` is stable, so this
  // now fires on a real selection or connection change instead of once per
  // render — a pane-resize drag re-renders on every pointermove and used to
  // send one activateTarget per frame down the proxied CDP socket.
  const { connected: targetsConnected, sendCommand: sendTargetCommand } = targetState;
  useEffect(() => {
    if (!selectedTargetId || !targetsConnected) return;
    sendTargetCommand('Target.activateTarget', { targetId: selectedTargetId });
  }, [selectedTargetId, targetsConnected, sendTargetCommand]);

  const wsHost = typeof window !== 'undefined' ? window.location.host : '';
  const wsScheme =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const iframeSrc =
    selected && selectedTargetId
      ? `${baseUrl}/b/${selected.id}/devtools/inspector.html?${wsScheme}=${wsHost}${baseUrl}/b/${selected.id}/page/${selectedTargetId}`
      : null;

  const containerStyle: React.CSSProperties = {
    ...S.container,
    ...(typeof width === 'number'
      ? { width: `${width}px`, flexShrink: 0 }
      : { flex: '1 1 0%' }),
    ...(presentation === 'overlay' ? S.overlay : {}),
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      {onWidthChange && (
        <ResizeHandle
          axis="x"
          variant="edge"
          style={{ left: -3 }}
          // Every screencast refit is a stop/start round trip that blanks the
          // remote page, so hold them off for the length of the drag and let
          // the shim fire exactly one when the pointer is released.
          onStart={() => {
            postToShim({ resizing: true });
            onResizeStart?.();
          }}
          onDrag={handleResizeDrag}
          onEnd={() => {
            postToShim({ resizing: false });
            onResizeEnd?.();
          }}
        />
      )}
      <div style={S.tabsStrip}>
        {/* Only earns its width when there is actually a choice to make. */}
        {browsers.length > 1 && selected && (
          <BrowserSwitcher browsers={browsers} selectedId={selected.id} onSelect={setSelectedId} />
        )}
        <div style={S.tabsScroller}>
          {pages.map((p) => {
            const isActive = p.targetId === selectedTargetId;
            const title = p.title || p.url;
            // Chrome's own convention: the active chip always offers close, the
            // rest reveal it on hover. Kept mounted-but-invisible rather than
            // unmounted so the chip doesn't change width under the pointer.
            const revealClose = isActive || hoveredTargetId === p.targetId;
            return (
              <div
                key={p.targetId}
                ref={isActive ? activeChipRef : undefined}
                style={{ ...S.tab, ...(isActive ? S.tabActive : {}) }}
                onClick={() => setSelectedTargetId(p.targetId)}
                onMouseEnter={() => setHoveredTargetId(p.targetId)}
                onMouseLeave={() =>
                  setHoveredTargetId((h) => (h === p.targetId ? null : h))
                }
                // Chips truncate hard, so the tooltip carries the untruncated
                // title as well as the URL it hides. Duplicate tabs of one URL
                // are common, and this is what tells them apart.
                title={p.title ? `${p.title}\n${p.url}` : p.url}
              >
                <span style={S.tabLabel}>{title}</span>
                <button
                  type="button"
                  style={{ ...S.tabClose, ...(revealClose ? {} : S.tabCloseHidden) }}
                  onClick={(e) => {
                    e.stopPropagation();
                    sendTargetCommand('Target.closeTarget', { targetId: p.targetId });
                  }}
                  title="Close page"
                  aria-label={`Close ${title}`}
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
              </div>
            );
          })}
          {/* A registered browser whose CDP socket hasn't reported targets yet
              would otherwise leave the strip and the viewport both blank, which
              reads as a broken panel rather than a pending one. */}
          {selected && pages.length === 0 && (
            <span style={S.stripHint}>
              {targetsConnected ? 'No pages open' : 'Connecting…'}
            </span>
          )}
        </div>
        {selected && targetsConnected && (
          <button
            type="button"
            style={S.newTabButton}
            onClick={() => sendTargetCommand('Target.createTarget', { url: 'about:blank' })}
            title="New page"
            aria-label="New page"
          >
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
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
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
                // Deliberately not keyed on inspectorPosition: moving the
                // inspector is a postMessage to the loaded shim, not a reload
                // of the whole frontend and its CDP session.
                key={iframeSrc}
                ref={frameRef}
                src={iframeSrc}
                style={S.iframe}
                title={`DevTools for ${selected.label}`}
                allow="clipboard-read; clipboard-write"
                onLoad={(event) => {
                  shimReadyRef.current = false;
                  installDevToolsScreencastShim(event.currentTarget, inspectorPosition, () => {
                    shimReadyRef.current = true;
                  });
                }}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- Browser switcher (multi-process picker) -----------------------------

interface BrowserSwitcherProps {
  browsers: Browser[];
  selectedId: string;
  onSelect: (browserId: string) => void;
}

/**
 * Leading chip in the tab strip that picks which Chromium instance the page
 * chips belong to. The caller renders it only when more than one browser is
 * registered — with a single process (the overwhelmingly common case) there
 * is nothing to switch between and the strip's full width goes to titles.
 *
 * Entries are identified by `label` plus a pid/uptime meta line: the
 * omniterm-browser shim registers every Chrome it launches under the same
 * hardcoded label, so the label alone can be ambiguous. Registrants that
 * choose their own label (a Playwright/testbox harness) read cleanly.
 */
function BrowserSwitcher({ browsers, selectedId, onSelect }: BrowserSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  const selected = browsers.find((b) => b.id === selectedId) ?? null;

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuRect({ top: rect.bottom + 4, left: rect.left });
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
            style={{ ...S.dropdownMenu, top: menuRect.top, left: menuRect.left, width: 260 }}
          >
            {browsers.map((b) => {
              const isSelected = b.id === selectedId;
              return (
                <li
                  key={b.id}
                  style={{ ...S.dropdownItem, ...(isSelected ? S.dropdownItemSelected : {}) }}
                  onClick={() => {
                    onSelect(b.id);
                    setOpen(false);
                  }}
                  title={b.browserCdpUrl}
                >
                  <div style={S.dropdownItemContent}>
                    <div style={S.dropdownItemTitle}>{b.label}</div>
                    <div style={S.dropdownItemUrl}>{browserMeta(b)}</div>
                  </div>
                </li>
              );
            })}
          </ul>,
          document.body,
        )
      : null;

  const running = `switch browser (${browsers.length} running)`;
  const switcherTitle = selected
    ? `${selected.label} · ${browserMeta(selected)} — ${running}`
    : running;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        style={S.switcherButton}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={switcherTitle}
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
          style={{ flexShrink: 0 }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span style={S.switcherLabel}>{selected?.label ?? 'browser'}</span>
      </button>
      {menu}
    </>
  );
}

/** Distinguishing detail for a browser entry: pid when the registrant
 *  reported one, else the registry id, plus how long it has been up. */
function browserMeta(b: Browser): string {
  const identity = b.pid !== undefined ? `pid ${b.pid}` : `id ${b.id}`;
  return `${identity} · ${formatUptime(Date.now() - b.startedAt)}`;
}

// --- Target discovery via CDP -------------------------------------------

function useTargets(baseUrl: string, browserId: string | null) {
  const [targets, setTargets] = useState<CdpTarget[]>([]);
  // Which browser `targets` currently describes. Reset alongside `targets`
  // so the two can never disagree. Callers need this because `browserId`
  // changes during render while `targets` only catches up when this hook's
  // effect runs — for one commit the two refer to different browsers, and
  // acting on that mismatch files one browser's pages under another's id.
  const [targetsBrowserId, setTargetsBrowserId] = useState<string | null>(null);
  // Whether `Target.getTargets` has answered for the current browser. `targets`
  // being empty cannot stand in for this: an empty list is also what a browser
  // with no pages looks like, and what every browser looks like for the moment
  // between switching to it and its snapshot arriving.
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const msgIdRef = useRef(1);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setTargets([]);
    setTargetsBrowserId(browserId);
    setTargetsLoaded(false);
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
        // The getTargets reply, even when it carries no targets at all.
        setTargetsLoaded(true);
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

  return { targets, targetsBrowserId, targetsLoaded, connected, error, sendCommand };
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
  // Floats over the surface instead of taking a column out of it. The parent
  // must be `position: relative` or absolutely positioned; the terminal pane it
  // covers stays interactive because this only spans the panel's own width.
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 50,
    boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
  },
  // Pinned at the strip's left edge. The heavier right border separates the
  // "which browser" control from the page chips that follow it, so the two
  // levels don't read as one flat row of tabs.
  switcherButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    maxWidth: '150px',
    height: '100%',
    padding: '6px 10px',
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '2px solid var(--border)',
    cursor: 'pointer',
    fontSize: '12px',
    flexShrink: 0,
  },
  switcherLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  },
  newTabButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '100%',
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  stripHint: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 12px',
    color: 'var(--text-muted)',
    fontSize: '12px',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
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
    // The chips scroll inside tabsScroller, not here — otherwise the browser
    // switcher, the new-page button and the close button scroll off with them,
    // and macOS renders no scrollbar to hint that they are still reachable.
    overflowX: 'hidden' as const,
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    height: 'var(--tab-height)',
  },
  // `0 1 auto`: sized to its chips, so the new-page button sits right after
  // the last one as it does in a real tab bar, but free to shrink (and start
  // scrolling) once the chips outgrow the panel.
  tabsScroller: {
    display: 'flex',
    alignItems: 'stretch',
    flex: '0 1 auto',
    overflowX: 'auto' as const,
    minWidth: 0,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
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
  tabClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    padding: 0,
    background: 'transparent',
    color: 'currentColor',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    opacity: 0.6,
    flexShrink: 0,
  },
  // `visibility` rather than unmounting or `display: none`: those reflow the
  // chip, so it would change width as the pointer crosses it. (All three keep
  // the button out of the tab order, so that is not what decides it.)
  tabCloseHidden: { visibility: 'hidden' as const },
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
