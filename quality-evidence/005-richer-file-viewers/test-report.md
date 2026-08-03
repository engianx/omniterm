<!-- RECOVERED EVIDENCE. This file records a verification run performed while
omniterm was developed inside a larger private product, before the host was
open-sourced into this repository. Measurements and dates are left as recorded —
they are historical evidence, not current claims. Vendor identifiers were
scrubbed, and any claim that no longer holds is marked inline (SUPERSEDED /
UNAVAILABLE / EXTERNAL). Proof mappings in the accompanying quality-map.yaml were
reconciled against this repository and are current. -->

# Test Report — 005 Richer File Viewers

**Date**: 2026-06-15 · **Branch**: `005-richer-file-viewers` · **Confidence**: HIGH

## What was verified (automated)

| Check | Command | Result |
|---|---|---|
| Repo unit tests | `pnpm -r test` | **137 pass / 0 fail** (core 128, demo-agent 5, debugger 4) |
| New unit tests | (in core suite) | **21 pass** — `previewable.test.ts` (10), `csv-parse.test.ts` (10 cases), `image-viewer-zoom.test.ts` (5) |
| Typecheck | `pnpm -r typecheck` | clean (all 5 projects) |
| Host build + entry-chunk gate | `pnpm --filter @omniterm/host build` | **pass** — eager bundle 650 452 B / 768 000 B budget |

### New tests, by surface

- **Dispatch** (`previewable.test.ts`): `detectViewerKind` maps every image/pdf/csv extension, is case-insensitive, returns null for non-viewer types; never overlaps `detectPreviewKind`; `rawPreviewUrl` encodes per-segment, preserves slashes, trims leading slashes, escapes `#`/`?`.
- **CSV parse** (`csv-parse.test.ts`): delimiter detection (csv / tsv / semicolon / default-comma), RFC-4180 quoting (quoted delimiters, escaped quotes, embedded newlines), CRLF normalization, ragged-row `maxColumns`, empty input → no rows, TSV split.
- **Image zoom** (`image-viewer-zoom.test.ts`): `clampZoom` bounds, `fitSize` contain + no-upscale + no-measurement no-op, `zoomedSize` = fit × clamped zoom.

## Lazy-loading proof (headline NFR — FR-012 / SC-004)

Build emitted the viewers as **separate chunks**, not in the entry:

```
index-*.js (entry)          650 KB   ← grep pdfjs|GlobalWorkerOptions|react-virtual|useVirtualizer = 0
ImageViewer-*.js            4.8 KB
CsvViewer-*.js              28  KB   (incl. @tanstack/react-virtual)
PdfViewer-*.js              577 KB   + PdfViewer-*.css 277 KB
pdf.worker.min-*.mjs        1.23 MB  (served asset, separate)
```

Entry chunk grew ~636 KB → ~650 KB (FilePanel wiring + dispatch helper only); pdf.js/worker/virtualizer are all out of first load.

## Runtime smoke (server contract — FR-003 / C6)

Launched the host and probed the raw route + fs route (fixtures under `$HOME`):

- `/api/preview/raw/...` → `image/png`, `text/csv; charset=utf-8`, `application/pdf`, all HTTP 200.
- A path under `/tmp` (outside allowed roots) → **403** (confinement intact).
- `/api/fs?mode=read` on a PNG → raw bytes, **no** `data:base64` / `language:image` — confirms the base64 image branch was removed (intended drift); FilePanel no longer calls it for images.

## Browser verification (live omniterm session, recorded)

Ran `/verify` against a running host with real fixtures (PNG, SVG-with-script, ICO,
text-bearing PDF, CSV with a quoted-comma field, TSV, BOM CSV, 100k-row CSV).
**11/11 checks passed; 0 console errors** (only benign SSE-reconnect warnings).

| Check | Result |
|---|---|
| Image renders fit-to-pane + footer (256×256, 180.4 KB) | ✅ |
| Image zoom buttons scale the image | ✅ |
| SVG renders as `<img>` (240×120) — no markup injection (FR-006) | ✅ |
| `.ico` opens in the image viewer (16×16) — regression fix | ✅ |
| PDF renders via pdf.js ("Hello Omniterm PDF 123456"); lazy worker chunk loaded (SC-001) | ✅ |
| PDF find highlights match, shows "1/1"; text layer present ⇒ select/copy (SC-002, FR-008) | ✅ |
| CSV table: sticky header + row numbers; quoted "Smith, J" / "New York" intact (FR-009) | ✅ |
| TSV tab delimiter auto-detected | ✅ |
| BOM CSV: first header cell is clean `name` (review fix) | ✅ |
| 100k-row CSV scrolls responsively (virtualized) (SC-003) | ✅ |
| Open-in-place: each file is its own tab; no editor tab (FR-015) | ✅ |

Recorded report (video + per-step screenshots, 4.8 MB, kept out of git):
`~/.omniterm/reports/005-richer-file-viewers-verify.html`.

Remaining untested edge: `.avif` (no fixture; relies on Express MIME + `<img>` sniff)
and oversized/password failure visuals (code-reviewed, not exercised live).

## Code review (high effort, 7 finder angles)

Ran a multi-angle review of `7ee2d22..HEAD`. Confirmed + fixed in this branch:
- **(HIGH)** lazy viewers had no error boundary → a chunk-load failure would crash the UI; added `ViewerErrorBoundary` in `DedicatedViewer` (degrades to a message, mirrors the grammar-chunk posture).
- **(MED)** `.ico`/`.bmp` regressed (dropped from the removed `EXT_TO_MIME`); re-added to `detectViewerKind` (FR-002 parity).
- **(LOW)** CSV BOM not stripped; `parseCsv` now drops a leading `﻿`.

Left as documented minor v1 limitations: oversized PDF shows a generic "Failed to load" (pdf.js fetches internally), and viewers don't auto-refresh on external file change (no reload nonce). Refuted candidates: PdfFind listener leak (same instance + `isOpen` teardown), trailing-comma "empty field" (correct CSV), Save-&-Close blanking a binary (viewer tabs can't become dirty).

## Repeatable agent test

The manual browser pass above is now captured as a runnable coding-agent test so
re-verification isn't manual next time:

- Case: `tests/agent/file-viewers/richer-file-viewers.md` (registered in the
  `smoke` suite, `tests/agent/agent-test-suites.json`).
- Fixtures: committed under `tests/agent/fixtures/file-viewers/` (~6 KB);
  `big.csv` (100k rows) generated at runtime and cleaned up.
- Run: `pnpm agent:verify --target local --case tests/agent/file-viewers/richer-file-viewers.md`
  (needs an agent engine CLI, e.g. `--engine claude`).
- Notable: `logo.svg` carries an inline `<script>` that logs
  `SVG-SCRIPT-EXECUTED-FAIL` / sets title `SVG-PWNED` if it ever executes — an
  active FR-006 regression probe the case asserts is absent.

## Verdict

Logic and the critical lazy-load/size invariant are proven by automation; the server delivery contract and all three viewer UIs are confirmed in a live recorded browser session (11/11 checks, 0 errors). Confidence HIGH. Ready for PR.
