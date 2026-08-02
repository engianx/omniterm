'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
// Type-only imports: pdf.js is NOT bundled — it loads at runtime from the
// host-served /pdfjs route via loadPdfjs() (see pdfjs-loader.ts). These imports
// are erased at build, so no pdfjs-dist code lands in the client bundle.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { EventBus, PDFViewer as PdfJsViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import TopBar, { BackButton } from './TopBar';
import PdfFind from './PdfFind';
import { rawPreviewUrl } from '../../lib/previewable';
import { loadPdfjs } from './pdfjs-loader';

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 1.25;

interface Props {
  filePath: string;
  dirPath: string;
  onBack?: () => void;
}

/**
 * In-place PDF viewer built on pdf.js's PDFViewer component: real page
 * scrolling, a selectable/copyable text layer, and an in-document find. The
 * document is loaded by URL from the path-confined raw route so pdf.js can
 * range-request large files instead of buffering them.
 */
export default function PdfViewer({ filePath, dirPath, onBack }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerDivRef = useRef<HTMLDivElement | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const pdfViewerRef = useRef<PdfJsViewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [scale, setScale] = useState(1);

  const filename = filePath.split('/').pop() || filePath;
  const absPath = `${dirPath}/${filePath}`;
  const rawUrl = rawPreviewUrl(absPath);

  useEffect(() => {
    const container = containerRef.current;
    const viewerDiv = viewerDivRef.current;
    if (!container || !viewerDiv) return;

    setError(null);
    let cancelled = false;
    // pdf.js is fetched from the served /pdfjs route, so setup is async; track
    // teardown via a closure assigned once the viewer is built.
    let cleanup: (() => void) | null = null;

    loadPdfjs()
      .then(({ lib, viewer: V }) => {
        // Unmounted before pdf.js finished loading: nothing was built yet, so
        // `cleanup` stays null and the teardown's `cleanup?.()` is a safe no-op.
        // (loadPdfjs is memoized, so the already-completed load isn't wasted.)
        if (cancelled) return;
        const eventBus = new V.EventBus();
        eventBusRef.current = eventBus;
        const linkService = new V.PDFLinkService({ eventBus });
        const findController = new V.PDFFindController({ linkService, eventBus });
        const viewer = new V.PDFViewer({
          container,
          viewer: viewerDiv,
          eventBus,
          linkService,
          findController,
          textLayerMode: 1,
          removePageBorders: true,
        });
        pdfViewerRef.current = viewer;
        linkService.setViewer(viewer);

        const onScale = (e: { scale: number }) => {
          if (!cancelled) setScale(e.scale);
        };
        eventBus.on('scalechanging', onScale);

        let pdfDocument: PDFDocumentProxy | null = null;
        const loadingTask = lib.getDocument({ url: rawUrl });
        loadingTask.promise
          .then((doc) => {
            if (cancelled) {
              doc.destroy();
              return;
            }
            pdfDocument = doc;
            viewer.setDocument(doc);
            linkService.setDocument(doc);
            findController.setDocument(doc);
            viewer.currentScaleValue = 'page-width';
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            const name = (err as { name?: string })?.name;
            setError(
              name === 'PasswordException' ? 'This PDF is password-protected' : 'Failed to load PDF',
            );
          });

        cleanup = () => {
          loadingTask.destroy().catch(() => {});
          if (pdfDocument) pdfDocument.destroy();
          // setDocument(null) is the proper teardown: cancels renders, clears the
          // find controller, dispatches pagesdestroy. Runtime accepts null; the
          // types only declare PDFDocumentProxy.
          viewer.setDocument(null as unknown as PDFDocumentProxy);
          eventBus.off('scalechanging', onScale);
          eventBusRef.current = null;
          pdfViewerRef.current = null;
        };
      })
      .catch((err: unknown) => {
        console.error('[PdfViewer] setup failed', err);
        if (!cancelled) setError('Failed to load PDF viewer');
      });

    return () => {
      cancelled = true;
      setFindOpen(false);
      cleanup?.();
    };
  }, [rawUrl]);

  const zoomIn = useCallback(() => {
    const v = pdfViewerRef.current;
    if (v) v.currentScale = Math.min(MAX_SCALE, v.currentScale * SCALE_STEP);
  }, []);
  const zoomOut = useCallback(() => {
    const v = pdfViewerRef.current;
    if (v) v.currentScale = Math.max(MIN_SCALE, v.currentScale / SCALE_STEP);
  }, []);
  const fitWidth = useCallback(() => {
    const v = pdfViewerRef.current;
    if (v) v.currentScaleValue = 'page-width';
  }, []);

  const closeFind = useCallback(() => {
    eventBusRef.current?.dispatch('findbarclose', { source: null });
    setFindOpen(false);
  }, []);

  return (
    <div style={S.container}>
      <TopBar right={onBack ? <BackButton onBack={onBack} /> : null}>
        <span style={S.path} title={absPath}>
          {filePath}
        </span>
      </TopBar>
      <div style={S.body}>
        <PdfFind isOpen={findOpen} onClose={closeFind} eventBusRef={eventBusRef} />
        {error ? (
          <div style={S.message}>{error}</div>
        ) : (
          // pdf.js requires its container to be position:absolute. all:revert
          // stops Tailwind/global resets from cascading into the text layer
          // (which would misalign selection); the inner div carries positioning.
          <div style={{ all: 'revert' }}>
            <div ref={containerRef} style={S.pdfContainer}>
              <div ref={viewerDivRef} className="pdfViewer" />
            </div>
          </div>
        )}
      </div>
      <div style={S.footer}>
        <button type="button" style={S.btn} onClick={zoomOut} disabled={!!error} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button type="button" style={S.btn} onClick={fitWidth} disabled={!!error} title="Fit to width" aria-label="Fit to width">
          ⤢
        </button>
        <button type="button" style={S.btn} onClick={zoomIn} disabled={!!error} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <span style={S.pct}>{Math.round(scale * 100)}%</span>
        <button
          type="button"
          style={S.btn}
          onClick={() => setFindOpen(true)}
          disabled={!!error}
          title="Find in PDF"
        >
          Find
        </button>
        <span style={S.meta} title={filename}>
          {filename}
        </span>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  path: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  body: { position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' },
  pdfContainer: {
    position: 'absolute',
    inset: 0,
    overflow: 'auto',
    background: 'var(--bg)',
  },
  message: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderTop: '1px solid var(--border)',
    padding: '6px 12px',
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
  btn: {
    border: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    color: 'var(--text)',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    padding: '2px 8px',
  },
  pct: { fontVariantNumeric: 'tabular-nums', minWidth: 40 },
  meta: { marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
