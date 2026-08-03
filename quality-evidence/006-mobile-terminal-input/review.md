<!-- RECOVERED EVIDENCE. This file records a verification run performed while
omniterm was developed inside a larger private product, before the host was
open-sourced into this repository. Measurements and dates are left as recorded —
they are historical evidence, not current claims. Vendor identifiers were
scrubbed, and any claim that no longer holds is marked inline (SUPERSEDED /
UNAVAILABLE / EXTERNAL). Proof mappings in the accompanying quality-map.yaml were
reconciled against this repository and are current. -->

# Review: 006 — Mobile Terminal Input

**Date:** 2026-06-17 · **Scope:** the 006 feature diff · **Reviews run:** code review (high effort) + design review (mobile chrome). Security/privacy/compliance/perf/SEO/GEO were N/A (internal terminal-input UI — no auth/PII/network/discoverability surface).

## Code review findings & resolution

The three top findings shared one root cause: `MobileInputChrome` is rendered once at the layer level and reached "the active terminal" through a sticky handle, while its transient state wasn't reset when the active terminal changed.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | **Stale active-iframe ref → input to wrong/dead terminal.** `setActiveIframe` ignored `null`, so on a switch to a tab rendering the `Loading…` branch the ref kept the previous terminal; key bar / compose sent there. | High | **Fixed** |
| 2 | **Compose text persists across terminal switch → command runs in wrong shell.** Uncontrolled textarea in a component not keyed per session. | High | **Fixed** |
| 3 | **Armed `Ctrl` persists across switch/collapse → control byte to wrong terminal.** `ctrl` state never cleared on session change. | Med-High | **Fixed** |
| 4 | **Dead code / spec drift:** `onKey`'s `if (ctrl==='armed') dispatchCtrl('clear')` is unreachable (armed mode renders only the letter strip), and spec FR-009's "non-combining key clears" was impossible. | Med | **Fixed** |
| 5 | **Send/⏎ buttons lacked focus retention** → blur/focus thrash dismissing the iOS keyboard between sends. | Med | **Fixed** |

**How fixed**

- **1 (root cause):** `integration.tsx` now keeps a `Map<sessionId, HTMLIFrameElement>`; every `TerminalView` registers/unregisters itself by session id, and `getActiveTerminalWindow()` resolves the window for the **live active session id** (`activeSessionIdRef`). A stale/closed iframe is deleted on unmount and is never resolved; a switch mid-load is a safe no-op (`null`) instead of a misdelivery. The mobile chrome is gated on a live active session (`activeSessionId != null`).
- **2 + 3:** `MobileInputChrome` is now **keyed by `activeSessionId`**, so switching the active terminal remounts it — clearing the compose buffer and any armed `Ctrl`. Input can no longer carry over to another shell.
- **4:** removed the dead `onKey` branch; reconciled spec FR-009 (armed shows the letter strip; disarm via the `Ctrl` toggle).
- **5:** Send and ⏎ now go through `KeyButton`, which suppresses focus theft (pointer-down `preventDefault`) like the keys.

**Cleanups applied (findings 6–9):** single source of truth for the active session (no sticky ref); `KeyButton` extraction removes the 4× copy-pasted button shell and the risk of a future button omitting the focus guard; deduped the accent style (`composeToggleOn`/`keyArmed`/`sendRunBtn` → one `accentKey`); `useReducer(ctrlReducer, 'idle')` directly. **Deferred (low value, higher risk):** unifying `TerminalView`'s inline OSC-52 `term` access with `getTerminal()` — left alone to avoid touching the stable clipboard path.

## Design review findings & resolution

Contrast computed against the real theme tokens — all pass WCAG 1.4.3 AA (keys 9.6:1, muted `»`/`«` 5.4:1, accent 9.8:1).

| Check | Finding | Status |
|---|---|---|
| RES-03 touch targets | Keys were 38×40px (`»`/`«` 34 wide) — under Apple HIG 44 / Material 48. | **Fixed** — `keyBase` now 44×44 min; compose field `minHeight:44`. |
| A11Y-04 / 4.1.2 name | The ⏎ button had no accessible name. | **Fixed** — `aria-label="Send and run"` (and "Send to terminal" on Send). |
| RES-07 truncation | The key row scrolls with no affordance; symbols sit off-screen. | **Open (low)** — acceptable for v1; consider an edge fade later. |
| A11Y info | No `:focus-visible` ring / `role="toolbar"` grouping. | **Open (info)** — low impact on mobile-only. |

