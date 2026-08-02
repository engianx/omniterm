# Agent Test: mobile terminal input (accessory key bar + compose field)

## Instructions

You are a testing agent for **omniterm** (the generic browser-based terminal host)
verifying feature **006 — mobile terminal input**. Execute this case against the
target environment using a browser-automation MCP **in a mobile viewport**,
terminal commands, and HTTP requests.

Do not mark PASS without concrete, auditable browser evidence (an HTML report +
screenshots + the captured browser console log). This case has two phases:

1. **Environment preflight**: confirm the target can execute the case (repo
   builds the client, host boots rooted at a scratch workspace with the terminal
   **DOM renderer** so terminal text is readable from the DOM, and a terminal tab
   can be opened).
2. **Product verification**: drive the mobile key bar + compose field and assert
   each behavior.

If environment preflight fails, do not run product verification — report
`Status: BLOCKED` with the concrete blocker (e.g. `target_environment_missing`,
`client_build_failed`, `host_startup_failed`, `terminal_open_failed`). Once
preflight is ready, product verification must return exactly PASS or FAIL.

If the orchestrator interrupts execution before there is enough evidence, write
`Status: ABORTED` (not PASS/FAIL/BLOCKED) and explain the interruption.

When the orchestrator provides `AGENT_VERIFICATION_REPORT_PATH`, write the report
to that exact path. Otherwise write to
`agent-test-reports/mobile-terminal-input-<YYYYMMDD-HHMMSS>.md`.

The report must include: Status; target + URLs used; fixture/workspace setup
performed; evidence collected (with the browser evidence path/URL); findings;
commands/pages inspected; cleanup performed; follow-up. End with exactly one
line: `Status: PASS` | `Status: FAIL` | `Status: BLOCKED` | `Status: ABORTED`.

## Requirements

- **006 / FR-001, SC-005** — The mobile input chrome appears only on a touch /
  narrow viewport when a terminal is the active surface; it never alters desktop
  input.
- **006 / FR-005, FR-006, FR-008** — The key bar sends `Esc`, `Tab`, arrows, and
  a one-tap `Ctrl-C`; the keys deliver their exact effects in the shell.
- **006 / FR-007, SC-002** — Arrow keys produce the correct sequence (history
  recall at the prompt; correct movement inside an application-cursor TUI).
- **006 / FR-009, FR-010** — The sticky `Ctrl` modifier arms (visible state +
  on-bar letter strip), sends the control byte for the tapped letter, and
  auto-disarms.
- **006 / FR-011, FR-012, FR-013, SC-003** — The compose field is a real editable
  field that sends its text **once** via `term.input()` (never `term.paste()`, so
  no bracketed-paste artifacts); **Send** sends without executing, **Send+Enter**
  (`⏎`) appends a carriage return to run it.
- **006 (collapsible chrome)** — The bar is collapsed by default to a `»`
  launcher; tapping it expands to `« 💬 Ctrl Esc Tab ^C ↑ ↓ ← → / - ~ |`; tapping
  `«` collapses back; the collapsed/expanded choice persists across reloads
  (localStorage).
- **006 (one-tap focus)** — Tapping `💬` opens the compose field **and focuses it
  in the same tap** (typing lands immediately, no second tap needed).

Sources:

- `specs/006-mobile-terminal-input/spec.md`
- `specs/006-mobile-terminal-input/research.md` (the verified injection mechanism)
- `specs/006-mobile-terminal-input/plan.md`

## Project Context

- Product/project name: `omniterm`
- Local URLs: host on `http://127.0.0.1:${OMNITERM_PORT:-17822}` (boot it below).
- Staging URLs: none (local-only project). Production URLs: none.
- Fixture setup and mutation policy: this case creates its own scratch workspace
  dir (`mktemp -d`) as the only tracked dir, and boots/kills its own host with an
  isolated `SETTINGS_DIR`. No committed fixtures are needed.
- Required accounts and organizations: none (no auth).
- Database/log/cloud access: none. Host logs go to the boot command's stdout/stderr.
- Production synthetic data policy: n/a.
- Cleanup ownership: this agent — kill the booted host, close the MCP browser
  session, and remove the temp `SETTINGS_DIR` and scratch workspace dir.

## Testing Environments

The orchestrator must specify a target via `AGENT_VERIFICATION_TARGET`. Only
`local` is supported. If unset, stop before preflight and report
`Status: BLOCKED` with blocker `target_environment_missing`. A PASS is valid only
for the selected target.

