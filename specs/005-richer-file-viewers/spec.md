# Feature Specification: Richer File Viewers (Image, PDF, CSV/TSV)

**Feature Branch**: `005-richer-file-viewers`

**Created**: 2026-06-15

**Status**: Implemented

**Input**: GitHub issue #9 (P1, enhancement): "Add dedicated viewers for common non-text / structured files — images, PDFs, and CSV/TSV — so opening them shows the file, not garbage text."

## Clarifications

### Session 2026-06-15

- Q: When a user opens an image/PDF/CSV from the file tree, what opens in the tab model? → A: Open the dedicated viewer **in place** — one tab, no text-editor tab and no separate "Open Preview" sub-tab (matches the existing image behavior; none of these are usefully edited as text).
- Q: What maximum file size governs the new viewers, and what happens past it? → A: Reuse the **existing 25 MB raw-route ceiling** uniformly for all three viewers; the separate 10 MB image cap is dropped so images share the same ceiling. Past the ceiling the viewer shows a "too large" message.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View images properly (Priority: P1)

As someone browsing a workspace in omniterm's file panel, when I open an image
file I want to see the image rendered at a comfortable size, with the ability to
zoom and inspect it, instead of a bare unscaled picture or raw bytes.

**Why this priority**: Images are the most common non-text file people open in a
project (logos, screenshots, diagrams, favicons). A basic image path already
exists but is minimal (no zoom, no metadata) and delivers the bytes inefficiently;
this story turns it into a real viewer and establishes the dispatch pattern the
other viewers reuse. It is the smallest independently shippable slice that
delivers visible value.

**Independent Test**: Open `.png`, `.jpg`, `.svg`, `.webp`, `.gif`, and `.avif`
files from the file tree and confirm each renders as an image fit to the pane,
that zoom in / out / reset work (including trackpad pinch), that the view can be
panned when zoomed beyond the pane, and that a footer shows the filename, pixel
dimensions, and file size.

**Acceptance Scenarios**:

1. **Given** a workspace containing a `.png` file, **When** I open it from the file tree, **Then** the image renders fit-to-pane (not cropped, not raw text) with a footer showing its pixel dimensions and file size.
2. **Given** an open image, **When** I click zoom-in / zoom-out / reset (or pinch on a trackpad), **Then** the displayed image scales accordingly and reset returns it to fit-to-pane.
3. **Given** an image zoomed larger than the pane, **When** I drag within the pane, **Then** the visible region pans.
4. **Given** an `.svg` file, **When** I open it, **Then** it renders as an image without its markup being able to execute scripts against the application.
5. **Given** an image that fails to load (deleted, unreadable, or oversized), **When** I open it, **Then** a clear non-crashing message is shown instead of a broken-image placeholder or raw bytes.

---

### User Story 2 - View PDF documents (Priority: P1)

As someone with PDFs in a workspace (specs, exported reports, design docs), when
I open a `.pdf` I want to read it page by page with selectable text and search,
instead of seeing garbage characters.

**Why this priority**: PDFs are completely unusable today — they render as binary
text in the code editor. This is the highest-impact correctness fix in the issue.
It is independent of the image and CSV stories.

**Independent Test**: Open a multi-page `.pdf`, scroll/navigate through its pages,
zoom and fit-to-width, select and copy a span of text, and search for a word and
step through matches.

**Acceptance Scenarios**:

1. **Given** a multi-page `.pdf`, **When** I open it, **Then** its pages render visually (not as raw bytes) and I can move through all pages.
2. **Given** an open PDF, **When** I zoom in / out / fit-to-width, **Then** the rendered pages rescale accordingly.
3. **Given** an open PDF with embedded text, **When** I select text and copy it, **Then** the copied text matches the selection.
4. **Given** an open PDF, **When** I invoke find and type a term, **Then** matches are highlighted and I can step between them.
5. **Given** a password-protected or corrupt PDF, **When** I open it, **Then** a clear non-crashing message explains why it can't be shown.

