'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import TopBar, { BackButton } from './TopBar';
import { rawPreviewUrl } from '../../lib/previewable';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  clampZoom,
  zoomedSize,
  type Size,
} from './image-viewer-zoom';

interface Props {
  /** Path relative to dirPath (matches FileTab.path). */
  filePath: string;
  /** Workspace root absolute path (matches FileTab.dirPath). */
  dirPath: string;
  /** Mobile back affordance, mirrors FileViewer's. */
  onBack?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * In-place image viewer. Fetches the file as a blob through the path-confined
 * raw route and renders it via an object URL — never by injecting markup, so an
 * SVG's embedded scripts can't execute against the app origin (an `<img>`-loaded
 * SVG is inert). Supports fit-to-pane, button zoom, trackpad pinch (ctrl+wheel),
 * and drag-to-pan when the image is larger than the pane.
 */
export default function ImageViewer({ filePath, dirPath, onBack }: Props) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [dims, setDims] = useState<Size | null>(null);
  const [surface, setSurface] = useState<Size>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);

  const filename = filePath.split('/').pop() || filePath;
  const absPath = `${dirPath}/${filePath}`;
  const rawUrl = rawPreviewUrl(absPath);

  // Fetch as a blob so we get both a stable render source and the exact byte
  // size (footer) from one request. Revoke the object URL on teardown/change.
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    setError(null);
    setBytes(null);
    setDims(null);
    setZoom(1);
    (async () => {
      try {
        const res = await fetch(rawUrl);
        if (!res.ok) {
          if (!cancelled) setError(res.status === 413 ? 'Image too large (>25MB)' : 'Failed to load image');
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBytes(blob.size);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setError('Failed to load image');
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rawUrl]);

  // Track the surface size so fit-to-pane and zoom math have a viewport.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const measure = () => setSurface({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [src]);

  const applyZoom = useCallback((next: (z: number) => number) => {
    setZoom((z) => clampZoom(next(z)));
  }, []);

  // Chromium surfaces trackpad pinch as ctrl+wheel; a non-passive listener is
  // required to preventDefault the browser/app zoom.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyZoom((z) => z * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, src]);

  // Drag-to-pan via scroll position when zoomed beyond the pane.
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = surfaceRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = surfaceRef.current;
    const d = dragRef.current;
    if (!el || !d) return;
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  }, []);
  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    surfaceRef.current?.releasePointerCapture?.(e.pointerId);
  }, []);

  const rendered = dims ? zoomedSize(dims, surface, zoom) : null;
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div style={S.container}>
      <TopBar right={onBack ? <BackButton onBack={onBack} /> : null}>
        <span style={S.path} title={absPath}>
          {filePath}
        </span>
      </TopBar>
      <div
        ref={surfaceRef}
        style={S.surface}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {error ? (
          <div style={S.message}>{error}</div>
        ) : src ? (
          <img
            src={src}
            alt={filename}
            draggable={false}
            onLoad={(e) =>
              setDims({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
            }
            onError={() => setError('Failed to load image')}
            style={
              rendered
                ? { width: rendered.width, height: rendered.height, maxWidth: 'none', userSelect: 'none' }
                : { maxWidth: '100%', maxHeight: '100%', userSelect: 'none' }
            }
          />
        ) : (
          <div style={S.message}>Loading…</div>
        )}
      </div>
      <div style={S.footer}>
        <div style={S.zoomGroup}>
          <button
            type="button"
            style={S.zoomBtn}
            onClick={() => applyZoom((z) => z / ZOOM_STEP)}
            disabled={!!error || zoom <= MIN_ZOOM}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            style={S.zoomBtn}
            onClick={() => setZoom(1)}
            disabled={!!error || zoom === 1}
            title="Reset zoom (fit)"
            aria-label="Reset zoom to fit"
          >
            ⟳
          </button>
          <button
            type="button"
            style={S.zoomBtn}
            onClick={() => applyZoom((z) => z * ZOOM_STEP)}
            disabled={!!error || zoom >= MAX_ZOOM}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
          <span style={S.zoomPct}>{zoomPercent}%</span>
        </div>
        <span style={S.meta} title={filename}>
          {filename}
        </span>
        {dims && (
          <span style={S.meta}>
            {dims.width} × {dims.height}
          </span>
        )}
        {bytes !== null && <span style={S.meta}>{formatBytes(bytes)}</span>}
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
  surface: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    padding: 16,
    boxSizing: 'border-box',
    touchAction: 'none',
  },
  message: { color: 'var(--text-muted)', fontSize: '12px' },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    borderTop: '1px solid var(--border)',
    padding: '6px 12px',
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
  zoomGroup: { display: 'flex', alignItems: 'center', gap: 4 },
  zoomBtn: {
    width: 22,
    height: 20,
    border: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    color: 'var(--text)',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: 1,
    padding: 0,
  },
  zoomPct: { marginLeft: 4, fontVariantNumeric: 'tabular-nums', minWidth: 36 },
  meta: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