### Local Development

- Repo root: `<repo root>` (this repo).
- **Run as the ONLY omniterm host on the machine.** A second omniterm host (or
  a stray `ttyd`) contends for the shared ttyd port pool, and the orphan-ttyd
  reaper that runs on boot kills `ttyd` processes whose tmux session it doesn't
  recognize — across hosts — which makes terminals attach then show
  **"Session not found"**. Before booting, kill any other `tsx
  apps/omniterm/src/server.ts` and stray `ttyd` processes; if you still see
  "Session not found" after opening a terminal, BLOCK (`terminal_open_failed`).
- Backend setup:
  - `pnpm install` (only if `node_modules` is missing).
  - Build the client so the served bundle includes the 006 code under test:
    `pnpm --filter @omniterm/core build:client`. If it fails, BLOCK
    (`client_build_failed`).
  - Boot the host with an isolated settings dir whose only tracked workspace is a
    scratch dir, the terminal **DOM renderer** (so terminal output is in the DOM,
    not a WebGL canvas), telemetry off, on a free port (default 17822):
    ```bash
    SCRATCH="$(mktemp -d)"
    TMP_SETTINGS="$(mktemp -d)"
    printf '{"trackedDirs":["%s"],"telemetryEnabled":false,"terminalRenderer":"dom"}' \
      "$SCRATCH" > "$TMP_SETTINGS/settings.json"
    SETTINGS_DIR="$TMP_SETTINGS" OMNITERM_PORT=17822 OMNITERM_TELEMETRY=0 \
      tsx apps/omniterm/src/server.ts
    ```
    Run it in the background; capture stdout/stderr to a log; wait for
    `Listening on …`. If it exits or the port never opens, BLOCK
    (`host_startup_failed`) — include the log.
- Mutation policy: test-owned host, settings dir, and scratch workspace only.

## Environment Preflight

Prove the selected environment is ready before product verification:

1. Confirm `AGENT_VERIFICATION_TARGET=local`; otherwise BLOCK
   (`target_environment_missing`).
2. Build the client (command above). If it fails, BLOCK (`client_build_failed`).
3. Boot the host (command above). Wait for `Listening on …`, else BLOCK
   (`host_startup_failed`).
4. `GET http://127.0.0.1:<port>/` → HTTP 200 and the served `index.html`
   references a hashed `/assets/index-*.js` (proves the built client is served,
   not the unbuilt `/main.tsx` source). If it serves `/main.tsx`, BLOCK
   (`client_build_failed`) — the client dir wasn't built.

## Task

Open a browser-automation MCP session **with a mobile viewport and touch**, and
**`record_evidence: true`**:

```
new_session(browser_options = {
  viewport: { width: 390, height: 844 }, is_mobile: true, has_touch: true,
  record_evidence: true
})
```

Then:

1. Open a terminal. With a tracked workspace configured (above), the landing
   shows **"Select a workspace from the ☰ menu"** and the **+** button is
   **disabled** until a workspace is selected — so first open the **☰
   Workspaces** menu, select the scratch workspace (it appears under **OTHERS**),
   then click **+** (New terminal). Wait for the terminal to attach: a `Term …`
   tab plus a terminal surface showing a **live shell prompt**. If the pane shows
   **"Session not found"** or stays blank (no prompt), BLOCK
   (`terminal_open_failed`) — see the sole-host note above.
2. Drive the checks below. Resolve element indices from the `inspect_page` DOM
   **text** each step (the bar re-renders between states, so indices shift). The
   key bar buttons and the compose textarea are listed as interactive elements;
   **terminal output itself is read from the `inspect_page` screenshot** (xterm
   rows render as styled spans, not interactive elements), so view the screenshot
   to confirm prompts/output. Booting with the DOM renderer keeps that text crisp.
3. After the checks: pull `get_browser_console_logs` (errors + warnings).
4. `close_session` (saves video + trace), then `generate_html_report` into the
   report dir with one `check` per behavior below.

## Suggested Checks

**Collapsed-by-default + expand (collapsible chrome):**

- On load with a terminal active, the only chrome control present is the `»`
  launcher button (aria-label "Show terminal keys…"); the full key row is **not**
  rendered. Tap `»` → the bar expands and shows, in order, `« 💬 Ctrl Esc Tab ^C
  ↑ ↓ ← → / - ~ |`.

**One-tap compose focus (FR + one-tap focus):**

