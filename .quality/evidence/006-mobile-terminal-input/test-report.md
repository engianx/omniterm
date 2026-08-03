<!-- RECOVERED EVIDENCE. This file records a verification run performed while
omniterm was developed inside a larger private product, before the host was
open-sourced into this repository. Measurements and dates are left as recorded —
they are historical evidence, not current claims. Vendor identifiers were
scrubbed, and any claim that no longer holds is marked inline (SUPERSEDED /
UNAVAILABLE / EXTERNAL). Proof mappings in the accompanying quality-map.yaml were
reconciled against this repository and are current. -->

# Test Report: 006 — Mobile Terminal Input

**Date**: 2026-06-16 · **Spec**: [spec.md](../../specs/006-mobile-terminal-input/spec.md) · **Confidence**: MEDIUM

## What was built

A mobile-only terminal input chrome in the built-in terminal plugin:

- **Key bar** (US1): Esc, Tab, ↑↓←→, one-tap Ctrl-C, and shell symbols (`/ - ~ |`), pinned above the soft keyboard via `visualViewport`, with focus retention so the keyboard stays open on tap.
- **Sticky Ctrl** (US2): a `Ctrl` toggle that arms (visible state) and reveals an on-bar letter strip; a tapped letter sends its control byte and disarms.
- **Compose field** (US3): a real `<textarea>` (autocorrect/predictive off) that buffers dictation/typing and sends once via `term.input()` — Send (no run) or Send+Enter (`⏎`/Enter → trailing `\r`).

Delivery goes through the same-origin `iframe.contentWindow.term` handle. Two-path design from [research.md](../../specs/006-mobile-terminal-input/research.md): `term.input()` with arrow sequences chosen live from `term.modes.applicationCursorKeysMode`; **never** `term.paste()`.

## Files

| File | Change |
|---|---|
| `packages/core/plugins/terminal/lib/terminalInput.ts` | NEW — pure byte logic + thin injector + sticky-Ctrl reducer |
| `packages/core/plugins/terminal/lib/terminalInput.test.ts` | NEW — 23 unit cases |
| `packages/core/plugins/terminal/lib/terminalInput.injector.test.ts` | NEW — wired-in integration byte-check vs live ttyd+xterm (skips when ttyd/Chromium absent) |
| `packages/core/plugins/terminal/components/MobileInputChrome.tsx` | NEW — key bar + sticky Ctrl + compose field; collapsible »/« launcher; one-tap compose focus |
| `packages/core/plugins/terminal/components/TerminalView.tsx` | EDIT — `forwardRef` to expose the active iframe |
| `packages/core/plugins/terminal/integration.tsx` | EDIT — track active iframe; render chrome when `isMobile && activeTerminalVisible` |
| `tests/agent/mobile-terminal-input/mobile-terminal-input.md` | NEW — re-runnable agent test (smoke suite) for the mobile chrome |

## Results

- **Unit + integration** (`pnpm --filter @omniterm/core test`): **169 pass / 0 fail / 0 skipped** — 23 cases in `terminalInput.test.ts` plus the wired-in `terminalInput.injector.test.ts` live-terminal byte check.
- **Workspace** (`pnpm -r typecheck && pnpm -r test`): typecheck clean (5 projects); all suites pass (core 169 + demo-agent 5 (+ 7 in the plugin, then in-tree)). No regressions.
- **Live-terminal byte check** — now a wired-in test (`terminalInput.injector.test.ts`, runs under `pnpm test`; skips cleanly where `ttyd`/Chromium are absent). The **real production module** is esbuild-bundled into a headless Chromium page on a live `ttyd` (xterm.js 5.4) — **ALL PASS (10/10)**:

```
PASS  Esc                          got=\x1b            want=\x1b
PASS  Tab                          got=\x09            want=\x09
PASS  Ctrl-C                       got=\x03            want=\x03
PASS  Ctrl-R (sticky letter)       got=\x12            want=\x12
PASS  Arrow up (normal)            got=\x1b[A          want=\x1b[A
PASS  Arrow up (DECCKM)            got=\x1bOA          want=\x1bOA
PASS  Compose (no run)             got=abc             want=abc
PASS  Compose (run → +CR)          got=ls -la\r        want=ls -la\r
PASS  DECCKM reflected             term.modes.applicationCursorKeysMode=true
PASS  bracketedPaste reflected     term.modes.bracketedPasteMode=true
```

