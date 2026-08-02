# Phase 0 Research: Richer File Viewers

Resolves the unknowns the spec deferred to planning. Each item: Decision /
Rationale / Alternatives.

## R1 — Binary delivery to the client

**Decision**: All three viewers obtain file bytes from the existing
`GET /api/preview/raw/<abs path>` route. Images and PDFs read it as binary
(`fetch(...).blob()` for images → object URL; pdf.js fetches the URL directly).
CSV/TSV read it as text (`fetch(...).text()`). The URL is built by URL-encoding
each path segment (slashes preserved), exactly as `PreviewPane` already does for
HTML preview.

**Rationale**: The route is already path-confined to `allowedRoots()`, already
sets `Content-Type` via `res.sendFile`, already enforces a 25 MB ceiling, and
already supports HTTP range requests (Express `sendFile`) — which lets pdf.js
stream large PDFs. Reusing it satisfies the "no new unconfined route" constraint
and the uniform 25 MB cap clarification with zero new server surface.

**Alternatives considered**:
- *Keep base64-in-JSON via `/api/fs?mode=read`* — rejected: bloats payload ~33%,
  blocks range requests, and the 1 MB text cap / 10 MB image cap conflict with
  the agreed 25 MB uniform ceiling. The spec explicitly replaces it.
- *New dedicated binary route* — rejected: duplicates the confinement logic the
  raw route already implements; more attack surface to audit.

## R2 — Keeping viewers out of the eager entry chunk

**Decision**: Viewers are loaded with `React.lazy(() => import('./XxxViewer'))`
behind a single `DedicatedViewer` dispatcher rendered inside `<Suspense>`.
`pdfjs-dist` and `@tanstack/react-virtual` are imported **only** from inside
those lazily-imported modules, never from `FilePanel` or any eagerly-loaded
module.

**Rationale**: This mirrors the proven `langExtensions.ts` grammar pattern: Vite
code-splits each dynamic `import()` into its own hashed chunk under
`/assets/`, served by the existing `express.static` immutable handler. The entry
chunk (`index-*.js`, guarded at ≤750 KB in `package.sh`) never references them,
so first load is unchanged. Verified by the existing guard after build.

**Alternatives considered**:
- *Static imports + Vite `manualChunks`* — rejected: the entry-chunk guard
  requires exactly one entry `<script src>`; manual chunking risks tripping it
  and is more fragile than per-component `import()`.
- *Eager-load the lightweight ImageViewer only* — rejected: marginal benefit,
  and a uniform lazy dispatcher is simpler and keeps the entry chunk strictly
  minimal.

## R3 — pdf.js worker bundling/serving

**Decision**: Set the worker via Vite's URL import:
`import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` and assign
`pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl`. Render with the
`pdfjs-dist/web/pdf_viewer.mjs` `PDFViewer` (+ `EventBus`, `PDFLinkService`,
`PDFFindController`) and import `pdfjs-dist/web/pdf_viewer.css`. Document is
loaded with `getDocument({ url: rawUrl })`.

**Rationale**: The `?url` import makes Vite emit the worker as a hashed asset and
hands back its served URL; because the import lives inside the lazily-imported
`PdfViewer`, the worker reference is in the PDF chunk, not the entry chunk. The
bundled `pdf_viewer` module gives a real page-scrolling viewer with a selectable
text layer and a find controller — meeting US-2's text-select + find acceptance
without rebuilding pagination by hand. `getDocument({ url })` lets pdf.js issue
range requests against the raw route instead of buffering the whole file.

**Alternatives considered**:
- *Single-page canvas render via the core API only* — rejected: no built-in text
  layer/find; would require reimplementing scroll + find.
- *CDN-hosted worker* — rejected: omniterm runs offline/locally and must serve
  its own assets; no external fetches.
- *Decode base64 to bytes and `getDocument({ data })`* — rejected with R1: forces
  the whole file into memory and depends on the removed base64 path.

## R4 — Tab/open model (in place)

**Decision**: Per clarification, image/PDF/CSV open **in place** as a single
`source`-kind tab whose render is dispatched to the dedicated viewer by
extension. There is no separate `preview` sub-tab and no "Open Preview" menu
entry for these types (those remain markdown/HTML-only). On open, FilePanel does
**not** fetch file content (the viewer fetches the raw route itself), so opening
a PDF/CSV never triggers a garbage text read.