- With the bar expanded, tap `💬` once. Without any further tap, the compose
  `<textarea>` (placeholder "Dictate or type a line, then send…") is present and
  is the focused/active element — i.e. immediately `input_text` a string into it
  and it lands on the first try. (Note: whether the on-screen keyboard physically
  rises is an iOS-device-only behavior and is **not** asserted in this emulated
  browser — see Pass Criteria.)

**Compose sends once, executes, no bracketed-paste artifacts (FR-011..013, SC-003):**

- In the focused compose field type `echo COMPOSE_ONCE_$((6*7))`, then tap `⏎`
  (Send+Enter). The terminal shows the command **once** and prints
  `COMPOSE_ONCE_42` exactly once. The terminal text contains **no** `[200~` /
  `[201~` bracketed-paste markers and no duplicated/garbled fragments of the
  command (this is the dictation-duplication regression guard).
- Re-open compose, type `echo NORUN_MARKER`, tap **Send** (not `⏎`). The text
  appears at the prompt **unexecuted** (no `NORUN_MARKER` output line yet); then
  the terminal's own Return executes it. (Confirms Send omits the carriage
  return.)

**Key bar bytes via observable effects (FR-005..008, FR-007):**

- **Up arrow / history:** at a fresh prompt (after the echo above), tap `↑` on the
  bar → the previous command (`echo NORUN_MARKER` or the last entry) reappears at
  the prompt. (Proves the arrow sequence reaches readline correctly.)
- **Ctrl-C interrupt:** via compose, run `sleep 30` (type it, tap `⏎`). While it
  blocks, tap `^C` on the bar → the command is interrupted and a fresh prompt
  returns (a `^C` marker / new prompt appears). (Proves `\x03` delivery.)

**Sticky Ctrl modifier (FR-009, FR-010):**

- Tap `Ctrl` → it shows an armed/highlighted state and the bar reveals an a–z
  letter strip. Tap `l` → the terminal screen clears (Ctrl-L) and the armed state
  clears (the letter strip disappears, bar returns to the normal keys). (Proves
  the sticky modifier sends the control byte and auto-disarms.)

**Collapse round-trip + persistence (collapsible chrome):**

- Tap `«` → the bar collapses back to just the `»` launcher. Reload the page
  (`go_to_url` the same URL). After the terminal is active again, the chrome is
  **still collapsed** (only `»` present) — the collapsed choice persisted
  (localStorage). Tap `»` to re-expand and confirm the keys return.

**Console:**

- No `error`-level logs attributable to the mobile chrome. Benign warnings
  (`[alerts] …`, `[files] …` SSE reconnects, WebGL/driver perf messages) are
  expected and allowed.

## Expected Evidence

- HTML report (with embedded video + trace) under the report dir.
- `inspect_page` screenshots showing: the collapsed `»` launcher; the expanded
  bar; the focused compose field; the terminal showing `COMPOSE_ONCE_42` printed
  once with no `[200~` markers; the `↑` history recall; the post-`^C` interrupted
  prompt; the armed `Ctrl` letter strip; the cleared screen after Ctrl-L; and the
  collapsed state surviving a reload.
- The captured console log (showing no chrome errors).

## Pass Criteria

PASS only if preflight completed AND every Suggested Check holds, all backed by
the auditable artifacts above.

FAIL if preflight completed and any required behavior is broken — e.g. the bar
isn't collapsed by default or `»`/`«` don't toggle, tapping `💬` doesn't focus the
field (text doesn't land on first try), the composed command appears duplicated
or shows `[200~`/`[201~` artifacts or doesn't execute on `⏎`, `Send` executes
without Return, the up-arrow doesn't recall history, `^C` doesn't interrupt
`sleep`, the sticky `Ctrl`+letter doesn't fire (e.g. Ctrl-L doesn't clear) or
doesn't disarm, the collapsed state doesn't persist across reload, or a chrome
error appears in the console.

Do **not** FAIL on iOS-device-only behaviors that this emulated browser cannot
exercise: the physical on-screen keyboard rising, and real iOS keyboard
dictation de-duplication. Record those as device-pending follow-ups, not failures.

BLOCK (not FAIL) if the client can't build, the host can't boot, the served
client is the unbuilt source, or no terminal can be opened.

## Cleanup

- Kill the omniterm host process booted by this case; free the port.
- `close_session` on the MCP browser.
- Remove the temp `SETTINGS_DIR` and the scratch workspace dir created for the run.
