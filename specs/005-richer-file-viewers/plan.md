# Implementation Plan: Richer File Viewers (Image, PDF, CSV/TSV)

**Branch**: `005-richer-file-viewers` | **Date**: 2026-06-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-richer-file-viewers/spec.md`

## Summary

Add dedicated, in-place viewers for images, PDFs, and CSV/TSV files in the file
panel. A file's extension selects a viewer (single source of truth shared by the
file-tree open action and tab rendering); the viewer fetches the file's bytes
through the existing path-confined raw route (`/api/preview/raw`) — `<img>`/blob
for images, pdf.js for PDFs, fetch-as-text for delimited data — instead of the
text read used today. Every viewer is a lazily-imported chunk so the eager entry
bundle (≤750 KB gate) carries none of pdf.js or the table virtualizer until such
a file is first opened. The current base64-data-URI image path is replaced.

## Technical Context

**Language/Version**: TypeScript 5.8 (strict, ESM), React 18

**Primary Dependencies**: New (both lazy-loaded into on-demand chunks, never the entry chunk): `pdfjs-dist` ^5.7 (PDF render + text layer + find), `@tanstack/react-virtual` ^3.13 (row virtualization). Existing: Express 5, Vite 8 (client build), CodeMirror 6.

**Storage**: Filesystem only — files read via the existing path-confined raw route. No new persistence.

**Testing**: `node:test` via `tsx` (`pnpm -r test`); client entry-chunk size gate in `apps/omniterm/scripts/package.sh`.

**Target Platform**: Browser client (React shell served from `dist/client`) + Express server, both inside `@omniterm/core` (bundled into `@omniterm/host`).

**Project Type**: Web application (client + server co-located in `@omniterm/core`).

**Performance Goals**: Eager entry chunk stays ≤ 750 KB (currently ~636 KB; the new viewer code must not land in it). A 100k-row CSV (within the 25 MB ceiling) scrolls without perceptible freeze.

**Constraints**: Reuse `/api/preview/raw` (path-confined, 25 MB cap) — no new file route; binary responses carry correct `Content-Type`. SVG rendered via `<img>`/blob (no markup injection). Each viewer dynamically `import()`ed, mirroring `langExtensions.ts`.

**Scale/Scope**: 3 new viewer components + 1 CSV-parse helper + dispatch extension in `previewable.ts` + FilePanel wiring + 1 server cleanup (drop the base64 image branch). ~7–9 source files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Specification Authority** — PASS. spec.md is updated and ratified (clarifications recorded); this plan derives from it. The replaced base64 image path is removed from the active spec (Assumptions) rather than kept as an alternative.
- **II. Generic Host (No Product Coupling)** — PASS. File viewers are generic host capability; `pdfjs-dist` and `@tanstack/react-virtual` are domain-neutral libraries, not product-specific dependencies. Nothing tied to a downstream domain is added.
- **III. Clean Plugin Boundary (NON-NEGOTIABLE)** — PASS / N/A. This is core host functionality, not a plugin. No plugin is statically imported; no plugin internals are touched.
- **IV. Runtime Extensibility** — N/A. No plugin loading or manifest surface involved.
- **V. Test And Evidence Discipline** — PASS. Dispatch, CSV parsing, and image zoom logic have unit coverage; the agent test in `tests/agent/file-viewers/` covers browser behavior.
- **Engineering Constraints** — PASS. Node 24+, TS5 strict ESM. `@omniterm/core` stays private and bundled into the host; new deps live in core.

**No violations.** `pdfjs-dist` is external to the Vite bundle and served from the
installed host dependency at `/pdfjs/`; dedicated viewer components remain lazy.

## Project Structure

### Documentation (this feature)

```text
specs/005-richer-file-viewers/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── viewer-dispatch.md   # Dispatch + raw-route contract
├── checklists/
│   └── requirements.md  # From /speckit-specify
└── tasks.md             # From /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
packages/core/
├── lib/
│   ├── previewable.ts                 # EXTEND: add ViewerKind + detectViewerKind + rawPreviewUrl()
│   └── previewable.test.ts            # NEW: dispatch unit tests
├── app/components/
│   ├── FilePanel.tsx                  # EDIT: extension-dispatch on open; lazy-render dedicated viewers in place; drop language==='image' branch; track() viewer opens; hydrate without text-fetch for viewer kinds
│   ├── DedicatedViewer.tsx            # NEW: lazy dispatcher (React.lazy + Suspense) keeping viewers out of the entry chunk
│   ├── ImageViewer.tsx                # NEW (lazy): blob/<img> render, zoom/pan/pinch, footer (name, dims, size)
│   ├── PdfViewer.tsx                  # NEW (lazy): pdf.js viewer, page nav, zoom/fit-width, text layer, find
│   ├── PdfFind.tsx                    # NEW: PDF find bar (split out for clarity)
│   ├── CsvViewer.tsx                  # NEW (lazy): virtualized grid, sticky header, row numbers
│   ├── csv-parse.ts                   # NEW: delimiter detection + CSV/TSV parsing
│   └── csv-parse.test.ts             # NEW: unit tests
└── server/routes/
    └── fs.ts                          # EDIT: remove base64 data-URI image branch + EXT_TO_MIME (images now via raw route)

apps/omniterm/scripts/package.sh        # VERIFY only: entry-chunk gate must still pass (no edit expected)
```

**Structure Decision**: Single web-app package (`@omniterm/core`) holding both client (`app/`) and server (`server/`). Viewers are React components colocated with the existing `FileViewer`/`PreviewPane`; the dispatch helper lives in `lib/previewable.ts` (already the shared gate for previewable types). No new package, no new server route.

## Complexity Tracking

| Violation / Cost | Why Needed | Simpler Alternative Rejected Because |
|------------------|------------|--------------------------------------|
| Add `pdfjs-dist` (heavy) | Faithful PDF rendering with selectable text layer + find is infeasible to hand-roll | A server-side rasteriser or "download only" fails US-2's text-select/find acceptance; pdf.js is served from the installed dependency and stays out of the Vite bundle |
| Add `@tanstack/react-virtual` | 100k-row table must stay responsive (SC-003) | Rendering all rows freezes the UI; a bespoke virtualizer is more bug-prone for marginal savings; the dep is tiny and lazy |
