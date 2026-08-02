# Agent Test: richer file viewers (image, PDF, CSV/TSV)

## Instructions

You are a testing agent for **omniterm** (the generic browser-based terminal host)
verifying feature **005 — richer file viewers**. Execute this case against the
target environment using a browser-automation MCP, terminal commands, and HTTP
requests.

Do not mark PASS without concrete, auditable browser evidence (an HTML report +
screenshots + the captured browser console log). This case has two phases:

1. **Environment preflight**: confirm the target can execute the case (repo
   builds the client, host boots rooted at the fixtures workspace, the raw route
   serves a fixture).
2. **Product verification**: open each dedicated viewer and assert it renders and
   behaves correctly.

If environment preflight fails, do not run product verification — report
`Status: BLOCKED` with the concrete blocker (e.g. `target_environment_missing`,
`client_build_failed`, `host_startup_failed`, `raw_route_unreachable`). Once
preflight is ready, product verification must return exactly PASS or FAIL.

If the orchestrator interrupts execution before there is enough evidence, write
`Status: ABORTED` (not PASS/FAIL/BLOCKED) and explain the interruption.

When the orchestrator provides `AGENT_VERIFICATION_REPORT_PATH`, write the report
to that exact path. Otherwise write to
`agent-test-reports/file-viewers-richer-file-viewers-<YYYYMMDD-HHMMSS>.md`.

The report must include: Status; target + URLs used; fixture setup performed;
evidence collected (with the browser evidence path/URL); findings; commands/pages
inspected; cleanup performed; follow-up. End with exactly one line:
`Status: PASS` | `Status: FAIL` | `Status: BLOCKED` | `Status: ABORTED`.

## Requirements

- **005 / FR-001, FR-013, FR-015** — Image / PDF / CSV / TSV files dispatch by
  extension to a dedicated **in-place** viewer (one tab per file, no text-editor
  tab), driven by the single source of truth `detectViewerKind`.
- **005 / FR-003** — Viewers fetch bytes through the path-confined raw route
  (`/api/preview/raw`) with correct content types; no new file route.
- **005 / FR-004, FR-005** — Image viewer renders fit-to-pane, zooms, and shows
  filename + pixel dimensions + byte size in a footer.
- **005 / FR-006** — SVGs render as `<img>` and their embedded scripts do **not**
  execute against the app origin (no markup injection).
- **005 / FR-007, FR-008, SC-001, SC-002** — PDFs render via pdf.js with a
  selectable text layer and a working in-document find.
- **005 / FR-009, FR-010, SC-003** — CSV/TSV render as a virtualized table with a
  sticky header + row numbers, auto-detected delimiter, BOM stripped, read-only,
  responsive at 100k rows.
- **005 / FR-002, SC-005** — `.ico` opens in the image viewer (regression: it was
  image-rendered before the base64 path was removed and must stay so).

Sources:

- `specs/005-richer-file-viewers/spec.md`
- `specs/005-richer-file-viewers/quickstart.md` (scenario list this case mirrors)
- `specs/005-richer-file-viewers/contracts/viewer-dispatch.md`

## Project Context

- Product/project name: `omniterm`
- Local URLs: host on `http://127.0.0.1:${OMNITERM_PORT:-17821}` (boot it below).
- Staging URLs: none (local-only project). Production URLs: none.
- Fixture setup and mutation policy: the committed fixtures under
  `tests/agent/fixtures/file-viewers/` are read-only test data. The case may boot
  and kill its own omniterm host, generate `big.csv` in that dir at runtime, and
  use an isolated `SETTINGS_DIR`.
- Required accounts and organizations: none (no auth).
- Database/log/cloud access: none. Host logs go to the boot command's stdout/stderr.
- Production synthetic data policy: n/a.
- Cleanup ownership: this agent — kill the booted host, close the MCP browser
  session, delete the generated `big.csv`, and remove the temp `SETTINGS_DIR`.

## Testing Environments