This proves the shipped injector produces correct bytes against the real terminal, including mode-faithful arrows (same descriptor → `ESC[A` normal vs `ESC O A` under live DECCKM) and compose-never-wrapped under live bracketed-paste mode.

- **Full-app integration smoke** (built client + running host at a 390×844 mobile viewport, `hasTouch`): the key bar renders in the real app (`Ctrl Esc Tab ^C ↑ ↓ ← → / - ~ | 💬`, 0 console errors — see `mobile-keybar-landing.png`), a terminal auto-opens, and **tapping bar buttons drives the live terminal through the entire production chain** (`forwardRef` → integration active-iframe tracking → `getWindow` → `MobileInputChrome` → `term.input`):

```
Tap Esc   → \x1b          Tap ^C    → \x03          Tap ↑ → \x1b[A
Tap Ctrl  → letter strip appears (a–z)              Tap r → \x12 (Ctrl-R)
Compose "echo hi" → Send → "echo hi"  (no bracketed-paste wrapper, no CR)
```

This is the end-to-end proof that the React wiring — not just the isolated injector — delivers correct bytes from a tap to the PTY.

## Regression coverage (added 2026-06-17)

The byte check and the component/integration behaviors are now guarded by re-runnable tests, not just one-off manual passes:

- **`terminalInput.injector.test.ts`** — the live-ttyd byte check above, converted into a `node:test` that runs as part of `pnpm test`. It self-skips when `ttyd` or the Chromium binary is unavailable (so CI without them stays green) and runs for real on dev machines.
- **`tests/agent/mobile-terminal-input/mobile-terminal-input.md`** — a re-runnable agent test registered in the `smoke` suite (`agent-test-suites.json`). It drives a mobile-viewport browser and asserts: collapsed `»` by default → expand → `«`+keys; one-tap `💬` focus (typing lands first try); compose `⏎` runs the command **once** with no `[200~` artifacts; `Send` doesn't execute; `↑` recalls history; `^C` interrupts `sleep`; sticky `Ctrl`+`l` clears + disarms; collapse persists across reload. Booted with the terminal **DOM renderer** so terminal output is assertable from the DOM.

## Post-review iterations (2026-06-17)

After the first device test surfaced "dictation still repeating" and UI feedback, these landed in `MobileInputChrome.tsx`:

- **Compose field made uncontrolled** — the field now owns its value (read via ref on Send), the mechanism the iOS-dictation fix actually requires; a controlled `value` had re-introduced the duplication.
- **Compose discoverability** — the toggle is pinned (was scrolling off-screen).
- **Collapsible chrome** — collapsed `»` launcher by default (persisted in `localStorage`), expands to `«`+keys, toggles in place; size/colour/position iterated per feedback.
- **One-tap compose focus** — `flushSync` mounts the field then focuses it synchronously in the tap, so iOS raises the keyboard on the first tap.

## Residual risks (device-pending)

Three iOS-device-only behaviors cannot be verified from this environment and are implemented to the verified mechanism, pending a physical iPhone/iPad pass:

1. **Focus retention** — soft keyboard staying open on a cross-document bar tap (pointer-down `preventDefault`) is a WebKit behavior.
2. **visualViewport positioning** — exact docking across rotation / predictive-bar height changes.
3. **Live dictation** — the duplication-free outcome (the fix for WebKit bug 261764) is only confirmable by dictating on a device.

See `quality-map.yaml` → `device_pending`.

## Spec reconciliation

US2/FR-009 were updated (Spec Authority): the soft keyboard routes letters into the ttyd **iframe**, which the parent chrome cannot intercept, so armed Ctrl combines with an **on-bar letter strip** rather than soft-keyboard keystrokes. Same capability (any Ctrl-`<letter>`), reliably deliverable. Recorded in the spec's Clarifications.
