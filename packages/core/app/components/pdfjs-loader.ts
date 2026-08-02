// Loads pdf.js at runtime from the host-served `/pdfjs` route — which serves the
// `pdfjs-dist` package straight from the host's node_modules (see the server's
// `pdfjsDistDir` static mount) — instead of bundling pdf.js into the Vite client.
// pdf.js (lib + worker + viewer + CSS) is ~2 MB of third-party browser code; per
// `docs/client-bundle-policy.md` it must not land in the
// `@omniterm/host` tarball. Type-only imports keep full typing without emitting a
// bundled dependency; the actual modules arrive via dynamic URL import.

// Type-only module shapes (erased at build — no bundled import is emitted).
type PdfjsLibModule = typeof import('pdfjs-dist');
type PdfjsViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs');

export interface Pdfjs {
  lib: PdfjsLibModule;
  viewer: PdfjsViewerModule;
}

const PDFJS_BASE = '/pdfjs';

let pending: Promise<Pdfjs> | null = null;

/**
 * Resolve the pdf.js lib + viewer modules from the served route, set the worker
 * source, and inject the viewer CSS. Memoized so repeat/concurrent PDF opens
 * share one network load; a failed load is evicted so it can be retried.
 */
export function loadPdfjs(): Promise<Pdfjs> {
  if (pending) return pending;
  pending = (async () => {
    // Order matters: the prebuilt web/pdf_viewer.mjs reads the core from
    // `globalThis.pdfjsLib` (it has no import of the build lib), so the core
    // must be loaded and exposed as that global BEFORE the viewer is imported.
    // `@vite-ignore`: these are runtime URLs served by the host, intentionally
    // not static imports, so Vite must not try to resolve/bundle them.
    const lib = (await import(/* @vite-ignore */ `${PDFJS_BASE}/build/pdf.min.mjs`)) as PdfjsLibModule;
    (globalThis as { pdfjsLib?: PdfjsLibModule }).pdfjsLib = lib;
    const viewer = (await import(/* @vite-ignore */ `${PDFJS_BASE}/web/pdf_viewer.mjs`)) as PdfjsViewerModule;
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
    injectViewerCss(`${PDFJS_BASE}/web/pdf_viewer.css`);
    return { lib, viewer };
  })().catch((err) => {
    pending = null;
    console.error('[pdfjs-loader] failed to load pdf.js from /pdfjs', err);
    throw err;
  });
  return pending;
}

function injectViewerCss(href: string): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-pdfjs-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute('data-pdfjs-css', '');
  document.head.appendChild(link);
}