The orchestrator must specify a target via `AGENT_VERIFICATION_TARGET`. Only
`local` is supported. If unset, stop before preflight and report
`Status: BLOCKED` with blocker `target_environment_missing`. A PASS is valid only
for the selected target.

### Local Development

- Repo root: `<repo root>` (this repo).
- Fixtures dir (absolute): `<repo>/tests/agent/fixtures/file-viewers`.
- Backend setup:
  - `pnpm install` (only if `node_modules` is missing).
  - Build the client so the served bundle includes the 005 code under test:
    `pnpm --filter @omniterm/core build:client`. If it fails, BLOCK
    (`client_build_failed`).
  - Boot the host with an isolated settings dir whose only tracked workspace is
    the fixtures dir, telemetry off, on a free port (default 17821):
    ```bash
    TMP_SETTINGS="$(mktemp -d)"
    printf '{"trackedDirs":["<abs fixtures dir>"],"telemetryEnabled":false}' \
      > "$TMP_SETTINGS/settings.json"
    SETTINGS_DIR="$TMP_SETTINGS" OMNITERM_PORT=17821 OMNITERM_TELEMETRY=0 \
      tsx apps/omniterm/src/server.ts
    ```
    Run it in the background; capture stdout/stderr to a log; wait for
    `Listening on …`. If it exits or the port never opens, BLOCK
    (`host_startup_failed`) — include the log.
- Mutation policy: test-owned host, settings dir, and the generated `big.csv` only.

## Environment Preflight

Prove the selected environment is ready before product verification:

1. Confirm `AGENT_VERIFICATION_TARGET=local`; otherwise BLOCK
   (`target_environment_missing`).
2. Confirm the committed fixtures exist:
   `photo.png logo.svg fav.ico doc.pdf people.csv data.tsv bom.csv` under the
   fixtures dir. If any is missing, BLOCK (`fixtures_missing`).
3. Build the client (command above). If it fails, BLOCK (`client_build_failed`).
4. Boot the host (command above). Wait for `Listening on …`, else BLOCK
   (`host_startup_failed`).
5. Confirm the raw route serves a fixture with the right content type (proves
   delivery + confinement are wired):
   `GET http://127.0.0.1:<port>/api/preview/raw/<url-encoded abs path to people.csv>`
   → HTTP 200 with `Content-Type: text/csv`. If not, BLOCK
   (`raw_route_unreachable`).

## Fixture Preparation

After preflight:

1. Generate the large CSV (≈100k rows, well within the 25 MB cap) into the
   fixtures dir:
   ```bash
   { echo "id,name,value"; for i in $(seq 1 100000); do echo "$i,row$i,$((i*7))"; done; } \
     > "<abs fixtures dir>/big.csv"
   ```
   This file is test-owned and deleted in cleanup.

The committed fixtures are read-only; do not modify them. Note: `logo.svg`
contains an inline `<script>` that, **if executed**, logs
`SVG-SCRIPT-EXECUTED-FAIL` to the console and sets `document.title` to
`SVG-PWNED`. A correct viewer renders the SVG via `<img>`, so neither happens —
this is the FR-006 safety probe.

## Task

Open a browser-automation MCP session **with `record_evidence: true`** at
`http://127.0.0.1:<port>`, then:

1. Select the fixtures-dir workspace in the sidebar (it appears under **OTHERS**
   because it is the only tracked dir), and click **Open files** so the file tree
   is rooted at the fixtures dir. Navigate the tree if needed so the fixture
   files are visible.
2. For each fixture below: click it in the tree, wait for it to load, then
   `inspect_page` (read the DOM; view the screenshot when layout/visual matters).
   Use the DOM text — not the screenshot's index overlay — to resolve element
   indices.
3. After all files: pull `get_browser_console_logs` (errors + warnings).
4. `close_session` (saves video + trace), then `generate_html_report` into the
   report dir, embedding the video/trace, with one `check` per behavior below.

## Suggested Checks

Resolve element indices from the DOM text file each step (the file tree
re-renders as tabs open, so indices shift between inspects).

