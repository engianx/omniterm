# Research: Mobile Terminal Input (accessory key bar + compose field)

**Created**: 2026-06-16

**Feeds**: `spec.md` (this directory). Backs GitHub issues #11 (key bar) and #10 (dictation).

This file records what was **empirically verified** against the terminal stack omniterm
actually ships, plus a fact-checked literature scan. It exists so the spec's requirements
rest on measured behavior, not assumption. Every byte-level claim below was produced by
driving a headless Chromium against a live `ttyd` instance and reading the bytes ttyd would
forward to the PTY.

## The stack we are actually targeting

- omniterm renders each terminal as a **same-origin iframe** at `/t/:sessionId/`, reverse-proxied
  (HTTP + WS) to a loopback `ttyd` process (`plugins/terminal/components/TerminalView.tsx`,
  `server/startServer.ts`, `plugins/terminal/lib/ttyd.ts`).
- We do **not** own the terminal bundle — `ttyd` serves its own embedded **xterm.js**. We can only
  inject behavior into the iframe after load via `iframe.contentWindow` / `iframe.contentDocument`.
  We already do this in production for OSC 52 clipboard, touch-scroll, and context-menu
  (`TerminalView.tsx:66-151`).
- Installed locally: **ttyd 1.7.7** (homebrew), **tmux** present.

### xterm.js version pin (verified)

- ttyd `1.7.7` `html/package.json` pins **`@xterm/xterm: ^5.4.0`** (scoped package → xterm 5.4+).
- The served, minified bundle (a single inlined 730 KB `<script>`) carries xterm 5.x signatures:
  `linkifier2`, `WebglAddon`/`CanvasAddon`, `coreService.triggerDataEvent`, `onBinary`,
  `_renderService`. No legacy (`xterm-addon-*`, pre-scope) markers.
- The minified paste path is visible verbatim: `triggerDataEvent(e,!0),t.value=""` — fire the data
  event with the pasted text, then clear the helper textarea.

> **Action for implementation:** xterm's public API is stable across 5.4/5.5, but the exact resolved
> minor depends on when each user's `ttyd` was built (`^5.4.0`). Treat 5.4 as the floor; feature-detect
> rather than version-detect at runtime (see "graceful degradation" in the spec).

## Live `window.term` API surface (verified)

ttyd exposes the xterm.js `Terminal` instance as `window.term` inside the iframe (we already rely on
this for OSC 52). Introspected on the real object:

| Member | Present | Notes |
|---|---|---|
| `term.input(data, wasUserInput?)` | ✅ (arity 1) | Public. Writes `data` straight to the PTY data channel. `wasUserInput` defaults true (scroll-to-bottom). |
| `term.paste(data)` | ✅ (arity 1) | Runs the paste pipeline — **wraps in bracketed-paste markers when the app enabled the mode** (see below). |
| `term.attachCustomKeyEventHandler(cb)` | ✅ | A *filter* on real key events, not an injector. |
| `term.onData / onKey / onBinary` | ✅ | Used here only to capture outgoing bytes during testing. |
| `term.focus()` | ✅ | |
| `term.modes.applicationCursorKeysMode` | ✅ readable | Reflects DECCKM live (false at a bash prompt; true once an app sends `ESC[?1h`). |
| `term.modes.bracketedPasteMode` | ✅ readable | Reflects `ESC[?2004h` state live. |
| `term.options.ignoreBracketedPasteMode` | ✅ | Lets us force-disable paste wrapping if ever needed. |
| `.xterm-helper-textarea` | ✅ in DOM | The hidden textarea xterm listens on for keydown/composition. |

## Injection mechanisms — measured per terminal mode

Captured by hooking `term.onData(...)` and exercising each path. Bytes shown hex.

| Injection | Normal mode | Application-cursor mode (DECCKM on) |
|---|---|---|
| `term.input('\x03')` (Ctrl-C) | `\x03` | `\x03` (mode-independent) |
| synthetic `keydown` ArrowUp (`keyCode 38`) on helper textarea | `\x1b[A` (`ESC [ A`) | **`\x1bOA`** (`ESC O A`) |
| synthetic `keydown` Escape (`keyCode 27`) | `\x1b` | `\x1b` |
| synthetic `keydown` Ctrl+C (`keyCode 67` + `ctrlKey`) | `\x03` | `\x03` |
| synthetic `keydown` Tab (`keyCode 9`) | `\x09` | `\x09` |
| `term.paste('abc')`, bracketed-paste **on** | `\x1b[200~abc\x1b[201~` | (mode-independent) |
| `term.paste('abc')`, bracketed-paste **off** | `abc` | |

### What this proves

1. **Synthetic `keydown` is mode-faithful for arrows.** The *same* event emits `ESC[A` normally and
   `ESC O A` once a TUI (vim, less, fzf, a pager) enables application-cursor mode. Writing a fixed raw
   byte string would pick one and be wrong inside those apps. (Chromium honors `keyCode` supplied in the
   `KeyboardEvent` init dict for synthetic events — verified `ev.keyCode === 38`.)