---

### User Story 3 - View CSV / TSV as a table (Priority: P2)

As someone inspecting data files, when I open a `.csv` or `.tsv` I want to see it
as a readable table with a fixed header and row numbers, instead of comma-laden
raw text, and it should stay responsive even for very large files.

**Why this priority**: Delimited data is readable-but-awkward as raw text today
(it does not "break" like a PDF), so this is an enhancement rather than a
correctness fix — hence P2. It is independently shippable and reuses the dispatch
pattern from Story 1.

**Independent Test**: Open a `.csv` and a `.tsv` file, confirm the delimiter is
detected correctly, that the first row is treated as a sticky header, that row
numbers are shown, and that a large file (100k+ rows) scrolls smoothly without
freezing the UI.

**Acceptance Scenarios**:

1. **Given** a `.csv` file, **When** I open it, **Then** it renders as a table with the first row as a sticky header and a row-number column.
2. **Given** a `.tsv` file (tab-delimited), **When** I open it, **Then** the tab delimiter is detected and columns are split correctly.
3. **Given** a CSV with 100,000+ rows, **When** I open and scroll it, **Then** scrolling stays responsive and the header stays fixed.
4. **Given** a CSV with rows of uneven column counts, **When** I open it, **Then** the table renders without crashing and missing cells appear empty.
5. **Given** a `.csv` file in v1, **When** I view it, **Then** it is read-only (no in-table editing).

---

### Edge Cases