## Verification

- `pnpm --filter @omniterm/core typecheck` — clean.
- `pnpm --filter @omniterm/core test` — **179 pass / 0 fail / 0 skipped** (incl. the live-ttyd injector byte check).
- Mobile-viewport browser smoke (390×844): collapsed `»` by default → expand to `« 💬 Ctrl Esc Tab ^C ↑ …`; ⏎ carries the new aria-label; compose `⏎` delivered a command to the **active** terminal's PTY end-to-end through the new session-keyed `getWindow` (single write). (Smoke was run against the real-settings dev host, whose terminal is wired to the live workspace — a test-harness hazard, not a product issue; isolated-workspace hosts should be used for future smokes.)

## Readiness (round 1)

**8/10.** The wrong-terminal-targeting trio (1–3) — the only real blockers for multi-terminal mobile use — are fixed at the right altitude (one source of truth: the active session id). Remaining items are low/info design nits. Device-only behaviors (keyboard physically rising, live iOS dictation) remain documented as `device_pending` in `quality-map.yaml`.

## Round 2 — max-effort re-review (all findings fixed)

A second pass (max effort) on the post-fix diff confirmed the round-1 fixes held and surfaced 13 mostly low/latent items — several being drift the round-1 fixes themselves introduced. All addressed:

| # | Finding | Sev | Fix |
|---|---|---|---|
| 1 | Compose `Enter` lacked an `isComposing` guard → premature send on IME/dictation commit | Med | `&& !e.nativeEvent.isComposing` |
| 2 | Keyed remount lost in-progress compose/armed on collapse AND on a transient same-session drop | Med | Dropped `key=`; pass `activeSessionId` prop + effect that resets only on a genuine switch (ignores null transients); collapse keeps state |
| 3 | Injector test could go RED (top-level `esbuild`/`playwright-core` imports, not declared) instead of skipping | Med | Type-only import + dynamic `import()` after the skip guard with `t.skip()` |
| 4 | `getTerminal` accepted `term.modes === null` (`typeof null === 'object'`) | Low | `term.modes != null && typeof === 'object'` |
| 5 | `activeSessionIdRef` written during render (latent under StrictMode/concurrent) | Low | Removed the ref; `resolveTerminalWindow(activeSessionId)` resolves at send time |
| 6 | `controlByteForLetter` emitted stray bytes for non-ASCII (`ß`→Ctrl-S, `ı`→Tab) | Low | `/^[a-z]$/i` guard on the input; unit test added |
| 7 | `kbInset` flash on remount; recomputed post-paint | Low | `useLayoutEffect` + lazy initial inset |
| 8 | Spec FR-004/FR-014/Clarification/Key-descriptor still mandated synthetic-keydown + hidden-textarea | Med | Reconciled to the `term.input()` design |
| 9 | FR-010 "clear on blur" unimplemented; `ctrlReducer` `arm`/`clear` dead | Med | Removed dead `arm`; wired `clear` to the on-switch reset (#2); FR-010 reworded |
| 10 | Stale evidence: `⌨` glyph (shipped `💬`) in report/map | Low | `⌨`→`💬` |
| 11 | Duplicated `wsActiveTabId` logic + two renderList sweeps | Low | One `wsActiveTabIdOf` helper + a single pass computing both `activeTerminalVisible` and `activeSessionId` |
| 12 | Inline `ref={(el)=>registerIframe(...)}` churned the map each render | Low | Stable per-session ref callback (`iframeRefFor`) |
| 13 | Chrome could mount over a `pointerEvents:'none'` layer for one frame | Low | Chrome gated on the same `activeTerminalVisible` that drives `pointerEvents` |

The round-1 wrong-terminal fix was also re-expressed more robustly: the chrome now stays mounted across a session-load gap (no key churn), resolves the window by the **live** active session id at send time (no render-written ref), and resets compose/armed only on a real switch to a different terminal.

**Re-verified:** typecheck clean (all projects); core tests **179 pass / 0 fail / 0 skipped** (incl. the live-ttyd injector byte check and a new non-ASCII guard test); render-only mobile smoke confirmed the chrome still mounts after the gating refactor (no input sent). **Readiness: 9/10** — only `device_pending` (real iOS keyboard/dictation) remains.
