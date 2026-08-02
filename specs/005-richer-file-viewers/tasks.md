# Tasks: Richer File Viewers (Image, PDF, CSV/TSV)

**Feature**: `005-richer-file-viewers` | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Tests are scoped to the pure-logic surfaces (dispatch, CSV parse, image-zoom math)
per Constitution V; the viewer UIs are validated via [quickstart.md](./quickstart.md)
and `tests/agent/file-viewers/richer-file-viewers.md`.

**Story → priority**: US1 Image (P1), US2 PDF (P1), US3 CSV/TSV (P2).

## Phase 1: Setup

- [x] T001 Add dependencies `pdfjs-dist@^5.7` and `@tanstack/react-virtual@^3.13` to `packages/core/package.json` (`dependencies`), then run `pnpm install` from repo root and confirm lockfile updates. These must remain referenced only from lazily-imported modules (see T004/Phase 4/Phase 5).

## Phase 2: Foundational (blocking — complete before any user story)

- [x] T002 [P] Extend `packages/core/lib/previewable.ts`: add `type ViewerKind = 'image' | 'pdf' | 'csv'`, `detectViewerKind(filePath): ViewerKind | null` (image: png/jpg/jpeg/gif/webp/svg/avif; pdf: pdf; csv: csv/tsv), and `rawPreviewUrl(absPath: string): string` (segment-encoded `/api/preview/raw/...`). Keep existing `detectPreviewKind`/`isPreviewable` unchanged.
- [x] T003 [P] Add `packages/core/lib/previewable.test.ts`: cover `detectViewerKind` for each extension + case-insensitivity + null fallback; `rawPreviewUrl` segment encoding (spaces, nested dirs, leading slash); and that `detectViewerKind` and `detectPreviewKind` never both return non-null for the same extension.
- [x] T004 Create `packages/core/app/components/DedicatedViewer.tsx`: a `kind`-dispatched component using `React.lazy(() => import('./ImageViewer'))` etc. wrapped in `<Suspense>` (loading fallback), rendering a shared `TopBar` (path + optional `onBack`). Props per contract C4 (`kind`, `filePath`, `dirPath`, `isActive?`, `onBack?`). Unimplemented kinds render a clear "viewer unavailable" fallback (branches are filled in per story). MUST NOT statically import `pdfjs-dist`/`@tanstack/react-virtual`.
- [x] T005 Wire dispatch in `packages/core/app/components/FilePanel.tsx`: in `openFile`, when `detectViewerKind(filePath)` is non-null, append a lightweight `source` tab (no `mode=read` fetch) and `track('file_opened_viewer', { kind })`; in `renderTabPane`, when the tab's path has a `ViewerKind`, render `<DedicatedViewer .../>`; in the hydrate effect, restore viewer-kind paths without a content fetch. Remove the `tab.language === 'image'` branch and its `S.imageViewer*`/`S.image*` styles.
- [x] T006 Migrate `packages/core/app/components/PreviewPane.tsx`'s inline raw-URL builder to the shared `rawPreviewUrl` from `previewable.ts` (DRY; preserves the `?_r=` reload param).

**Checkpoint**: dispatch + lazy shell exist; opening an image/pdf/csv routes to `DedicatedViewer` (fallback until each viewer lands). Build still green; entry chunk unaffected.

## Phase 3: User Story 1 — View images properly (P1) 🎯 MVP

**Goal**: Images render fit-to-pane with zoom/pan/pinch and a name/dimensions/size footer, fed by the raw route; the old base64 path is removed.

**Independent test**: Open png/jpg/svg/webp/gif/avif → image renders, footer shows dims + size, zoom/reset/pinch + pan work, oversized → "too large", broken → clear message.

- [x] T007 [P] [US1] Create `packages/core/app/components/image-viewer-zoom.ts`: pure helpers — zoom clamp (min/max/step), fit-to-pane scale, and anchored-zoom layout math. No React/DOM.
- [x] T008 [P] [US1] Create `packages/core/app/components/image-viewer-zoom.test.ts`: clamp bounds, reset-to-fit, anchored-zoom offset math.
- [x] T009 [US1] Create `packages/core/app/components/ImageViewer.tsx`: fetch `rawPreviewUrl(absPath)` as a blob → object URL `<img src>` (revoke on unmount/source change); dimensions from `onLoad` `naturalWidth/Height`, byte size from `blob.size`; zoom in/out/reset buttons + ctrl+wheel pinch (non-passive listener) + drag-to-pan when zoomed; footer with filename, `W x H`, size; "too large" (on 413) and load-failure messages. SVG goes through the same `<img>` path (no markup injection).
- [x] T010 [US1] Add the `image` branch to `DedicatedViewer.tsx` (lazy-import `ImageViewer`).
- [x] T011 [US1] Remove image special-casing from `packages/core/server/routes/fs.ts`: delete the `EXT_TO_MIME` table, the base64 data-URI branch, and the `trackFileOpened('image')` call (images now stream through `/api/preview/raw`). Leave the text-read path intact.

