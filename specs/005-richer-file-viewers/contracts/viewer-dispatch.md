# Contract: Viewer Dispatch & Raw-Route Delivery

The interfaces this feature exposes within `@omniterm/core`. No new HTTP route is
introduced; the existing raw route's contract is restated as the dependency.

## C1 — `detectViewerKind(filePath: string): ViewerKind | null`

`packages/core/lib/previewable.ts` (new export).

| Input (extension, case-insensitive) | Output |
|---|---|
| `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif` | `'image'` |
| `pdf` | `'pdf'` |
| `csv`, `tsv` | `'csv'` |
| any other / none | `null` |

Guarantees:
- Pure, synchronous, no I/O.
- Mutually exclusive with the file being treated as plain text/binary: a non-null
  result means the file opens in a dedicated viewer, in place.
- Independent of `detectPreviewKind` (markdown/html preview pair) — the two never
  overlap on the same extension.

## C2 — `rawPreviewUrl(absPath: string): string`

`packages/core/lib/previewable.ts` (new export; `PreviewPane` migrates to it).

- Strips leading slashes, URL-encodes each segment, rejoins with `/`, prefixes
  `/api/preview/raw/`. Example: `/Users/me/a b/x.pdf` →
  `/api/preview/raw/Users/me/a%20b/x.pdf`.
- Callers may append a cache-busting query (`?_r=<n>`) — must not break encoding.

## C3 — Raw route (existing dependency — `GET /api/preview/raw/<segments>`)

Restated; **not modified** by this feature.

- **Confinement**: resolves the reconstructed absolute path against
  `allowedRoots()`; 403 if outside.
- **Size**: 413 if file > 25 MB (`MAX_RAW_BYTES`). This is the uniform ceiling for
  all viewers (FR-016).
- **Content-Type**: set by `res.sendFile` from Express's MIME database — correct
  for `png/jpeg/gif/webp/svg/avif/pdf/csv/tsv` (FR-003). Range requests supported
  (enables pdf.js streaming).
- **Errors**: 404 not-a-file/not-found; 400 missing path; 500 send failure.

Viewer consumption:
- **Image**: `fetch(url).blob()` → object URL → `<img src>`; `blob.size` → footer.
- **PDF**: `pdfjsLib.getDocument({ url })`.
- **CSV/TSV**: `fetch(url).text()` → `parseCsv`.

## C4 — `DedicatedViewer` component (dispatch render)

`packages/core/app/components/DedicatedViewer.tsx` (new).

Props:
```ts
interface DedicatedViewerProps {
  kind: ViewerKind;        // from detectViewerKind
  filePath: string;        // relative (tab.path), for the header/footer label
  dirPath: string;         // workspace root, to build absPath
  onBack?: () => void;     // mobile back affordance (mirrors FileViewer/PreviewPane)
}
```

Guarantees:
- Lazily imports the concrete viewer (`React.lazy` + `Suspense` fallback) so
  `ImageViewer`/`PdfViewer`/`CsvViewer` (and `pdfjs-dist` /
  `@tanstack/react-virtual`) are excluded from the eager entry chunk (FR-012).
- Renders a consistent TopBar (path + optional back) and a per-viewer footer.
- On any load failure, renders a clear non-crashing message (FR-011).

## C5 — Build/packaging invariant (verified, not coded)

- After `pnpm build`, `index.html` references exactly one entry `<script src>` and
  that entry chunk is ≤ 750 KB (`apps/omniterm/scripts/package.sh` guard). The new
  viewers and their libraries appear only as separate `/assets/*.js` chunks plus
  the pdf.js worker asset.

## C6 — Removed behavior (drift recorded)

- `GET /api/fs?mode=read` no longer special-cases images: the `EXT_TO_MIME` table,
  the base64 data-URI branch, and the `trackFileOpened('image')` call are removed.
  Image opens go through `detectViewerKind` → `ImageViewer` → raw route. The
  `language === 'image'` branch in `FilePanel.renderTabPane` is removed.
