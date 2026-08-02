'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import TopBar, { topBarActionStyle } from './TopBar';
import { Compartment, EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { loadLangExtension } from './langExtensions';

interface Props {
  filePath: string;
  dirPath: string;
  content: string;
  language: string;
  /**
   * When this FileViewer is hidden via `display: none` (sibling tab is
   * active), CodeMirror skips measurements. Toggling this back to true
   * triggers a `requestMeasure()` so the editor lays out correctly when
   * it becomes visible again.
   */
  isActive?: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (content: string) => Promise<void> | void;
  onContentChange?: (content: string) => void;
  onBack?: () => void;
}

export default function FileViewer({
  filePath,
  dirPath,
  content,
  language,
  isActive = true,
  onDirty,
  onSave,
  onContentChange,
  onBack,
}: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const originalContentRef = useRef(content);
  const [isDirty, setIsDirty] = useState(false);

  // Create editor
  useEffect(() => {
    if (!editorRef.current) return;

    originalContentRef.current = content;
    setIsDirty(false);
    onDirty(false);

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        run: (view) => {
          const text = view.state.doc.toString();
          Promise.resolve(onSave(text)).then(() => {
            originalContentRef.current = text;
            setIsDirty(false);
            onDirty(false);
          });
          return true;
        },
      },
    ]);

    // The grammar loads on demand (its chunk is fetched only the first time a
    // file of this type is opened), so start as plain text and reconfigure the
    // compartment once it resolves — the editor paints immediately either way.
    const langCompartment = new Compartment();

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        oneDark,
        langCompartment.of([]),
        saveKeymap,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const currentContent = update.state.doc.toString();
            const dirty = currentContent !== originalContentRef.current;
            setIsDirty(dirty);
            onDirty(dirty);
            onContentChange?.(currentContent);
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { overflow: 'auto' },
        }),
      ],
    });

    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;

    let cancelled = false;
    loadLangExtension(language)
      .then((ext) => {
        if (cancelled) return;
        view.dispatch({ effects: langCompartment.reconfigure(ext) });
      })
      .catch((err) => {
        // Grammar chunk failed to load (offline, stale hashed chunk after an
        // upgrade, dropped tunnel). The editor already painted as plain text,
        // so degrade silently to that rather than leaving an unhandled rejection.
        console.warn(`[omniterm] failed to load "${language}" grammar; rendering as plain text`, err);
      });

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
  }, [filePath, content, language]); // eslint-disable-line react-hooks/exhaustive-deps

  // CodeMirror skips layout while the editor is hidden via display:none.
  // When the tab becomes active again, ask for a re-measure so scrollbars,
  // gutters and cursor positions are correct.
  useEffect(() => {
    if (isActive) viewRef.current?.requestMeasure();
  }, [isActive]);

  // Re-fetch file content when window regains focus (if not dirty)
  useEffect(() => {
    const handleFocus = async () => {
      if (isDirty || !viewRef.current) return;
      const fullPath = `${dirPath}/${filePath}`;
      const res = await fetch(`/api/fs?path=${encodeURIComponent(fullPath)}&mode=read`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.content === originalContentRef.current) return;
      originalContentRef.current = data.content;
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: data.content },
      });
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [filePath, dirPath, isDirty]);

  const handleSave = useCallback(async () => {
    if (viewRef.current) {
      const content = viewRef.current.state.doc.toString();
      await onSave(content);
      originalContentRef.current = content;
      setIsDirty(false);
      onDirty(false);
    }
  }, [onSave, onDirty]);

  return (
    <div style={S.container}>
      <TopBar
        right={
          <>
            <button
              style={{
                ...topBarActionStyle,
                opacity: isDirty ? 1 : 0.3,
                cursor: isDirty ? 'pointer' : 'default',
              }}
              onClick={isDirty ? handleSave : undefined}
              title={isDirty ? 'Save (Cmd+S)' : 'No changes'}
              disabled={!isDirty}
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
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
            {onBack && (
              <button style={topBarActionStyle} onClick={onBack} title="Back to file tree">
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
          </>
        }
      >
        <span style={S.path}>
          {filePath}
          {isDirty && (
            <span style={S.dirtyStar} title="Unsaved changes">
              {' '}
              *
            </span>
          )}
        </span>
      </TopBar>
      <div ref={editorRef} style={S.editor} />
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
  dirtyStar: {
    color: 'var(--danger)',
    fontWeight: 700,
  },
  editor: {
    flex: 1,
    overflow: 'hidden',
  },
};
