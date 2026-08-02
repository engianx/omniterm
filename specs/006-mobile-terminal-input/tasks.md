# Tasks: Mobile Terminal Input (accessory key bar + compose field)

**Feature**: `006-mobile-terminal-input` | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Pure input logic (key→bytes mapping, mode-aware arrows, sticky-Ctrl reducer, feature
detection) is unit-tested per Constitution V. Byte-level delivery is verified end-to-end
against a real `ttyd`+xterm.js via a headless-Chromium check; iOS-device-only behaviors
(focus retention, visualViewport, live dictation) are recorded as residual risks.

**Story → priority**: US1 key bar (P1), US2 sticky Ctrl (P2), US3 compose field (P2).

## Phase 1: Foundational — shared scaffold + injector (blocking)

- [ ] T001 Create `packages/core/plugins/terminal/lib/terminalInput.ts` (pure, no React/DOM types beyond `Window`):
  - `type ArrowDir = 'up'|'down'|'left'|'right'`; `type KeyId` for the bar set.
  - `controlByteForLetter(letter: string): string | null` — `a..z`/`A..Z` → `\x01..\x1a`; null otherwise.
  - `arrowSequence(dir, applicationCursorMode: boolean): string` — `\x1b[A/B/C/D` vs `\x1bOA/B/C/D`.
  - `KEY_BAR: KeyDescriptor[]` default set (Esc, Tab, ↑ ↓ ← →, Ctrl-C, symbols `/ - ~ |`).
  - `getTerminal(win): XtermLike | null` — feature-detect (`typeof win?.term?.input === 'function'` and `win.term.modes` present); never throws.
  - `sendData(win, data: string): boolean` — `getTerminal(win)?.input(data)`; returns false if unavailable.
  - `sendKey(win, keyId): boolean` — resolves a descriptor to bytes (reads `term.modes.applicationCursorKeysMode` live for arrows) and `sendData`.
  - `sendComposed(win, text, run: boolean): boolean` — `sendData(text + (run ? '\r' : ''))`; empty text is a no-op returning false. Never uses `paste`.
- [ ] T002 [P] Create `packages/core/plugins/terminal/lib/terminalInput.test.ts`: cover `controlByteForLetter` (c→\x03, a→\x01, z→\x1a, non-letter→null, case-insensitive), `arrowSequence` both modes × 4 dirs, `sendKey`/`sendData`/`sendComposed` against a fake `win` (stub `term` capturing `input()` args; assert exact bytes, mode-aware arrows, empty-compose no-op, trailing `\r` only when `run`), and `getTerminal` feature-detection (missing `term`, missing `input`, missing `modes` → null; never throws).
- [ ] T003 Edit `packages/core/plugins/terminal/components/TerminalView.tsx`: convert to `forwardRef<HTMLIFrameElement, Props>`, merging the forwarded ref with the existing internal `iframeRef` (both must point at the iframe). No behavior change otherwise.
- [ ] T004 Edit `packages/core/plugins/terminal/integration.tsx`: in `renderTerminalLayer`, keep a `useRef<HTMLIFrameElement|null>` set (callback ref) from the **active** tab's `TerminalView`; when `isMobile`, render a single `<MobileInputChrome getWindow={() => activeIframeRef.current?.contentWindow ?? null} />` inside the terminal layer. Inactive tabs do not write the ref.

**Checkpoint**: `term.input()` delivery + active-iframe access exist and are unit-tested; an empty mobile chrome mounts only on mobile. Typecheck green; desktop untouched.

## Phase 2: User Story 1 — key bar: Esc/Tab/arrows/Ctrl-C (P1) 🎯 MVP

**Goal**: A scrollable key bar pinned above the soft keyboard sends Esc, Tab, arrows (mode-faithful), and one-tap Ctrl-C; the keyboard stays open across taps.

**Independent test**: On iPhone Safari+Chrome, focus a terminal → bar shows above keyboard; tap Ctrl-C interrupts `sleep 100`; ↑ recalls history; arrows navigate `less`/`vim` correctly; Esc exits insert mode; keyboard never closes on tap.

- [ ] T005 [US1] Create `packages/core/plugins/terminal/components/MobileInputChrome.tsx`: render the key-bar row from `KEY_BAR` using inline styles + theme tokens (`var(--bg-secondary)`, `var(--border)`, `var(--text)`, `var(--accent)`); each button `onPointerDown`/`onMouseDown`/`onTouchStart` calls `preventDefault()` (focus retention — keyboard stays open) and `onClick`→`sendKey(getWindow(), id)`. Position fixed, docked to the bottom and offset by the soft-keyboard height via `visualViewport` (resize/scroll listeners updating bottom inset); horizontal scroll for overflow. Disable/hide when `getWindow()` has no usable `term` (feature-detect).
- [ ] T006 [US1] Mount-state polish in `MobileInputChrome.tsx`: a `visualViewport` effect (added/removed cleanly) tracks keyboard height; the bar hides when no keyboard is shown if that proves correct on device, else stays pinned to the bottom safe-area (`env(safe-area-inset-bottom)`). One-tap **Ctrl-C** is a dedicated bar key sending `\x03`.

