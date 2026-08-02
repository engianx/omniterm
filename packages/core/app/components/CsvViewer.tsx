'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import TopBar, { BackButton } from './TopBar';
import { rawPreviewUrl } from '../../lib/previewable';
import { detectCsvDelimiter, parseCsv } from './csv-parse';

interface Props {
  filePath: string;
  dirPath: string;
  onBack?: () => void;
}

const ROW_HEIGHT = 26;
const OVERSCAN = 12;
const MIN_COL_PX = 80;
const MAX_COL_PX = 320;
const ROW_NUMBER_COL_PX = 56;
const CHAR_PX = 7;

/**
 * Read-only CSV/TSV table viewer. Fetches the file as text through the raw
 * route, parses it client-side, and renders a virtualized CSS grid so very
 * large files (100k+ rows) stay responsive. A CSS grid (not a <table>) is used
 * because absolutely-positioned virtualized rows break a table's column-width
 * synchronization between header and body.
 */
export default function CsvViewer({ filePath, dirPath, onBack }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const absPath = `${dirPath}/${filePath}`;
  const rawUrl = rawPreviewUrl(absPath);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(rawUrl);
        if (!res.ok) {
          if (!cancelled) setError(res.status === 413 ? 'File too large (>25MB)' : 'Failed to load file');
          return;
        }
        const text = await res.text();
        if (!cancelled) setContent(text);
      } catch {
        if (!cancelled) setError('Failed to load file');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawUrl]);

  const parsed = useMemo(() => {
    if (content === null) return null;
    const delimiter = detectCsvDelimiter(filePath, content);
    return parseCsv(content, delimiter);
  }, [content, filePath]);

  const { headerRow, bodyRows } = useMemo(() => {
    if (!parsed || parsed.rows.length === 0) {
      return { headerRow: [] as string[], bodyRows: [] as string[][] };
    }
    const [head, ...rest] = parsed.rows;
    return { headerRow: head ?? [], bodyRows: rest };
  }, [parsed]);

  const columnCount = parsed?.maxColumns ?? 0;

  const header = useMemo(() => {
    const out = [...headerRow];
    while (out.length < columnCount) out.push('');
    return out;
  }, [headerRow, columnCount]);

  // Size each column to its widest sampled value so header and body align.
  const columnWidths = useMemo(() => {
    const widths = Array.from<number>({ length: columnCount }).fill(MIN_COL_PX);
    const consider = (cell: string | undefined, idx: number) => {
      if (!cell) return;
      const w = Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, cell.length * CHAR_PX + 24));
      if (w > widths[idx]!) widths[idx] = w;
    };
    header.forEach(consider);
    const limit = Math.min(bodyRows.length, 200);
    for (let i = 0; i < limit; i += 1) {
      const r = bodyRows[i]!;
      for (let c = 0; c < columnCount; c += 1) consider(r[c], c);
    }
    return widths;
  }, [header, bodyRows, columnCount]);

  const gridTemplate = useMemo(
    () => `${ROW_NUMBER_COL_PX}px ${columnWidths.map((w) => `${w}px`).join(' ')}`,
    [columnWidths],
  );

  // Stable column-index list so the virtualized row render doesn't allocate a
  // fresh Array.from({length}) for every visible row on every scroll frame.
  const columnIndices = useMemo(
    () => Array.from({ length: columnCount }, (_, i) => i),
    [columnCount],
  );

  const virtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const chrome = (body: React.ReactNode) => (
    <div style={S.container}>
      <TopBar right={onBack ? <BackButton onBack={onBack} /> : null}>
        <span style={S.path} title={absPath}>
          {filePath}
        </span>
      </TopBar>
      {body}
    </div>
  );

  if (error) return chrome(<div style={S.message}>{error}</div>);
  if (!parsed) return chrome(<div style={S.message}>Loading…</div>);
  if (parsed.rows.length === 0) return chrome(<div style={S.message}>Empty file</div>);

  const virtualRows = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  return chrome(
    <>
      <div ref={scrollRef} style={S.scroll}>
        <div style={{ width: 'max-content', minWidth: '100%' }}>
          <div style={{ ...S.headerRow, gridTemplateColumns: gridTemplate }}>
            <div style={{ ...S.headerCell, ...S.rowNumHeader }}>#</div>
            {header.map((cell, idx) => (
              <div key={`col-${idx}`} style={S.headerCell} title={cell}>
                <span style={S.cellText}>{cell}</span>
              </div>
            ))}
          </div>
          <div style={{ height: totalHeight, position: 'relative' }}>
            {virtualRows.map((vr) => {
              const r = bodyRows[vr.index] ?? [];
              return (
                <div
                  key={vr.key}
                  style={{
                    ...S.bodyRow,
                    gridTemplateColumns: gridTemplate,
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <div style={{ ...S.cell, ...S.rowNum }}>{vr.index + 1}</div>
                  {columnIndices.map((c) => (
                    <div key={c} style={S.cell} title={r[c] ?? ''}>
                      <span style={S.cellText}>{r[c] ?? ''}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div style={S.footer}>
        <span>{bodyRows.length.toLocaleString()} rows</span>
        <span>{columnCount} columns</span>
      </div>
    </>,
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
  message: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '12px',
  },
  headerRow: {
    display: 'grid',
    position: 'sticky',
    top: 0,
    zIndex: 2,
    height: ROW_HEIGHT,
    background: 'var(--bg-secondary)',
  },
  headerCell: {
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    padding: '0 8px',
    fontWeight: 600,
    color: 'var(--text)',
    borderBottom: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    boxSizing: 'border-box',
  },
  rowNumHeader: {
    position: 'sticky',
    left: 0,
    zIndex: 3,
    justifyContent: 'flex-end',
    color: 'var(--text-muted)',
    fontWeight: 400,
  },
  bodyRow: {
    display: 'grid',
    position: 'absolute',
    top: 0,
    left: 0,
    height: ROW_HEIGHT,
  },
  cell: {
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    padding: '0 8px',
    color: 'var(--text)',
    borderBottom: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    boxSizing: 'border-box',
  },
  rowNum: {
    position: 'sticky',
    left: 0,
    zIndex: 1,
    justifyContent: 'flex-end',
    color: 'var(--text-muted)',
    background: 'var(--bg)',
  },
  cellText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  footer: {
    display: 'flex',
    gap: 16,
    borderTop: '1px solid var(--border)',
    padding: '6px 12px',
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
};
