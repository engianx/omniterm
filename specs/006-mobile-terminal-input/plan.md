# Implementation Plan: Mobile Terminal Input (accessory key bar + compose field)

**Feature**: `006-mobile-terminal-input` | **Date**: 2026-06-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-mobile-terminal-input/spec.md`; verified mechanism research in [research.md](./research.md).

## Summary

Add a mobile-only terminal input chrome to the React client, hosted by the built-in
terminal plugin. It has two slices over one shared scaffold: (US1/US2) an **accessory
key bar** pinned above the soft keyboard that sends Esc, Tab, arrows, a one-tap Ctrl-C,
and a sticky one-shot Ctrl modifier for arbitrary Ctrl-combos; and (US3) a **compose
field** — a real editable `<textarea>` with predictive text off — that lets iPhone
dictation arrive as a single write instead of duplicated fragments.

All input is delivered through the existing same-origin handle to ttyd's xterm.js
`Terminal` (`iframe.contentWindow.term`) — the same seam the OSC-52 handler already uses.
Delivery uses **`term.input()` with mode-aware sequences**: control bytes (Esc `\x1b`,
Tab `\x09`, Ctrl-letter `\x01..\x1a`) are mode-independent; arrow keys read
`term.modes.applicationCursorKeysMode` live and emit `\x1b[A..D` (normal) or `\x1bOA..D`
(application-cursor) so they stay correct inside TUIs. We never use `term.paste()`
(bracketed-paste wrapping mangles control bytes and suppresses command execution) and we
avoid synthetic `keydown` (cross-frame dispatch + WebKit `keyCode`-reflection risk) —
both were measured in research.md; `term.input()` gives the same bytes deterministically.

The chrome renders only when `isMobile` is true; desktop terminal input is untouched. The
`term` API is feature-detected at runtime (xterm `^5.4.0` floor, build-dependent minor);
when the handle is unavailable the chrome disables itself rather than throwing.

## Technical Context

**Language/Version**: TypeScript 5.8 (strict, ESM), React 18.

**Primary Dependencies**: None new. Uses the existing terminal plugin, `window.visualViewport`
(positioning), and the same-origin `iframe.contentWindow.term` (xterm.js 5.4, shipped by ttyd).

**Storage**: None. No persistence; the default key set is a code constant.

**Testing**: `node:test` via `tsx` (`pnpm -r test`) for the pure input logic; a headless
Chromium (already-vendored `playwright-core`) integration check driving a real `ttyd` to
assert per-mode bytes; `pnpm -r typecheck`.

**Target Platform**: Browser client (React shell in `@omniterm/core`, bundled into
`@omniterm/host`). Runtime target is mobile Safari/Chrome on iOS/iPadOS; desktop unaffected.

**Project Type**: Web application (client + server co-located in `@omniterm/core`); this
feature is client-only inside the built-in terminal plugin.

**Performance Goals**: No measurable impact on the entry-chunk size gate (small component +
pure module, no new deps). Key taps deliver in one synchronous `term.input()` call.

**Constraints**: Deliver only through `iframe.contentWindow.term` — no new server route, no
second input channel. Never `term.paste()` and never bracket-wrap. Keep the soft keyboard
open on bar taps (suppress focus theft via `preventDefault` on pointer-down). Position via
`visualViewport`, not a fixed offset. Gate strictly on `isMobile`. Feature-detect `term`.

**Scale/Scope**: 1 pure logic module (+ its test), 1 React chrome component (key bar +
compose + sticky-Ctrl), a `forwardRef` tweak to `TerminalView`, and active-iframe wiring in
the terminal integration. ~4–5 source files, all under `packages/core/plugins/terminal/`.

## Constitution Check

*GATE: re-checked after design.*

- **I. Specification Authority** — PASS. `spec.md` is ratified (Clarifications recorded) and
  this plan derives from it; `research.md` backs the injection decision. No replaced behavior
  (net-new capability).
- **II. Generic Host (No Product Coupling)** — PASS. Mobile terminal input is generic terminal
  usability inside the built-in terminal plugin; no product-specific dependency or domain
  behavior is added. No new third-party dependency at all.
- **III. Clean Plugin Boundary (NON-NEGOTIABLE)** — PASS / N/A. Work lives in the built-in
  terminal plugin within `@omniterm/core`; nothing statically imports an external plugin and no
  external plugin internals are touched. The chrome reaches only the same-origin ttyd iframe the
  terminal plugin already owns.
- **IV. Runtime Extensibility** — N/A. No plugin loading or manifest surface involved.
- **V. Test And Evidence Discipline** — PASS with a recorded residual risk. Pure logic has unit
  coverage and `tests/agent/mobile-terminal-input/` covers browser behavior; live iOS dictation
  and keyboard placement remain device-pending.
- **Engineering Constraints** — PASS. Node 24+, TS5 strict ESM; client-only; `@omniterm/core`
  stays private and bundled into the host.

**No violations.** No new dependency, no new server route, no tarball-size concern.

## Project Structure

### Documentation (this feature)

```text
specs/006-mobile-terminal-input/
├── spec.md              # Ratified spec
├── research.md          # Verified mechanism (version pin, live API, per-mode bytes)
├── plan.md              # This file
└── tasks.md             # From speckit-tasks
```

### Source Code (repository root)

```text
packages/core/plugins/terminal/
├── lib/
│   ├── terminalInput.ts            # NEW: pure logic + thin injector.
│   │                               #   - KEY_BAR descriptors (Esc/Tab/arrows/Ctrl-C/symbols)
│   │                               #   - controlByteForLetter(), arrowSequence(dir, appCursorMode)
│   │                               #   - stickyCtrl reducer (idle ⇄ armed; consume/toggle/clear)
│   │                               #   - getTerminal(win) feature-detect; sendData(win, data);
│   │                               #     sendKey(win, keyId); sendComposed(win, text, run)
│   └── terminalInput.test.ts       # NEW: unit tests for all pure logic
├── components/
│   ├── TerminalView.tsx            # EDIT: forwardRef<HTMLIFrameElement> so the integration
│   │                               #   can read the active iframe element (keeps internal ref)
│   └── MobileInputChrome.tsx       # NEW: mobile-only UI — key bar row, sticky-Ctrl armed state,
│   │                               #   compose field; visualViewport positioning; focus-retention
│   │                               #   via onPointerDown preventDefault; gated on a getWindow() accessor
└── integration.tsx                 # EDIT: track active session's iframe; when isMobile, render
                                    #   <MobileInputChrome getWindow={…active contentWindow…} /> once
```

**Structure Decision**: Everything lives under the built-in terminal plugin
(`packages/core/plugins/terminal/`) because the chrome is terminal-specific (it calls
`term.*`). The pure input logic is isolated in `lib/terminalInput.ts` so byte-correctness and
the sticky-Ctrl state machine are unit-tested without a DOM. The React component is a thin
shell over that logic. Reaching the active iframe reuses the integration's existing
active-tab knowledge via a `forwardRef` on `TerminalView` — no new context library, no DOM
scraping.

### Injection contract (verified — see research.md)

| Key | Bytes sent via `term.input()` | Mode dependence |
|---|---|---|
| Esc | `\x1b` | none |
| Tab | `\x09` | none |
| Ctrl-C (one-tap) / Ctrl-`<letter>` | `\x03` / `\x01..\x1a` (`code = letter.toUpperCase()−64`) | none |
| ↑ ↓ → ← | `\x1b[A/B/C/D` normal · `\x1bOA/B/C/D` when `term.modes.applicationCursorKeysMode` | **reads mode live** |
| Composed line | the text, then optional `\r` to execute | none; never bracket-wrapped |

## Phasing (maps to spec user stories)

1. **Shared scaffold + injector** (`terminalInput.ts`, `TerminalView` forwardRef, integration
   wiring, empty chrome gated on `isMobile`) — FR-001..004, FR-014.
2. **US1 key bar** (Esc/Tab/arrows/Ctrl-C, focus retention, mode-faithful arrows) — FR-005..008.
3. **US2 sticky Ctrl** (armed state machine) — FR-009, FR-010.
4. **US3 compose field** (dictation fix) — FR-011..013.
5. **Tests + verification + evidence** — SC-001..006 (byte-level automated; device-pending noted).

## Complexity Tracking

| Decision | Why | Alternative rejected because |
|---|---|---|
| `term.input()` + live mode read for arrows (not synthetic `keydown`) | Deterministic, frame-safe, browser-quirk-free; same bytes as keydown (measured) | Synthetic `keydown` risks cross-frame dispatch issues and unverified WebKit `keyCode` reflection; mode-faithfulness is recoverable by reading `term.modes` ourselves |
| Reach active iframe via `TerminalView` `forwardRef` | Reuses the integration's existing active-tab knowledge; minimal change | A new React context is heavier; `document.querySelector` DOM-scraping is fragile to layout changes |
| Chrome lives in the terminal plugin | It is terminal-specific (`term.*`) generic usability | App-shell placement would need a context bridge to the active session for no benefit in v1 |