**Checkpoint**: US1 fully functional and independently demoable.

## Phase 4: User Story 2 — View PDF documents (P1)

**Goal**: PDFs render page-by-page with zoom/fit-width, selectable+copyable text, and in-document find.

**Independent test**: Open a multi-page PDF → pages render + navigate; zoom/fit-width; select+copy text matches; find highlights + steps; password-protected/corrupt → clear message.

- [x] T012 [P] [US2] Create `packages/core/app/components/PdfFind.tsx`: a find bar dispatching pdf.js `find`/`findagain`/`findbarclose` via an `EventBus` ref; prev/next + match-count display; close on Escape.
- [x] T013 [US2] Create `packages/core/app/components/PdfViewer.tsx`: set `GlobalWorkerOptions.workerSrc` from `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`; build `PDFViewer`+`EventBus`+`PDFLinkService`+`PDFFindController` from `pdfjs-dist/web/pdf_viewer.mjs` (+ its CSS); `getDocument({ url: rawPreviewUrl(absPath) })`; page scroll/nav, zoom in/out + fit-to-width, text layer enabled; full teardown on unmount (destroy loadingTask/doc, `setDocument(null)`, remove bus listeners); `PasswordException` → "password-protected", other → "failed to load".
- [x] T014 [US2] Add the `pdf` branch to `DedicatedViewer.tsx` (lazy-import `PdfViewer`); confirm the worker asset and pdf.js land in a separate chunk, not the entry chunk.

**Checkpoint**: US2 functional and independently demoable.

## Phase 5: User Story 3 — View CSV/TSV as a table (P2)

**Goal**: Delimited files render as a virtualized table (sticky header, row numbers, detected delimiter), responsive at 100k+ rows, read-only.

**Independent test**: Open csv + tsv → correct delimiter + columns; sticky header + row numbers; 100k rows scroll smoothly; ragged rows render with empty cells; no edit affordance.

- [x] T015 [P] [US3] Create `packages/core/app/components/csv-parse.ts`: `detectCsvDelimiter(filePath, content)` (`\t` for `.tsv`, else sniff `, \t ;` on first non-empty lines, default `,`) and `parseCsv(content, delimiter): { rows: string[][], maxColumns }` (RFC-4180 quotes/escapes/embedded newlines).
- [x] T016 [P] [US3] Create `packages/core/app/components/csv-parse.test.ts`: delimiter detection (csv/tsv/semicolon/default), quoted fields with commas/newlines/escaped quotes, ragged rows → `maxColumns`, empty file.
- [x] T017 [US3] Create `packages/core/app/components/CsvViewer.tsx`: fetch `rawPreviewUrl(absPath)` as text → `parseCsv`; CSS-grid table with shared `grid-template-columns`, sticky header row + sticky row-number column, sampled+clamped column widths, body rows virtualized via `@tanstack/react-virtual`; footer with row/column counts; "Empty file" state; read-only.
- [x] T018 [US3] Add the `csv` branch to `DedicatedViewer.tsx` (lazy-import `CsvViewer`).

**Checkpoint**: all three stories functional.

## Phase 6: Polish & Cross-Cutting

- [x] T019 Run `pnpm -r test` and `pnpm -r typecheck`; fix any failures (new tests: previewable, image-viewer-zoom, csv-parse).
- [x] T020 Run `pnpm --filter @omniterm/host build`; confirm the entry-chunk size gate passes, viewer components are lazy chunks, and pdf.js is served from `/pdfjs/` rather than bundled under `/assets/` (SC-004).
- [x] T021 Manual validation pass per [quickstart.md](./quickstart.md) (all US1/US2/US3 scenarios + regression #16/#17); capture results.
- [x] T022 Add the public agent test, reconcile spec/plan/code drift, and set the spec status to implemented.

## Dependencies & Execution Order

- **Setup (T001)** → **Foundational (T002–T006)** → user stories.
- **US1 (T007–T011)**, **US2 (T012–T014)**, **US3 (T015–T018)** are independent after Foundational; each only edits its own viewer file + appends a branch to `DedicatedViewer.tsx` (serialize the DedicatedViewer edits T010/T014/T018). Recommended order = priority: US1 → US2 → US3.
- **Polish (T019–T022)** after the stories you intend to ship.

## Parallel Opportunities

- T002 ∥ T003 (impl + test of dispatch, same module — author together).
- Across stories: T007/T008 (image zoom) ∥ T012 (PdfFind) ∥ T015/T016 (csv-parse) — different files, no shared edits.
- Viewer components T009, T013, T017 are independent of each other.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)** — images via the raw route with a real
viewer, dispatch + lazy infrastructure in place, base64 path removed. Ship-able alone.
Then layer US2 (PDF) and US3 (CSV/TSV); each is an independent increment that reuses
the dispatch and adds one lazy chunk.
