/**
 * Detect whether a file path is a candidate for the in-editor preview
 * (markdown or HTML). Single source of truth shared between the file
 * panel's context-menu gating and `PreviewPane`'s renderer dispatch —
 * if you add a new previewable extension here, both places pick it up.
 */
export type PreviewKind = 'markdown' | 'html';

export function detectPreviewKind(filePath: string): PreviewKind | null {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

export function isPreviewable(filePath: string): boolean {
  return detectPreviewKind(filePath) !== null;
}

/**
 * A file that opens in a dedicated, in-place viewer instead of the code
 * editor: images, PDFs, and delimited data (CSV/TSV). Unlike `PreviewKind`
 * (which adds a *separate* preview sub-tab beside an editable source tab),
 * a `ViewerKind` file has no editable source view — the viewer is the whole
 * tab. The two never overlap on the same extension.
 *
 * Single source of truth used by both the file tree's open action (decide
 * whether to fetch text or open a viewer) and the tab renderer (decide which
 * component to mount).
 */
export type ViewerKind = 'image' | 'pdf' | 'csv';

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  // ico/bmp were image-rendered by the old data-URI path; keep parity (FR-002).
  'ico',
  'bmp',
]);
const CSV_EXTS = new Set(['csv', 'tsv']);

export function detectViewerKind(filePath: string): ViewerKind | null {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (CSV_EXTS.has(ext)) return 'csv';
  return null;
}

/**
 * Build the URL for the path-confined raw-content route from an absolute
 * filesystem path. URL-encodes each path segment individually so slashes
 * stay as separators; the wildcard server route reconstructs the absolute
 * path with a leading slash. Shared by every dedicated viewer and by
 * `PreviewPane`'s HTML preview so the encoding logic lives in one place.
 *
 * The route (`server/routes/preview.ts`) is confined to `allowedRoots()` and
 * caps responses at 25MB — the single size ceiling for all viewers.
 */
export function rawPreviewUrl(absPath: string): string {
  const trimmed = absPath.replace(/^\/+/, '');
  const encoded = trimmed.split('/').map(encodeURIComponent).join('/');
  return `/api/preview/raw/${encoded}`;
}
