# Quickstart: Richer File Viewers

How to build, run, and manually validate this feature.

## Build & run

```bash
pnpm install                 # picks up new deps: pdfjs-dist, @tanstack/react-virtual
pnpm --filter @omniterm/core build   # vite client + tsc server
pnpm --filter @omniterm/host build   # full pipeline; runs the entry-chunk size gate
node apps/omniterm/bin/omniterm.js   # launch the host, open the printed URL
```

Dev loop (client only): `pnpm --filter @omniterm/core build:client` then reload.

## Manual validation (maps to acceptance scenarios)

Open the file panel on a workspace that contains sample files.

**Images (US-1)**
1. Open a `.png` / `.jpg` / `.webp` / `.gif` / `.avif` → renders fit-to-pane; footer shows name, `W x H`, size.
2. Zoom in/out/reset buttons + trackpad pinch (ctrl+wheel) scale the image; reset returns to fit.
3. Zoom past the pane, drag → pans.
4. Open a `.svg` → renders as an image (view source of the page: no inline `<svg>` injected, no script execution).
5. Open an image > 25 MB → "too large" message, no crash.

**PDF (US-2)**
6. Open a multi-page `.pdf` → pages render; scroll/navigate through all pages.
7. Zoom in/out/fit-width rescale pages.
8. Select a span of text and copy → pasted text matches.
9. Find (button/shortcut) → matches highlight; step between them.
10. Open a password-protected or corrupt PDF → clear message, no crash.

**CSV/TSV (US-3)**
11. Open a `.csv` → table with sticky header (first row) + row-number column.
12. Open a `.tsv` → tab delimiter detected; columns split correctly.
13. Open a 100k-row CSV (within 25 MB) → smooth scroll, header stays fixed.
14. Open a ragged CSV (uneven column counts) → renders, missing cells empty, no crash.
15. Confirm no editing affordance (read-only v1).

**Regression / first-load (SC-004, SC-005)**
16. Open a `.ts` / `.md` / unknown binary → unchanged behavior (editor / preview pair / binary message).
17. After build, confirm the size gate printed `Eager client bundle: <bytes> (budget 768000)` and passed; confirm `/assets/` contains separate chunks for the viewers and a `pdf.worker` asset.

## Automated checks

```bash
pnpm -r test         # incl. previewable.test.ts (dispatch) + csv-parse.test.ts
pnpm -r typecheck
pnpm --filter @omniterm/host build   # entry-chunk gate (hard fail if a viewer leaks into entry)
```

## Generate sample fixtures (optional)

```bash
# tiny CSV / TSV
printf 'a,b,c\n1,2,3\n4,5,6\n' > /tmp/sample.csv
printf 'a\tb\tc\n1\t2\t3\n'    > /tmp/sample.tsv
# large CSV (~100k rows)
{ echo "id,name,value"; for i in $(seq 1 100000); do echo "$i,row$i,$((i*7))"; done; } > /tmp/big.csv
```

(Use any `.png`/`.pdf` you have for the image/PDF paths.)
