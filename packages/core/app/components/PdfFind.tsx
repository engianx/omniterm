'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  eventBusRef: RefObject<EventBus | null>;
}

/**
 * Find bar for the PDF viewer. Dispatches pdf.js find events on the shared
 * EventBus and reflects the match count reported back via `updatefindmatchescount`.
 */
export default function PdfFind({ isOpen, onClose, eventBusRef }: Props) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Reflect match counts from pdf.js back into the bar.
  useEffect(() => {
    const bus = eventBusRef.current;
    if (!bus) return;
    const onCount = (e: { matchesCount?: { current: number; total: number } }) => {
      // pdf.js v5 always carries matchesCount (incl. {0,0} on NOT_FOUND), but a
      // missing count should reset to zero rather than leave a stale prior count.
      setMatches(e.matchesCount ? { current: e.matchesCount.current, total: e.matchesCount.total } : { current: 0, total: 0 });
    };
    bus.on('updatefindmatchescount', onCount);
    bus.on('updatefindcontrolstate', onCount);
    return () => {
      bus.off('updatefindmatchescount', onCount);
      bus.off('updatefindcontrolstate', onCount);
    };
  }, [eventBusRef, isOpen]);

  const dispatchFind = (type: 'find' | 'findagain', again: boolean, prev = false) => {
    const bus = eventBusRef.current;
    if (!bus) return;
    bus.dispatch(type, {
      source: null,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: prev,
    });
  };

  if (!isOpen) return null;

  return (
    <div style={S.bar}>
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in document"
        style={S.input}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            dispatchFind('findagain', true, e.shiftKey);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <button type="button" style={S.btn} title="Search" onClick={() => dispatchFind('find', false)}>
        Go
      </button>
      <button type="button" style={S.btn} title="Previous" onClick={() => dispatchFind('findagain', true, true)}>
        ↑
      </button>
      <button type="button" style={S.btn} title="Next" onClick={() => dispatchFind('findagain', true, false)}>
        ↓
      </button>
      <span style={S.count}>
        {matches && matches.total > 0 ? `${matches.current}/${matches.total}` : query ? '0/0' : ''}
      </span>
      <button type="button" style={S.btn} title="Close" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  bar: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: 6,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
  },
  input: {
    width: 180,
    background: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: '4px 6px',
    fontSize: 12,
  },
  btn: {
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    padding: '4px 8px',
  },
  count: {
    minWidth: 40,
    textAlign: 'center',
    fontSize: 11,
    color: 'var(--text-muted)',
    fontVariantNumeric: 'tabular-nums',
  },
};