**Checkpoint**: US1 functional; byte-correctness verifiable via the headless-ttyd check (Phase 5).

## Phase 3: User Story 2 — sticky Ctrl modifier (P2)

**Goal**: A `Ctrl` key arms for the next single keypress with a visible armed state, sends the control byte for the next letter, then disarms.

**Independent test**: Tap Ctrl → armed highlight; tap `r`→reverse-search, `l`→clear, `d`→EOF; armed clears after one key; tapping Ctrl while armed disarms; non-combining next key is defined + clears.

- [ ] T007 [P] [US2] Add a sticky-Ctrl reducer to `terminalInput.ts`: `type CtrlState = 'idle'|'armed'`; `ctrlReducer(state, action)` for `arm`/`toggle`/`consume`/`clear`; plus `applyArmedCtrl(letter): string | null` (control byte) used when consuming a letter. Extend `terminalInput.test.ts` for arm→consume→idle, toggle off, clear, non-letter consume behavior.
- [ ] T008 [US2] Wire sticky Ctrl into `MobileInputChrome.tsx`: a `Ctrl` bar button toggles armed state (visible highlight via `var(--accent)`); while armed, the next letter typed (captured from the focused field or the next bar key) is sent as its control byte and the state clears; clear armed state on blur / keyboard dismissal. Provide a defined path when the next input is a non-combining bar key (arrow/Esc) — send that key normally and clear.

**Checkpoint**: US2 functional; sticky-Ctrl state machine unit-tested.

## Phase 4: User Story 3 — compose field (dictation fix) (P2)

**Goal**: A real editable field (predictive text off) buffers dictation/typing and sends the line once via `term.input()`, optionally with a trailing CR to execute.

**Independent test**: On iPhone, open compose → dictate "hello world this is a test" → field shows it once (no duplicated fragments) → Send writes it once to the terminal; typed input behaves identically; autocorrect/predictive disabled.

- [ ] T009 [US3] Add the compose field to `MobileInputChrome.tsx`: a `<textarea>` with `autoCorrect="off"`, `autoCapitalize="off"`, `spellCheck={false}`, `autoComplete="off"`; a toggle to open/close it; **Send** (→ `sendComposed(getWindow(), text, false)`) and **Send + Enter** (→ `run=true`) actions; clears on send; empty send is a no-op. The field owns its value so iOS dictation revises in place. While compose is focused, the key bar still targets the terminal via `getWindow()`.
- [ ] T010 [US3] Confirm the compose path never bracket-wraps (uses `sendComposed`/`term.input`, not `paste`) and that send-without-run leaves the text at the prompt unexecuted; covered by a `terminalInput.test.ts` case asserting the exact bytes (`text` vs `text+\r`).

**Checkpoint**: US3 functional; dictation duplication fixed (device-confirmable).

## Phase 5: Verification & Evidence

- [x] T011 Headless-ttyd byte check `packages/core/plugins/terminal/lib/terminalInput.injector.test.ts`: launch a throwaway `ttyd`, load it in `playwright-core` Chromium, hook `term.onData`, and assert via the production injector that Esc→`\x1b`, Tab→`\x09`, Ctrl-C→`\x03`, arrows→`\x1b[A`/`\x1bOA` per `term.modes` (toggle DECCKM with `ESC[?1h/?1l`), and compose text arrives once with no bracketed-paste markers (toggle `ESC[?2004h`). Dispatch from the **parent** frame to mirror production. Skip cleanly (not fail) when `ttyd` or Chromium is absent.
- [x] T012 `pnpm -r typecheck` and `pnpm -r test` green; confirm the entry-chunk size gate is unaffected (no new deps; small component).
- [x] T013 Add `tests/agent/mobile-terminal-input/mobile-terminal-input.md`, covering browser-verifiable behavior and recording live iOS focus, keyboard placement, and dictation as device-pending.
- [x] T014 Reconcile spec/plan/tasks drift, set the spec status to implemented, and retain the real-device residual risk.

## Dependencies & parallelism

- Phase 1 (T001–T004) blocks everything. T002 [P] runs alongside T001's review.
- US1 (Phase 2) is the MVP and should land first. US2 (Phase 3) and US3 (Phase 4) are
  independent slices on the same component; T007 [P] (reducer + tests) can be authored in
  parallel with US1 polish.
- Phase 5 runs after the slices it verifies are present.