2. **`term.input()` is correct for mode-independent control bytes** (Ctrl-C/D/Z/R/L, Esc, Tab). It does
   *not* bracket-wrap, so control bytes pass through intact.
3. **`term.paste()` must never carry control keys.** When the focused app has bracketed-paste mode on,
   paste wraps content in `ESC[200~ … ESC[201~`; an embedded ESC/Ctrl byte would be neutered or mangled.
4. **We can also build arrow sequences deterministically ourselves** by reading
   `term.modes.applicationCursorKeysMode` and emitting `ESC[A` vs `ESC O A` through `term.input()` — a
   robust fallback that sidesteps any browser quirk in synthetic-event `keyCode` reflection.

### Resulting two-path injection design (the core of the spec)

- **Meta/control keys (#11):** prefer a synthetic `keydown` on `.xterm-helper-textarea` with `key`,
  `code`, `keyCode`, `which` (+ `ctrlKey` for combos), because xterm computes the mode-correct sequence.
  Deterministic fallback for arrows: read `term.modes.applicationCursorKeysMode` and `term.input()` the
  right sequence. **Never `term.paste()` for keys.**
- **Composed line text (#10):** send via **`term.input(text)`** (optionally followed by a separate `\r`
  to execute), **not** `term.paste()` — paste's bracketed wrapping suppresses execution of an embedded
  newline and is the wrong semantics for "type a command and run it."

## Problem A — iOS dictation duplication (literature, fact-checked)

- **Root cause confirmed and narrowed:** iOS dictation fires **only `beforeinput`/`input` events — no
  composition events at all** (WebKit bug [261764](https://bugs.webkit.org/show_bug.cgi?id=261764),
  unfixed). xterm.js only coalesces composed text on `compositionend`; with none arriving, each cumulative
  dictation snapshot is forwarded and appended. *(Adversarially verified 3-0.)*
- **iOS-specific.** On macOS, Safari/Chrome/Firefox handle dictation into xterm.js correctly; only
  iOS/iPadOS duplicates. *(3-0.)* So this is the WebKit input path, not xterm.js logic — confirming we
  must fix it at a different layer (a real editable field), **not** by patching composition handling.
- Theories that it is xterm's `keyCode 229` path (#1815), interrupted-composition handling (#3600), or
  "read the textarea value range" were **refuted** (0-3 each). We will not pursue a composition-handler fix.
- A recorded real-device capture (`II wantI want toI want to type something…`) matches the
  cumulative-append mechanism byte-for-byte.
- **Fix pattern supported:** compose in a real `<input>/<textarea>` with predictive/autocorrect **off**
  (`autocorrect="off" autocapitalize="off" spellcheck="false" autocomplete="off"`), send once.
- **Honest gap:** the scan did **not** confirm that named apps (Blink, Termius) ship a compose overlay
  *specifically* for dictation — the Blink "Scratch Mode" claim was refuted (1-2) and app-specific claims
  were thin. So #10's overlay is a sound inference from the mechanism, not a copied recipe. Budget device
  testing.

## Problem B — accessory key bar (literature, fact-checked)

- **The always-visible extra-keys row above the keyboard is the established pattern** (Termius). *(3-0.)*
- iOS *hardware* keyboards also hit xterm.js input bugs (arrows #1101; Ctrl-C arriving as keyCode 13
  #5721), so an on-screen bar is genuinely needed, not just a convenience.
- **Focus retention:** keep the soft keyboard open while tapping bar keys by calling `preventDefault()` on
  the bar buttons' `touchstart`/`mousedown` so focus never leaves the terminal's hidden textarea. *(blog-tier,
  consistent across sources.)*
- **Positioning above the keyboard:** use the **`visualViewport`** API — iOS Safari does not resize the
  layout viewport when the soft keyboard opens. *(blog-tier.)*
- xterm.js has **no built-in public "sendKey" API** (proposal #3581 closed out-of-scope), which is why we
  synthesize keydown / use `term.input()`.

## Caveats carried into the spec

- The WebKit dictation bug is unfixed; we work around it, we don't wait on it.
- xterm minor version is `^5.4.0` and build-dependent → **feature-detect** `term.input` / `term.modes` at
  runtime; degrade gracefully if absent.
- Because the terminal lives in an iframe, both features live in omniterm's own chrome and reach in via the
  same-origin `window.term`; if that handle is ever unavailable (cross-origin, ttyd not ready), the bar and
  compose field must disable themselves rather than throw.
- Synthetic-`keyCode` reflection is verified in Chromium; **confirm on real iOS Safari** during device
  testing. The deterministic `term.modes` + `term.input()` arrow fallback exists precisely to cover any
  WebKit synthetic-event quirk.

## Reproduction of these measurements

```
ttyd -p 7790 -i 127.0.0.1 --writable bash        # throwaway instance
# headless Chromium (playwright-core, already vendored) loads http://127.0.0.1:7790/,
# waits for window.term, hooks term.onData, and exercises each injection path while
# toggling DECCKM (ESC[?1h/?1l) and bracketed-paste (ESC[?2004h/?2004l) via term.write().
```

All numbers above are from that run on this machine (2026-06-16).