- **Files with no dedicated viewer** (e.g. `.zip`, unknown binary): behavior is unchanged — they continue to open as text in the code editor or show the existing "binary / not shown" treatment. This feature never regresses existing file types.
- **Oversized files**: each viewer respects a size ceiling and shows a clear "too large" message rather than attempting to render and hanging. (The raw-content route already enforces a server-side ceiling.)
- **A file whose extension lies about its content** (e.g. a text file named `.pdf`): the viewer shows its normal load-failure message rather than crashing.
- **Deleted / moved file while a viewer tab is open**: reopening or refreshing shows a load-failure message; no crash.
- **First-load weight**: opening a small markdown or source file must not pull in any image/PDF/CSV viewer code; that code loads only when such a file is first opened.
- **Empty CSV / single-column CSV / CSV with only a header**: render without error.
- **SVG containing scripts or external references**: rendered so it cannot execute against or exfiltrate from the application origin.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The file panel MUST dispatch a file to a dedicated viewer based on its extension, covering images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`), PDF (`.pdf`), and delimited data (`.csv`, `.tsv`).
- **FR-002**: Files whose extension has no dedicated viewer MUST retain their current behavior (text editor, or existing binary handling). No currently-supported file type may regress.
- **FR-003**: Dedicated viewers MUST obtain file content through the existing path-confined raw-content delivery, not through a newly added unconfined file route. Binary responses MUST carry a correct content type.
- **FR-004**: The image viewer MUST render the image fit-to-pane and support zoom in, zoom out, reset-to-fit, trackpad pinch-to-zoom, and panning when zoomed beyond the pane.
- **FR-005**: The image viewer MUST display the filename, pixel dimensions, and file size for the open image.
- **FR-006**: The image viewer MUST render SVGs as images in a way that prevents embedded scripts/markup from executing against or accessing the application origin.
- **FR-007**: The PDF viewer MUST render document pages visually, allow navigating across all pages, and support zoom and fit-to-width.
- **FR-008**: The PDF viewer MUST provide a selectable, copyable text layer and an in-document find that highlights and steps through matches.
- **FR-009**: The CSV/TSV viewer MUST render the file as a table with the first row as a sticky header and a row-number column, and MUST auto-detect the delimiter (comma vs tab).
- **FR-010**: The CSV/TSV viewer MUST remain responsive for large files (100k+ rows) and MUST be read-only in v1.
- **FR-011**: Each viewer MUST surface a clear, non-crashing message for load failures (unreadable, oversized, password-protected, corrupt, or content not matching the extension). Files exceeding the 25 MB content ceiling MUST show a "too large" message rather than attempting to render.
- **FR-012**: Viewer code for each file type MUST load on demand only when a file of that type is first opened, and MUST NOT be included in the application's initial load. The initial-load size budget MUST stay within its existing gate.
- **FR-013**: The viewer-dispatch decision MUST be a single shared source of truth used by both the file tree's open action and the tab rendering (consistent with how previewable file types are gated today).
- **FR-015**: Opening a supported image/PDF/CSV/TSV file MUST render its dedicated viewer **in place** as the file's single tab — no text-editor tab and no separate "Open Preview" sub-tab for these types. (Markdown/HTML keep their existing source + preview-pair behavior.)
- **FR-016**: All three viewers MUST share a single content-size ceiling of 25 MB (the existing raw-route limit); the previous 10 MB image-specific cap is removed.
- **FR-014**: Opening a file in a dedicated viewer MUST record the same kind of pseudonymous open event already emitted for files (viewer kind only; no path, filename, or content), so existing usage visibility extends to the new viewers.

### Key Entities *(include if feature involves data)*

- **Viewer kind**: the classification derived from a file's extension that selects how it is displayed (image, pdf, csv/tsv, or none → existing text/binary behavior). Single source of truth for both menu/open gating and tab rendering.
- **Raw file content**: the file's bytes delivered over the existing path-confined route with a correct content type; the unit each dedicated viewer consumes.
- **Delimited table model**: the parsed representation of a CSV/TSV file — a header row plus body rows, with a detected delimiter and a column count — consumed by the table viewer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Opening any supported image, PDF, or CSV/TSV file shows the rendered file (image / pages / table), with 0 instances of raw bytes or garbled text shown for these types.
- **SC-002**: A user can open a PDF and select-and-copy a passage of its text, and the copied text matches what is shown — verified on a representative multi-page PDF.
- **SC-003**: A 100,000-row CSV within the 25 MB content ceiling opens and scrolls without the interface becoming unresponsive (no perceptible freeze during scroll).
- **SC-004**: Opening a small text/markdown file pulls in none of the new viewer code; the initial-load size budget remains within its existing gate (no increase that breaks the gate).
- **SC-005**: Every existing (non-image, non-PDF, non-CSV/TSV) file type opens exactly as it did before this feature — no regressions in the existing text/binary handling.
- **SC-006**: Each viewer presents a clear message (not a crash, blank pane, or broken-image icon) for at least these failure cases: oversized file, password-protected/corrupt PDF, and unreadable/missing file.

## Assumptions

- The existing path-confined raw-content route is the delivery mechanism for all dedicated viewers; no new file-serving route is introduced, and its existing 25 MB size ceiling applies uniformly (the previous image-specific 10 MB cap is removed). The current base64-data-URI image path (content embedded in a JSON read) is **replaced** by raw-route delivery for images — recorded as intended drift, not a parallel mechanism.
- Dedicated viewers open **in place** as a file's single tab (no text-editor tab, no source + preview pairing); only markdown/HTML retain the source + preview-pair model.
- Extension-based dispatch is sufficient for v1; content sniffing is not required. A file whose content does not match its extension degrades to that viewer's load-failure message.
- The supported image extension set is the one named in the issue (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`) plus `.ico` and `.bmp` — the latter two were image-rendered by the removed data-URI path, so they are kept in the viewer to avoid regressing previously-supported types (FR-002).
- "Responsive for large files" is achieved by rendering only the visible portion of the table rather than the whole file at once.
- CSV/TSV editing, and viewers for notebooks, audio/video, and office formats, are out of scope for this feature and tracked separately if demand appears.
- The on-demand loading approach and the initial-load size gate established for editor language grammars are the model this feature follows for its viewer code.
- Pseudonymous open-event telemetry already exists for file opens; this feature extends that existing signal to viewer kinds without adding paths, filenames, or content.
