# Phase 1 Data Model: Richer File Viewers

This feature is UI/stream-oriented; "data" here is the small set of client-side
types and the parsed table model. No persistence or schema changes.

## ViewerKind (dispatch classification)

The extension-derived classification that selects an in-place dedicated viewer.

```ts
type ViewerKind = 'image' | 'pdf' | 'csv';
```

- **Derivation**: `detectViewerKind(filePath): ViewerKind | null` — lowercases the
  extension after the last `.`:
  - `image` ← `png jpg jpeg gif webp svg avif`
  - `pdf`   ← `pdf`
  - `csv`   ← `csv tsv`
  - `null`  ← anything else (file keeps existing text/binary behavior)
- **Relationship to `PreviewKind`**: independent. `PreviewKind`
  (`markdown | html`) drives the *source + preview pair*; `ViewerKind` drives the
  *in-place* viewer. A file has at most one of: a `ViewerKind`, an `isPreviewable`
  preview, or plain text/binary handling.
- **Single source of truth**: used by both the tree open-action (decide whether
  to fetch text vs open a viewer tab) and `renderTabPane` (decide which component
  renders), per FR-013.

## RawPreviewUrl (delivery handle)

A function, not stored state: `rawPreviewUrl(absPath: string): string` →
`/api/preview/raw/<url-encoded segments>`. Encodes each path segment, preserving
slashes; the wildcard route rebuilds the absolute path. Shared by `ImageViewer`,
`PdfViewer`, `CsvViewer`, and `PreviewPane` (deduplicating PreviewPane's inline
builder). Subject to the route's 25 MB ceiling and `allowedRoots()` confinement.

## FileTab (existing — unchanged shape, new dispatch)

Existing `FileTab` is reused as-is. For a dedicated-viewer file:
- `kind`: `'source'` (no new kind).
- `content` / `language` / `size`: not used by the viewer (the viewer fetches the
  raw route). On open, these stay empty/default — FilePanel skips the content
  fetch when `detectViewerKind(path) !== null`.
- `originalContent` / `isDirty`: unused (viewers are read-only); `isDirty` stays
  `false`, so no unsaved-changes dialog ever applies.

State transition on open:

```text
file click
  └─ detectViewerKind(path)?
       ├─ non-null → append FileTab{kind:'source', content:'', size:0}; no fetch;
       │             renderTabPane → <Suspense><DedicatedViewer kind .../></Suspense>
       └─ null     → existing path: fetchFileTab(mode=read) → FileViewer/DiffViewer
```

Persistence/hydration: viewer tabs persist as `{path, kind:'source'}` (existing
format — no migration). On hydrate, a path with a `ViewerKind` is restored as a
lightweight tab **without** a `mode=read` fetch (avoids a garbage read for
pdf/csv); only non-viewer source paths are fetched as today.

## DelimitedTable (CSV/TSV parse result)

Produced by `parseCsv`, consumed by `CsvViewer`.

```ts
interface ParsedCsv {
  rows: string[][];   // all rows incl. header; each cell already unquoted/unescaped
  maxColumns: number; // widest row's column count (drives the grid)
}
```

- **Delimiter**: `detectCsvDelimiter(filePath, content)` → `'\t'` if `.tsv`,
  else sniff the first non-empty lines among `, \t ;`, default `,`.
- **Header vs body**: `rows[0]` is the sticky header; `rows[1..]` are virtualized
  body rows. Empty file → `rows: []` → "Empty file" state.
- **Validation / robustness**:
  - Quoted fields may contain the delimiter, escaped quotes (`""`), and newlines.
  - Rows with fewer cells than `maxColumns` render with trailing empty cells
    (no crash) — covers ragged CSVs (US-3 acceptance #4).
  - Column widths are sampled (first N rows) and clamped to a min/max; long
    values ellipsize rather than blow out the layout.
- **Scale**: only the visible window of body rows is rendered (`@tanstack/react-virtual`),
  so 100k rows within the 25 MB ceiling stay responsive (SC-003).

## PdfDocument (transient, pdf.js-managed)

Not an owned type — pdf.js `PDFDocumentProxy` held in a ref for the viewer's
lifetime. Lifecycle: `getDocument({ url })` → `viewer.setDocument(doc)` on success;
on unmount, `loadingTask.destroy()`, `doc.destroy()`, `viewer.setDocument(null)`,
and event-bus listeners removed (prevents worker/listener leaks across opens).
Error states: `PasswordException` → "password-protected" message; other → "failed
to load" message (FR-011 / SC-006).
