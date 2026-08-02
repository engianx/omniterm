'use client';

import { Component, Suspense, lazy, type ReactNode } from 'react';
import type { ViewerKind } from '../../lib/previewable';

// Each viewer is a separate lazily-imported chunk. Because these import()s are
// the ONLY references to ImageViewer/PdfViewer/CsvViewer (and, transitively,
// pdfjs-dist + @tanstack/react-virtual), Vite code-splits them out of the eager
// entry bundle — they load only when a file of that kind is first opened,
// mirroring the on-demand grammar loading in langExtensions.ts.
const ImageViewer = lazy(() => import('./ImageViewer'));
const PdfViewer = lazy(() => import('./PdfViewer'));
const CsvViewer = lazy(() => import('./CsvViewer'));

interface Props {
  kind: ViewerKind;
  /** Path relative to dirPath (matches FileTab.path). */
  filePath: string;
  /** Workspace root absolute path (matches FileTab.dirPath). */
  dirPath: string;
  /** Mobile back affordance, mirrors FileViewer's. */
  onBack?: () => void;
}

/**
 * Catches a failed viewer-chunk load (offline, stale hashed chunk after an
 * upgrade, dropped tunnel) and degrades to a message instead of letting the
 * rejection unmount the whole app — the same posture langExtensions.ts takes
 * for grammar chunks. Reset by keying on the file (see below).
 */
class ViewerErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn('[omniterm] failed to load file viewer chunk', error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <div style={S.loading}>Failed to load viewer. Check your connection and reopen the file.</div>;
    }
    return this.props.children;
  }
}

/**
 * Dispatches an in-place file viewer by `kind`, loading the concrete viewer's
 * chunk on demand. The Suspense fallback shows while that chunk downloads.
 */
export default function DedicatedViewer({ kind, filePath, dirPath, onBack }: Props) {
  return (
    // Key by file so a transient chunk-load failure on one file doesn't stick
    // when the user opens a different file in the same tab slot.
    <ViewerErrorBoundary key={`${kind}:${dirPath}/${filePath}`}>
      <Suspense fallback={<div style={S.loading}>Loading viewer…</div>}>
        {kind === 'image' ? (
          <ImageViewer filePath={filePath} dirPath={dirPath} onBack={onBack} />
        ) : kind === 'pdf' ? (
          <PdfViewer filePath={filePath} dirPath={dirPath} onBack={onBack} />
        ) : kind === 'csv' ? (
          <CsvViewer filePath={filePath} dirPath={dirPath} onBack={onBack} />
        ) : (
          <div style={S.loading}>Viewer unavailable</div>
        )}
      </Suspense>
    </ViewerErrorBoundary>
  );
}

const S: Record<string, React.CSSProperties> = {
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: 16,
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
};
