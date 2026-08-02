'use client';

import { useRef, useCallback, useEffect, forwardRef, type MutableRefObject } from 'react';
import { decodeOsc52Payload } from '../lib/osc52';
import { track } from '../../../app/telemetryClient';

interface Props {
  sessionId: string;
  port: number;
}

function writeClipboard(text: string): void {
  // Try the async Clipboard API first (works in secure contexts:
  // localhost, https). On failure — or in non-secure contexts like a
  // plain-http Tailscale host — fall back to a hidden-textarea +
  // execCommand("copy"), which still works same-origin in current
  // browsers despite being deprecated.
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch {
      // Nothing left to try; the selection is already in tmux's buffer.
    }
  };
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
      return;
    }
  } catch {
    // Some browsers throw synchronously when the API is gated.
  }
  fallback();
}

const TerminalView = forwardRef<HTMLIFrameElement, Props>(function TerminalView(
  { sessionId, port },
  forwardedRef,
) {
  const retriesRef = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Merge the forwarded ref with the internal one: TerminalView's own logic
  // (OSC-52, touch-scroll) reads `iframeRef`, while the integration needs the
  // active iframe element to reach `contentWindow.term` for the mobile key bar.
  const setIframeRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      iframeRef.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef)
        (forwardedRef as MutableRefObject<HTMLIFrameElement | null>).current = el;
    },
    [forwardedRef],
  );
  // Measures first-open render time (ttyd iframe mount → ttyd loaded) — the
  // dominant cost when opening an existing session after a server restart.
  const mountedAtRef = useRef<number | null>(null);
  const renderReportedRef = useRef(false);

  useEffect(() => {
    retriesRef.current = 0;
    mountedAtRef.current = performance.now();
    renderReportedRef.current = false;
  }, [sessionId]);

  const reportRendered = useCallback(() => {
    if (renderReportedRef.current || mountedAtRef.current === null) return;
    renderReportedRef.current = true;
    track('terminal_rendered', { render_ms: Math.round(performance.now() - mountedAtRef.current) });
  }, []);

  // Inject browser-behavior overrides into the same-origin ttyd iframe.
  const enhanceIframeDocument = useCallback(() => {
    try {
      const iframe = iframeRef.current;
      if (!iframe) return;
      const iframeDoc = iframe.contentDocument;
      if (!iframeDoc) return;

      if (!(iframeDoc as any).__omniterm_contextmenu) {
        (iframeDoc as any).__omniterm_contextmenu = true;
        iframeDoc.addEventListener('contextmenu', (e: MouseEvent) => {
          // Preserve the browser menu for the explicit Ctrl+left-click gesture.
          if (e.button === 0 && e.ctrlKey) return;
          e.preventDefault();
        });
      }

      // Register an OSC 52 handler on ttyd's xterm.js Terminal (exposed as
      // window.term). tmux emits OSC 52 on copy-mode yank via
      // `set-clipboard on` + `copy-pipe-and-cancel` (see lib/tmux.ts); the
      // handler decodes the base64 payload and writes it to the browser's
      // clipboard. Polls briefly because `window.term` is created after
      // ttyd's bundle finishes WebSocket handshake.
      if (!(iframeDoc as any).__omniterm_osc52) {
        const iframeWin = iframe.contentWindow as any;
        let attempts = 0;
        const install = () => {
          const term = iframeWin?.term;
          const parser = term?.parser;
          if (parser && typeof parser.registerOscHandler === 'function') {
            parser.registerOscHandler(52, (data: string) => {
              const decoded = decodeOsc52Payload(data);
              if (decoded !== null) writeClipboard(decoded);
              return true;
            });
            (iframeDoc as any).__omniterm_osc52 = true;
            return true;
          }
          return false;
        };
        if (!install()) {
          const iv = setInterval(() => {
            if (install() || ++attempts >= 40) clearInterval(iv);
          }, 100);
        }
      }

      // Skip if touch behavior was already injected
      if ((iframeDoc as any).__omniterm_touch) return;
      (iframeDoc as any).__omniterm_touch = true;

      let startY = 0;

      iframeDoc.addEventListener(
        'touchstart',
        (e: TouchEvent) => {
          if (e.touches.length === 1) startY = e.touches[0].clientY;
        },
        { passive: true },
      );

      iframeDoc.addEventListener(
        'touchmove',
        (e: TouchEvent) => {
          e.preventDefault();
          if (e.touches.length !== 1) return;

          const deltaY = startY - e.touches[0].clientY;
          if (Math.abs(deltaY) < 15) return;

          const target = iframeDoc.querySelector('.xterm-screen') || iframeDoc.body;
          target.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: deltaY > 0 ? 100 : -100,
              bubbles: true,
              cancelable: true,
            }),
          );

          startY = e.touches[0].clientY;
        },
        { passive: false },
      );
    } catch {
      // Cross-origin — can't inject
    }
  }, []);

  const handleLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.title && !doc.title.includes('ttyd') && retriesRef.current < 5) {
        retriesRef.current++;
        setTimeout(() => {
          iframe.src = `/t/${sessionId}/`;
        }, 500 * retriesRef.current);
      } else {
        // ttyd loaded — inject iframe behavior after a short delay for DOM to settle
        reportRendered();
        setTimeout(enhanceIframeDocument, 500);
      }
    } catch {
      // Cross-origin — ttyd loaded successfully
      reportRendered();
      setTimeout(enhanceIframeDocument, 500);
    }
  }, [sessionId, enhanceIframeDocument, reportRendered]);

  return (
    <iframe
      ref={setIframeRef}
      key={sessionId}
      src={`/t/${sessionId}/`}
      onLoad={handleLoad}
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        background: '#000',
        display: 'block',
      }}
      title={`Terminal ${sessionId}`}
    />
  );
});

export default TerminalView;