- **photo.png (image):** renders as an `<img>` fit to the pane; footer shows the
  filename, `96 × 96`, and a byte size. Click **Zoom in** twice → the rendered
  image grows (footer percent increases above 100%).
- **logo.svg (image + FR-006 safety):** renders showing "SVG OK" via an `<img>`
  element (the DOM must NOT contain an injected inline `<svg>`/`<script>` from the
  file). After opening it, the page title is **not** `SVG-PWNED` and the console
  log does **not** contain `SVG-SCRIPT-EXECUTED-FAIL`.
- **fav.ico (image regression):** opens in the **image viewer** (its own tab with
  the image-viewer footer/zoom controls), not the code editor and not garbage
  text. Footer shows dimensions.
- **doc.pdf (PDF):** renders the page text `Hello Omniterm PDF 123456` via pdf.js
  (a `.pdfViewer`/canvas + text layer is present, not raw bytes). Open **Find**,
  search `Omniterm` → a match is highlighted and the match count shows `1/1`.
  (Find working proves the selectable text layer rendered → SC-002.) The network
  log should show pdf.js loaded from `/pdfjs/*` (`build/pdf.min.mjs`,
  `web/pdf_viewer.mjs`, `build/pdf.worker.min.mjs`) — it is served from
  `node_modules`, not bundled (Client Bundle Policy); a 404 on any `/pdfjs/*`
  asset is a regression.
- **people.csv (CSV table):** renders a table with a sticky header
  `# | name | city | score` and a row-number column; the quoted field
  `Smith, J` stays in a **single** cell with `New York` beside it (RFC-4180
  quoting); footer reads `2 rows  3 columns`.
- **data.tsv (delimiter):** renders 3 columns `a | b | c` (tab delimiter
  auto-detected), not a single comma-joined column.
- **bom.csv (BOM strip):** the first header cell is exactly `name` — **not**
  `﻿name` with a leading BOM glyph.
- **big.csv (virtualized scroll, SC-003):** opens as a table; footer reports
  `100,000 rows`. Scroll the table container down a large delta → the visible row
  numbers jump into the thousands and the UI stays responsive (no freeze/crash).
- **Open-in-place (FR-015):** after opening several files, each is its own file
  tab (e.g. `photo.png`, `doc.pdf`, `people.csv` tabs) — there is no separate
  source/editor tab for these files.
- **Console:** no `error`-level logs attributable to the viewers. Benign
  `[files] SSE watchdog timeout, reconnecting` / `[alerts] …` **warnings** are
  expected and allowed; the `SVG-SCRIPT-EXECUTED-FAIL` marker must be absent.

## Expected Evidence

- HTML report (with embedded video + trace) under the report dir.
- `inspect_page` screenshots showing: the rendered image with footer dims, the
  SVG rendered as an image, the `.ico` in the image viewer, the PDF page with a
  highlighted `Omniterm` find match (count `1/1`), the CSV table with the quoted
  cell intact, the TSV 3-column split, the BOM header cell clean, and the 100k
  CSV scrolled to high row numbers.
- The captured console log (showing no viewer errors and no
  `SVG-SCRIPT-EXECUTED-FAIL`).

## Pass Criteria

PASS only if preflight completed AND every Suggested Check holds, all backed by
the auditable artifacts above.

FAIL if preflight completed and any required behavior is broken — e.g. a viewer
shows raw bytes/garbage text, the image footer lacks dimensions, the SVG script
marker appears (FR-006 breach), PDF find finds nothing or no text layer renders,
the quoted CSV field splits across cells, the TSV is not split by tab, the BOM
glyph remains on the header, `.ico` opens as text, the 100k CSV freezes the UI,
or a viewer error appears in the console.

BLOCK (not FAIL) if the client can't build, the host can't boot, the fixtures are
missing, or the raw route is unreachable.

## Cleanup

- Kill the omniterm host process booted by this case; free the port.
- `close_session` on the MCP browser.
- Delete the generated `tests/agent/fixtures/file-viewers/big.csv`.
- Remove the temp `SETTINGS_DIR` created for the run.
