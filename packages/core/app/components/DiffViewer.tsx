'use client';

import { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { loadLangExtension } from './langExtensions';
import TopBar, { topBarActionStyle } from './TopBar';

interface Props {
  filePath: string;
  original: string;
  modified: string;
  language: string;
  onBack?: () => void;
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto' },
});

export default function DiffViewer({ filePath, original, modified, language, onBack }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // The grammar and the merge view are both code-split out of the initial
    // bundle and fetched on demand here. A diff opens on explicit user action,
    // so await both before constructing the editor — the merge view needs its
    // `original` baseline in place at creation.
    let cancelled = false;

    const mount = (extensions: Extension[]) => {
      if (cancelled || !containerRef.current) return;
      const state = EditorState.create({ doc: modified, extensions });
      viewRef.current = new EditorView({ state, parent: containerRef.current });
    };

    Promise.all([loadLangExtension(language), import('@codemirror/merge')])
      .then(([langExt, { unifiedMergeView }]) => {
        mount([
          basicSetup,
          oneDark,
          langExt,
          theme,
          unifiedMergeView({
            original,
            mergeControls: false,
            collapseUnchanged: { margin: 3, minSize: 4 },
          }),
        ]);
      })
      .catch((err) => {
        // The grammar or @codemirror/merge chunk failed to load (offline, stale
        // hashed chunk after an upgrade, dropped tunnel). Rather than leave the
        // pane blank, fall back to a read-only plain view of the modified
        // content so the file is still readable (no diff, no highlighting).
        console.warn(`[omniterm] failed to load diff view for "${filePath}"; showing plain content`, err);
        mount([basicSetup, oneDark, theme, EditorState.readOnly.of(true)]);
      });

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [filePath, original, modified, language]);

  return (
    <div style={S.container}>
      <TopBar
        right={
          onBack && (
            <button style={topBarActionStyle} onClick={onBack} title="Close diff">
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
          )
        }
      >
        <span style={S.path}>{filePath}</span>
        <span style={S.label}>DIFF</span>
      </TopBar>
      <div ref={containerRef} style={S.editor} />
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  path: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  label: {
    fontSize: '10px',
    color: 'var(--warning, #d29922)',
    fontWeight: 600,
    marginLeft: '8px',
    flexShrink: 0,
  },
  editor: {
    flex: 1,
    overflow: 'hidden',
  },
};
