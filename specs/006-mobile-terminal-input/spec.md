# Feature Specification: Mobile Terminal Input (accessory key bar + compose field)

**Feature Branch**: `006-mobile-terminal-input`

**Created**: 2026-06-16

**Status**: Implemented; real-device iOS verification remains pending

**Input**: GitHub issue #11 (P1, enhancement): "Mobile accessory key bar for terminal meta keys (Esc, Ctrl, Tab, arrows)." GitHub issue #10 (bug): "iPhone dictation produces duplicated/repeated input in the terminal (Safari + Chrome)." These are the two halves of mobile terminal input; they share one input scaffold and are specified together but ship as independent slices.

## Clarifications

### Session 2026-06-16

- Q: Are these one feature or two? → A: **Two independently shippable slices over one shared scaffold.** The key bar (#11) and the compose field (#10) solve different problems (live meta-keys vs. buffering a dictated line) and even have conflicting focus models, but both inject into the same same-origin `window.term` and both want a mobile-only input chrome docked above the soft keyboard. Build the scaffold once; land the key bar first.
- Q: How are keys delivered to the terminal? → A: Through **`term.input()`** on the same-origin xterm handle, with arrow sequences chosen live from `term.modes` (application-cursor / DECCKM aware) so they stay mode-correct; control bytes and composed text are written verbatim. **Never `term.paste()`**, which bracket-wraps and mangles control bytes. (Synthetic `keydown` was evaluated and rejected for cross-frame / WebKit `keyCode` risk — see `research.md`.)
- Q: Is the dictation fix a patch to terminal composition handling? → A: **No.** iOS dictation emits no composition events at all (WebKit bug 261764); the fix is a real editable field that owns its value, with predictive text disabled, sent once. A composition-handler patch was investigated and ruled out.

### Session 2026-06-16 (implementation reconciliation)

- Q: How does the sticky Ctrl combine with a letter, given the soft keyboard types into the ttyd **iframe's** hidden textarea (which the parent chrome cannot intercept)? → A: Arming Ctrl **reveals a letter strip on the bar itself**; tapping a letter there sends its control byte and disarms. The parent cannot capture keystrokes the OS routes into the cross-document iframe, so "arm, then press a letter on the soft keyboard" is not achievable from omniterm's own chrome; the on-bar letter strip delivers the same capability (any Ctrl-`<letter>`) reliably. FR-009 and US2 below reflect this.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send Esc, Ctrl-C, Tab, and arrows from a phone (Priority: P1)

As someone driving omniterm from an iPhone or iPad, I need to send the terminal keys that the
soft keyboard never exposes — **Esc** to back out of or cancel an agent prompt, **Ctrl-C** to
interrupt a running command, **Tab** for completion, and **arrow keys** for history and TUI
navigation — by tapping a key bar that sits just above the on-screen keyboard, without the
keyboard closing between taps.

**Why this priority**: This is the headline of omniterm's "work from your iPad/phone" positioning.
A terminal you cannot send `Esc` or `Ctrl-C` to from mobile is only half usable — you can start
work but cannot stop, cancel, or navigate it. It is the smallest slice that turns mobile from
"demo" into "usable," and it establishes the shared input scaffold and the key-injection path the
other stories reuse.

**Independent Test**: On a real iPhone/iPad in Safari and in Chrome, focus a terminal tab; confirm
a key bar appears pinned above the keyboard. Tap `Esc`, `Tab`, `↑ ↓ ← →`, and a dedicated
`Ctrl-C`, and confirm each takes effect in the shell/TUI (e.g. `Ctrl-C` interrupts a running
`sleep 100`; `↑` recalls the previous command; arrows navigate a `less`/`vim` session correctly;
`Esc` exits insert mode). Confirm the soft keyboard stays open across every tap.

**Acceptance Scenarios**:

1. **Given** a focused terminal tab on a touch device, **When** the soft keyboard is open, **Then** an accessory key bar is shown pinned directly above the keyboard.
2. **Given** a running command (e.g. `sleep 100`), **When** I tap `Ctrl-C` on the bar, **Then** the command is interrupted (SIGINT), exactly as a hardware `Ctrl-C` would.
3. **Given** a shell prompt, **When** I tap `↑`, **Then** the previous command from history appears at the prompt.
4. **Given** a TUI that has switched to application-cursor mode (e.g. `vim`, `less`, `fzf`), **When** I tap an arrow key, **Then** the app receives the correct application-cursor sequence and the cursor/selection moves as expected (not a stray character).
5. **Given** I am in `vim` insert mode, **When** I tap `Esc`, **Then** `vim` returns to normal mode.
6. **Given** the key bar is visible, **When** I tap any bar key, **Then** the soft keyboard remains open and the terminal stays focused (no keyboard dismissal, no focus loss).
7. **Given** the same gesture on Safari and on Chrome for iOS, **When** I tap bar keys, **Then** behavior is identical (the fix lives in shared chrome, not a browser quirk).

---

### User Story 2 - Send arbitrary Ctrl- combinations with a sticky modifier (Priority: P2)

As a mobile user, beyond a one-tap `Ctrl-C` I sometimes need other control combinations
(`Ctrl-D` EOF, `Ctrl-Z` suspend, `Ctrl-R` reverse-search, `Ctrl-L` clear, `Ctrl-A`/`Ctrl-E`
line editing). I want to tap a **`Ctrl`** key that arms with a visible state and reveals a letter
strip on the bar, then tap a letter there to send the control byte.

**Why this priority**: Extends the bar from a fixed set of keys to the full control-combo space, but
the most critical combo (`Ctrl-C`) is already covered as a direct key in P1, so this is an
enhancement rather than the core unblock. Independently shippable on top of US1.

**Independent Test**: Tap `Ctrl` on the bar, confirm it shows an armed/highlighted state and that a
letter strip appears, then tap `r` (or `l`/`d`/`z`) and confirm the corresponding control byte is sent
(`Ctrl-R` opens reverse-search, `Ctrl-L` clears, `Ctrl-D` closes the shell). Confirm the armed state
clears after one letter, and that tapping `Ctrl` again behaves per the defined arm/disarm rules.

**Acceptance Scenarios**:

1. **Given** the key bar, **When** I tap `Ctrl`, **Then** it enters a visible "armed" state and the bar shows a letter strip for choosing the control combination.
2. **Given** `Ctrl` is armed, **When** I tap a letter in the strip, **Then** the matching control byte is sent (e.g. armed + `r` → reverse-search) and the armed state clears.
3. **Given** `Ctrl` is armed, **When** I tap `Ctrl` again before choosing a letter, **Then** it disarms (toggle), sending nothing.
4. **Given** `Ctrl` is armed, **When** I want a non-letter key (arrow/Esc), **Then** the armed letter strip is shown instead of those keys, and tapping `Ctrl` again disarms and restores the normal keys (defined, non-surprising).

---

### User Story 3 - Dictate or type a full line, then send it once (Priority: P2)

As a mobile user who wants to dictate a command or message with the keyboard mic, I want a compose
field where my dictation lands as normal editable text — revised in place to the final sentence —
which I then send to the terminal in one shot, instead of the terminal filling with duplicated,
half-corrected fragments.

**Why this priority**: Fixes a real correctness bug (#10): today, dictation produces garbage like
`II wantI want toI want to type something` because iOS re-sends the whole growing transcription on
every revision and the terminal appends each snapshot. It is P2 rather than P1 because it only
triggers when a user dictates, whereas the US1 meta-key gap blocks core workflows unconditionally;
and it reuses the US1 scaffold and the text-injection path.

**Independent Test**: On a real iPhone, focus the terminal, open the compose field, tap the keyboard
mic, and dictate "hello world this is a test." Confirm the field shows the single corrected sentence
(not duplicated fragments), then tap send and confirm the terminal receives `hello world this is a
test` exactly once, optionally followed by execution. Repeat by typing (not dictating) a multi-word
line to confirm the field works for typed input too.

**Acceptance Scenarios**:

1. **Given** the mobile compose field is focused, **When** I dictate a sentence with the keyboard mic, **Then** the field shows the final corrected sentence once, with no duplicated or half-corrected fragments.
2. **Given** composed text in the field, **When** I tap send, **Then** the terminal receives exactly that text once, as a single write, with no bracketed-paste artifacts.
3. **Given** I want to run the composed text as a command, **When** I send it with the "run" affordance, **Then** the text is followed by a carriage return so the shell executes it; **and** when I send without it, no newline is appended.
4. **Given** the compose field, **When** I type (rather than dictate) a line and send, **Then** it behaves identically to dictated input.
5. **Given** predictive text / autocorrect would normally fire, **When** I compose in the field, **Then** autocorrect, autocapitalization, and spellcheck are disabled so the field does not silently alter terminal commands.

---

### Edge Cases

- **Hardware keyboard attached (iPad + Smart/Magic Keyboard)**: the on-screen bar's value drops, but
  hardware keys themselves have known xterm issues on iOS; the bar MUST remain available and functional
  rather than being hidden on the assumption a hardware keyboard "covers it."
- **Terminal mode changes mid-session**: an app enabling/disabling application-cursor mode (DECCKM) after
  the bar renders MUST be reflected live, so arrow keys keep emitting the correct sequence (verified
  `term.modes.applicationCursorKeysMode` is readable at runtime).
- **`term` not yet available / ttyd reloading / cross-origin**: if the `window.term` handle cannot be
  reached, the bar and compose field MUST disable themselves (greyed/absent) rather than throw or send to
  nothing.
- **Non-touch / desktop**: neither the bar nor the compose field appears on desktop; this feature never
  alters desktop terminal input.
- **Compose field with multi-line or empty content**: empty send is a no-op; multi-line composed text is
  sent faithfully (the "run" affordance's trailing newline behavior still applies only to the final line).
- **Bracketed-paste / control-byte safety**: no injected key may be wrapped in bracketed-paste markers,
  and composed text MUST NOT be sent through a path that bracket-wraps when an app has the mode on.
- **Soft keyboard resize / orientation change**: the bar MUST stay pinned to the top edge of the keyboard
  as the visual viewport changes (rotation, keyboard show/hide, predictive-bar height changes).
- **Armed `Ctrl` then keyboard dismissed**: dismissing the keyboard or blurring MUST clear any armed
  modifier so it cannot leak into a later keypress.

## Requirements *(mandatory)*

### Functional Requirements

#### Shared input scaffold

- **FR-001**: The feature MUST present a mobile-only terminal input chrome (key bar and/or compose field)
  that appears only on touch devices when a terminal tab is focused, and MUST NOT appear on desktop or
  alter desktop terminal input in any way.
- **FR-002**: The chrome MUST be docked directly above the on-screen keyboard and stay pinned there as the
  visual viewport changes (keyboard show/hide, rotation, predictive-bar height), using the device's
  visual-viewport information rather than a fixed offset.
- **FR-003**: All input MUST be delivered to the terminal through the existing same-origin handle to
  ttyd's xterm.js `Terminal` (`window.term` in the proxied iframe) — no new server route and no second
  input channel. If that handle is unavailable, the chrome MUST disable itself gracefully (FR-014).
- **FR-004**: Key/text delivery MUST go through `term.input()` (the same-origin xterm handle), with
  arrow sequences selected live from the terminal's application-cursor mode (`term.modes`) so they stay
  mode-correct, and control bytes/composed text written verbatim. The feature MUST NOT use `term.paste()`
  for any input, because bracketed-paste mode wraps and mangles control bytes and suppresses command
  execution. (Synthetic `keydown` dispatch was evaluated and rejected — cross-frame + WebKit `keyCode`
  reflection risk; `term.input()` yields the same bytes deterministically — see `research.md` / `plan.md`.)
- **FR-014**: The feature MUST feature-detect the required `term` API surface (`term.input` and
  `term.modes`) at runtime rather than assuming a fixed xterm version, and MUST degrade to a
  disabled/no-op chrome (never an error) when the surface is missing.

#### Key bar (US1)

- **FR-005**: The key bar MUST provide, at minimum, direct keys for **Esc, Tab, ↑, ↓, ←, →**, and a
  one-tap **Ctrl-C**. It SHOULD include a small set of shell-common symbols (e.g. `/ - ~ |`). The default
  key set ships fixed; user-configurable key sets are out of scope for v1.
- **FR-006**: Tapping a bar key MUST NOT move focus away from the terminal or dismiss the soft keyboard;
  the keyboard MUST stay open across taps.
- **FR-007**: Arrow keys MUST emit the **mode-correct** sequence: normal-cursor (`ESC[A/B/C/D`) when the
  terminal is in normal mode and application-cursor (`ESC O A/B/C/D`) when an app has enabled DECCKM,
  determined live from the terminal's current mode — never a fixed sequence that is wrong inside TUIs.
- **FR-008**: `Esc`, `Tab`, and `Ctrl-C` MUST deliver their exact control bytes (`0x1b`, `0x09`, `0x03`)
  and take effect identically to the corresponding hardware keys, including interrupting a running command.

#### Sticky Ctrl modifier (US2)

- **FR-009**: The bar MUST provide a `Ctrl` modifier that, when armed, shows a visible armed state and
  replaces the normal key set with an on-bar letter strip; tapping a letter sends its control byte
  (`Ctrl-A…Ctrl-Z` → `0x01…0x1a`) and auto-disarms. While armed, the `Ctrl` toggle remains visible and
  tapping it MUST disarm (toggle off) without sending anything. (The modifier combines with the on-bar
  letter strip rather than soft-keyboard keystrokes, which the OS routes into the ttyd iframe beyond the
  parent chrome's reach — see Clarifications. Because armed mode shows only the letter strip, the normal
  meta keys are not reachable while armed; disarm via the `Ctrl` toggle to use them.)
- **FR-010**: Any armed modifier MUST be cleared when the active terminal changes (and on consume /
  disarm) so it cannot leak into a later keypress on another shell.

#### Compose field (US3)

- **FR-011**: The compose field MUST be a real editable text field that owns its value, so iOS dictation
  (which emits no composition events) revises in place to a single final string instead of appending
  cumulative snapshots. It MUST disable autocorrect, autocapitalization, spellcheck, and autocomplete so
  it cannot silently alter terminal input.
- **FR-012**: Sending from the compose field MUST write the composed text to the terminal exactly once as
  a single `term.input(text)` write, with no bracketed-paste markers.
- **FR-013**: The compose field MUST offer sending **with** execution (text followed by a carriage return)
  and the result of sending **without** a trailing newline MUST leave the text at the prompt unexecuted.
  Empty content MUST be a no-op.

### Key Entities *(include if feature involves data)*

- **Mobile input chrome**: the touch-only UI layer docked above the soft keyboard that hosts the key bar
  and the compose field; gated on `isMobile`/touch + a focused terminal tab; positioned via visual-viewport
  geometry.
- **Key descriptor**: a bar entry mapping a label to the bytes it sends — fixed control/literal bytes, or
  an `arrow` direction resolved to a mode-aware sequence at send time. The single source of truth for what
  each bar key sends.
- **Armed modifier state**: the transient one-shot `Ctrl` state (idle / armed), consumed by the next
  keypress and cleared on use, toggle, or blur.
- **Composed line**: the editable text buffer the compose field owns and sends as one write, with an
  optional trailing carriage return for execution.
- **Terminal handle**: the same-origin `window.term` (xterm.js `Terminal`) reached through the proxied
  iframe; the sole delivery target, with `term.modes` read live for mode-correct sequences.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a real iPhone (Safari and Chrome), a user can interrupt a running command with a single
  bar tap (`Ctrl-C`), with 0 cases of the keyboard closing or focus leaving the terminal across a session
  of bar taps.
- **SC-002**: Arrow keys from the bar navigate correctly in both a shell prompt (history) and an
  application-cursor TUI (e.g. `vim`/`less`), with 0 stray characters emitted in either mode — verified by
  toggling an app that enables DECCKM.
- **SC-003**: Dictating a sentence into the compose field and sending it places that sentence in the
  terminal exactly once, with 0 duplicated/fragmented tokens — reproducing the issue-#10 scenario and
  showing it fixed.
- **SC-004**: Every injected key delivers its exact expected bytes (Esc `0x1b`, Tab `0x09`, Ctrl-C `0x03`,
  Ctrl-letter `0x01…0x1a`, arrows mode-correct), and no injected input is ever wrapped in bracketed-paste
  markers — verifiable by capturing the terminal's outgoing data.
- **SC-005**: Desktop terminal input is byte-for-byte unchanged; the mobile chrome never renders on
  non-touch devices.
- **SC-006**: When the `term` handle is unavailable (ttyd reloading), the chrome disables itself with 0
  thrown errors and recovers once the terminal is ready.

## Assumptions

- The terminal remains a same-origin ttyd iframe exposing `window.term`; both features reach in through
  that handle exactly as the existing OSC-52 injection does. No new server route or input channel is added.
- ttyd ships xterm.js `^5.4.0`; the required API (`term.input`, `term.modes`) is present and was verified
  on the live object (`research.md`). The feature feature-detects rather than pins a version, since the
  resolved minor depends on each user's ttyd build.
- Delivery via `term.input()` with mode-aware arrow sequences (never `term.paste`) is taken as settled
  from the measured per-mode byte behavior in `research.md`; synthetic `keydown` was rejected for
  cross-frame / WebKit `keyCode` risk.
- The iOS dictation duplication is a WebKit input-path issue (no composition events; bug 261764), not an
  xterm.js logic bug, so the fix is a real editable field — not a composition-handler patch.
- v1 ships a fixed, sensible default key set; user-configurable key sets / macro systems are out of scope
  and tracked separately if demand appears.
- The key bar (US1+US2) and the compose field (US3) are independently shippable on the shared scaffold;
  the key bar lands first as the higher-impact unblock.
- "Mobile / touch" gating reuses the existing `isMobile` signal already threaded through the app.
