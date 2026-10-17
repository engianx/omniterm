'use client';

import { memo, type CSSProperties } from 'react';
import FileViewer from '../components/FileViewer';
import DiffViewer from '../components/DiffViewer';
import PreviewPane from '../components/PreviewPane';
import DedicatedViewer from '../components/DedicatedViewer';
import { detectViewerKind, isPreviewable } from '../../lib/previewable';
import type { FileTabKind } from './fileTabs';

/** Which change a diff tab shows: unstaged (index -> working tree) or staged (HEAD -> index). */
export type DiffMode = 'worktree' | 'staged';

export interface OpenFile {
  /** Host tab id (`fileTabId`). */
  id: string;
  /** Workspace-relative path; shared by a source/preview pair. */
  path: string;
  /** "source" = editor/diff/dedicated viewer, "preview" = rendered iframe,
   *  "diff" = read-only view of the file's git changes. */
  kind: FileTabKind;
  /** File text (for a diff tab: the changed side). */
  content: string;
  language: string;
  size: number;
  /** The unchanged side for the diff view (a diff tab; or a source tab in
   *  changes-only mode, where it is HEAD); null otherwise. */
  originalContent: string | null;
  isDirty: boolean;
  /** Diff tabs only. */
  diffMode?: DiffMode;
}

interface Props {
  file: OpenFile;
  dirPath: string;
  /** The host's box for this tab (`paneStyleFor`), or null while hidden. */
  paneStyle: CSSProperties | null;
  diff: boolean;
  reloadKey?: number;
  onDirty: (id: string, dirty: boolean) => void;
  onSave: (id: string, path: string, content: string) => Promise<void>;
  onContentChange: (id: string, content: string) => void;
  onOpenPreview: (path: string) => void;
  onReloadPreview: (id: string) => void;
}

/**
 * One keep-alive viewer pane, in the host's pane box for its tab. Hidden panes
 * stay mounted (`display: none`) so CodeMirror state and undo history survive
 * tab switches.
 */
function FilePane({
  file,
  dirPath,
  paneStyle,
  diff,
  reloadKey,
  onDirty,
  onSave,
  onContentChange,
  onOpenPreview,
  onReloadPreview,
}: Props) {
  const viewerKind = file.kind === 'source' ? detectViewerKind(file.path) : null;
  const isActive = paneStyle !== null;
  return (
    <div
      data-file-tab={file.id}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        ...paneStyle,
        display: isActive ? 'flex' : 'none',
        flexDirection: 'column',
        background: 'var(--bg)',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {file.kind === 'preview' ? (
        <PreviewPane
          filePath={file.path}
          dirPath={dirPath}
          reloadKey={reloadKey}
          onReload={() => onReloadPreview(file.id)}
        />
      ) : viewerKind ? (
        <DedicatedViewer kind={viewerKind} filePath={file.path} dirPath={dirPath} />
      ) : diff ? (
        <DiffViewer
          filePath={file.path}
          original={file.originalContent ?? ''}
          modified={file.content}
          language={file.language}
        />
      ) : (
        <FileViewer
          filePath={file.path}
          dirPath={dirPath}
          content={file.content}
          language={file.language}
          isActive={isActive}
          onDirty={(d) => onDirty(file.id, d)}
          onSave={(c) => onSave(file.id, file.path, c)}
          onContentChange={(c) => onContentChange(file.id, c)}
          onOpenPreview={isPreviewable(file.path) ? () => onOpenPreview(file.path) : undefined}
        />
      )}
    </div>
  );
}

export default memo(FilePane);