**Rationale**: Matches the existing image behavior users already have, keeps the
tab model unchanged (still `source`/`preview` kinds), and avoids a wasted/garbage
`mode=read` fetch. The dispatch lives in one helper (`detectViewerKind`) used by
both the tree open-action and `renderTabPane` (FR-013).

**Alternatives considered**:
- *New `viewer` tab kind* — rejected: adds persistence/migration surface for no
  behavioral gain; extension dispatch on the existing `source` kind is enough.
- *Source + preview pair (like markdown)* — rejected by the clarification; these
  files aren't usefully edited as text.

## R5 — CSV/TSV parsing, delimiter detection, virtualization

**Decision**: A small dependency-free `csv-parse.ts` exposes
`detectCsvDelimiter(filePath, content)` (tab if extension is `.tsv`, else sniff
comma vs tab vs semicolon on the first non-empty lines, defaulting to comma) and
`parseCsv(content, delimiter)` (RFC-4180-style: quoted fields, escaped quotes,
embedded newlines; returns `{ rows: string[][], maxColumns }`). The table renders
with `@tanstack/react-virtual` over the body rows in a CSS-grid layout (shared
`grid-template-columns` for header + rows), sticky header, sticky row-number
column, sampled column widths.

**Rationale**: Delimiter detection from extension + content sniff covers `.csv`
and `.tsv` (FR-009). Hand-rolled parsing keeps the parser unit-testable and adds
no dependency. CSS grid (not `<table>`) is required because absolutely-positioned
virtualized rows break a table's column-width sync. Read-only v1 (FR-010).

**Alternatives considered**:
- *A CSV library (PapaParse etc.)* — rejected: another dep for a parser small
  enough to own and test; keeps the chunk lean.
- *`<table>` element* — rejected: column widths desync under virtualization.

## R6 — Image viewer: blob vs direct src, size + dimensions, SVG safety

**Decision**: Fetch the raw route as a `blob`, hold `URL.createObjectURL(blob)`
as the `<img src>`, and revoke it on unmount/source change. Pixel dimensions come
from the `<img>` `onLoad` (`naturalWidth/Height`); byte size from `blob.size`.
Zoom/pan/pinch via CSS transforms with a non-passive `wheel` listener (ctrl+wheel
= trackpad pinch). SVGs render through this same `<img>` path.

**Rationale**: One fetch yields both the renderable source and the exact byte
size (footer) without a separate HEAD. `<img>`-loaded SVG never executes embedded
scripts (image context), satisfying FR-006 without sanitising markup. Revoking
the object URL avoids leaks across tab switches.

**Alternatives considered**:
- *`<img src={rawUrl}>` directly* — viable and simpler, but a second request
  (HEAD) would be needed for byte size; blob gives size for free and a stable
  source across re-renders. Chose blob.
- *Inline `<svg>` / `dangerouslySetInnerHTML`* — rejected: XSS risk; the spec
  forbids markup injection for SVG.

## R7 — `.avif` and the server MIME map

**Decision**: Because images now stream through the raw route (which sets
`Content-Type` from Express's MIME database), `.avif` is served correctly without
a bespoke map. The viewer dispatch (`detectViewerKind`) is what must include
`avif`; the old `EXT_TO_MIME` table in `fs.ts` is removed along with the base64
branch. (`<img>` also content-sniffs, so even an imperfect type renders.)

**Rationale**: Removes the only reason the `.avif` gap mattered (the old
hand-maintained image MIME map) and centralizes type knowledge in Express + the
extension dispatch.

**Alternatives considered**:
- *Extend `EXT_TO_MIME` with avif* — rejected: that table goes away with the
  base64 path; no need to maintain a parallel MIME map.

## R8 — Telemetry for viewer opens (FR-014)

**Decision**: Emit a client-side `track()` event when a dedicated viewer opens
(e.g. `file_opened_viewer` with `{ kind: 'image' | 'pdf' | 'csv' }`), alongside
the existing `file_opened_editor` event. The server-side `trackFileOpened('image')`
call is removed with the base64 branch.

**Rationale**: With open-in-place, no `mode=read` happens for these files, so the
server can't count them; the client is the right place. Keeps the existing curated,
reviewed shape (kind only — never a path or filename). The raw route is unsuitable
for counting (it also serves HTML-preview sibling assets → over-count).

**Alternatives considered**:
- *Count in the raw route* — rejected: over-counts sibling-asset and HTML-preview
  fetches; not 1:1 with a user opening a file.
