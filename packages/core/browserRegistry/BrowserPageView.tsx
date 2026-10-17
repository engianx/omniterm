'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { BrowserInspectorPosition } from '../lib/settings';

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
 * that internal API and apply the requested visibility/orientation (and match
 * the remote viewport to the pane). The shim is deliberately optional: if
 * Chrome moves or removes the API, stock DevTools remains untouched.
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

interface Props {
  /** Terminal tab whose registry holds the browser. */
  ownerTabId: string;
  browserId: string;
  targetId: string;
  /** False while the browser is not (or no longer) in the owner's registry. */
  browserAvailable: boolean;
  /** Our own CDP socket to the browser is open (activation needs it). */
  connected: boolean;
  error: string | null;
  inspectorPosition: BrowserInspectorPosition;
  /** Bring the page to the foreground: headless/background pages only paint
   *  (and so only screencast) while they are the browser's active tab. */
  onActivate: () => void;
  label: string;
  /** This page's pane holds the strip's active tab (always true unless split). */
  focused?: boolean;
  /** A divider is being dragged: the shim holds screencast refits until it
   *  ends, then refits once to the final pane size. */
  resizing?: boolean;
}

/**
 * One browser page, filling its pane: the embedded DevTools frontend
 * (screencast + optional inspector) for a single CDP target, connected through
 * the OmniTerm proxy (`/t/<owner>/b/<id>/page/<targetId>`).
 *
 * Only VISIBLE browser tabs mount one of these (one per pane; at most two in a
 * split, always different pages) — each mounted frontend runs its own
 * screencast, refitted by the shim to its own iframe size — so switching tabs
 * reloads the frontend.
 */
export default function BrowserPageView({
  ownerTabId,
  browserId,
  targetId,
  browserAvailable,
  connected,
  error,
  inspectorPosition,
  onActivate,
  label,
  focused = true,
  resizing = false,
}: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shimReadyRef = useRef(false);

  // Talk to the loaded shim instead of reloading the frontend. Presentation
  // only, so a frame that never reports ready keeps its startup layout.
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

  // Pause screencast refits during a divider drag (each refit is a
  // stop/start round trip); the shim refits once to the final size on resume.
  // Also re-sent once the shim reports ready, in case a drag started first.
  const resizingRef = useRef(resizing);
  resizingRef.current = resizing;
  useEffect(() => {
    postToShim({ resizing });
  }, [resizing, postToShim]);

  // Depend on the ids + connection only: `onActivate` is a fresh closure each
  // render, and an activateTarget per render floods the proxied socket.
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;
  useEffect(() => {
    if (connected) activateRef.current();
  }, [connected, ownerTabId, browserId, targetId]);
  // Again whenever this pane takes focus: in a split showing two pages of the
  // same Chrome only its foreground tab keeps painting, so make that the page
  // the user is working in.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const wasFocusedRef = useRef(focused);
  useEffect(() => {
    const gained = focused && !wasFocusedRef.current;
    wasFocusedRef.current = focused;
    if (gained && connectedRef.current) activateRef.current();
  }, [focused]);

  const baseUrl = `/t/${encodeURIComponent(ownerTabId)}`;
  const bid = encodeURIComponent(browserId);
  const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const iframeSrc = `${baseUrl}/b/${bid}/devtools/inspector.html?${wsScheme}=${window.location.host}${baseUrl}/b/${bid}/page/${encodeURIComponent(targetId)}`;

  return (
    <div style={S.container}>
      {!browserAvailable ? (
        <div style={S.message}>Connecting…</div>
      ) : (
        <>
          <iframe
            // Deliberately not keyed on inspectorPosition: moving the
            // inspector is a postMessage to the loaded shim, not a reload of
            // the whole frontend and its CDP session.
            key={iframeSrc}
            ref={frameRef}
            src={iframeSrc}
            style={S.iframe}
            title={label}
            allow="clipboard-read; clipboard-write"
            onLoad={(event) => {
              shimReadyRef.current = false;
              installDevToolsScreencastShim(event.currentTarget, inspectorPosition, () => {
                shimReadyRef.current = true;
                if (resizingRef.current) postToShim({ resizing: true });
              });
            }}
          />
          {error && !connected && <div style={S.errorBar}>{error}</div>}
        </>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  // Absolute so it fills the host's `position: relative` content box whatever
  // that box's own display is.
  container: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg)',
    minWidth: 0,
    minHeight: 0,
  },
  iframe: {
    flex: 1,
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
  },
  message: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontSize: '13px',
    padding: '16px',
    textAlign: 'center',
  },
  errorBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: '6px 12px',
    background: 'var(--bg-secondary)',
    borderTop: '1px solid var(--border)',
    color: 'var(--danger, #f85149)',
    fontSize: '12px',
  },
};
