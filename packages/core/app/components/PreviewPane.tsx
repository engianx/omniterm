'use client';

import { useEffect, useRef, useState } from 'react';
import TopBar, { topBarActionStyle } from './TopBar';
import { detectPreviewKind, rawPreviewUrl } from '../../lib/previewable';

interface Props {
  /** Path relative to dirPath (matches FileTab.path). */
  filePath: string;
  /** Workspace root absolute path (matches FileTab.dirPath). */
  dirPath: string;
  /** Bumped by the parent when the user wants a manual reload. */
  reloadKey?: number;
  /** Mobile back affordance, mirrors FileViewer's. */
  onBack?: () => void;
}

/**
 * Render a sandboxed iframe preview of a markdown or HTML file.
 *
 * - Markdown: server endpoint `/api/preview/markdown` returns a self-contained
 *   styled HTML doc. We load it via `srcdoc` so no further network fetches
 *   happen. Sandbox is empty — no scripts, no forms, no top navigation.
 * - HTML: iframe `src` points at `/api/preview/raw/<absolute path segments>`.
 *   The browser resolves relative `<img>`, `<script>`, `<link>` URLs against
 *   the iframe URL, so sibling assets are fetched through the SAME route
 *   (which is path-confined). Sandbox is `allow-scripts` so the user's page
 *   can be interactive — `allow-same-origin` is intentionally omitted to
 *   keep the page from poking at omniterm's own APIs.
 */
export default function PreviewPane({ filePath, dirPath, reloadKey, onBack }: Props) {
  const [markdownDoc, setMarkdownDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const kind = detectPreviewKind(filePath);
  const absPath = `${dirPath}/${filePath}`;

  useEffect(() => {
    if (kind !== 'markdown') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/preview/markdown?path=${encodeURIComponent(absPath)}`);
        if (!res.ok) {
          const msg = await res.text().catch(() => `${res.status}`);
          if (!cancelled) setError(msg || `Preview failed: ${res.status}`);
          return;
        }
        const text = await res.text();
        if (!cancelled) setMarkdownDoc(text);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, absPath, reloadKey]);

  if (kind === null) {
    return (
      <div style={S.container}>
        <TopBar
          right={
            onBack ? (
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
            ) : null
          }
        >
          <span style={S.path}>{filePath}</span>
        </TopBar>
        <div style={S.empty}>Preview not supported for this file type.</div>
      </div>
    );
  }

  // Build the raw URL for HTML preview via the shared helper (segment-encoded,
  // slashes preserved); append the reload nonce so a saved file re-fetches.
  const rawUrl = `${rawPreviewUrl(absPath)}${reloadKey ? `?_r=${reloadKey}` : ''}`;

  return (
    <div style={S.container}>
      <TopBar
        right={
          onBack ? (
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
          ) : null
        }
      >
        <span style={S.path} title={absPath}>
          {filePath}
        </span>
      </TopBar>
      <div style={S.iframeWrapper}>
        {error ? (
          <div style={S.error}>{error}</div>
        ) : kind === 'markdown' ? (
          loading && !markdownDoc ? (
            <div style={S.empty}>Rendering…</div>
          ) : (
            <iframe
              ref={iframeRef}
              title={`Preview of ${filePath}`}
              sandbox=""
              srcDoc={markdownDoc ?? ''}
              style={S.iframe}
            />
          )
        ) : (
          <iframe
            ref={iframeRef}
            title={`Preview of ${filePath}`}
            sandbox="allow-scripts"
            src={rawUrl}
            style={S.iframe}
          />
        )}
      </div>
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
  iframeWrapper: {
    flex: 1,
    minHeight: 0,
    background: 'var(--bg)',
    position: 'relative',
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    background: 'var(--bg)',
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
  error: {
    padding: '16px',
    color: 'var(--danger, #f85149)',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'pre-wrap',
  },
};
