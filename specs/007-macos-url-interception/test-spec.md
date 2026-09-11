# Test Spec: macOS URL interception (`open <url>` → tab browser registry)

**Scope**: ticket — [issue #25](https://github.com/engianx/omniterm/issues/25)
**Source material**: issue #25; `specs/001-omniterm-core/spec.md` (User Story 1 *Persistent terminals* — Priority **P1**, FR-010–FR-013; User Story 2 *Watch a browser a command drives* — Priority **P2**); the working-tree change (`packages/core/bin/open`, `packages/core/plugins/terminal/lib/{tmux,sessions}.ts`, packaging)
**Testing posture**: no repo-root `TESTING.md` — the baked-in default applies
**Test report**: [test-report.md](./test-report.md)

This file defines the durable testing contract for URL interception inside an
omniterm tab: what needs confidence and which evidence strategies are acceptable.

Priorities below are **carried** from `specs/001-omniterm-core/spec.md`, not
invented here. Everything that concerns the pane environment inherits User
Story 1's declared **P1**; everything that concerns a launched browser reaching
the tab's registry inherits User Story 2's declared **P2**.

## Testing What

### Product Behaviors

- A URL opened inside a tab — by an agent or by the user — launches a browser
  that appears in that tab's browser panel rather than the user's own browser
  (US2). On macOS `open <url>` is the canonical way to do this and is the only
  path that exists there: `/usr/bin/open` ignores `$BROWSER`, and there is no
  `xdg-open`.
- `xdg-open <url>` keeps doing the same on Linux.
- Shadowing `open` does not take over the command: files, directories, `-a
  AppName`, `-R`, `-e`, non-web schemes, and a bare `open` all reach the real
  `open` unchanged.
- A pane whose shell cannot be given the interception still starts and works.

### Implementation / System Invariants

- The shim directory leads `PATH` in a pane **after** the login-profile pass, so
  the shim outranks `/usr/bin`. Profiles both **reorder** PATH (macOS
  `/etc/profile` → `path_helper` hoists system dirs to the front) and **replace**
  it outright (Debian `/etc/profile`); neither may demote the shim dir.
- The shim dir is added in exactly one place, so it appears once (FR-010: the
  pane environment is built deliberately, not accumulated).
- The re-prepend never introduces an empty `PATH` field — leading or trailing —
  because an empty field means the current directory.
- `OMNITERM_BIN_DIR` is stamped on the session and allowlisted through the
  clean-env scrub, or the re-prepend is a silent no-op (FR-010/FR-013).
- The generated wrapper is POSIX sh: it runs under `dash` (`/bin/sh` on Debian)
  as well as bash/zsh.
- The `open` shim's pass-through resolver never selects itself (directly, or via
  a symlink under another name/dir) — doing so execs in a loop forever.
- The resolver treats `PATH` entries literally; a glob metacharacter in an entry
  must not cause a different directory to be searched.

### Risk-Based Behaviors

- **Blast radius of shadowing `open`.** `open` is a general-purpose launcher on
  macOS. A too-wide intercept silently breaks file/app opening for everything
  running in a tab.
- **Exec loop.** A resolver that picks itself hangs the caller indefinitely.
- **Empty PATH field.** Puts the current directory on `PATH` for every command
  in the tab.
- **Pane dead on arrival.** A pane whose shell cannot parse the injected snippet
  fails to start at all — worse than missing the feature.

### Operational / Release Behaviors

- The shims reach the published npm tarball and are executable at the user's
  machine. They cannot be listed in `package.json` `bin` (that would shadow
  `/usr/bin/open` and `/usr/bin/xdg-open` machine-wide), so `pnpm pack`
  normalizes them to `0644` and only the package `postinstall` restores `+x`.
  A shim that ships unexecutable, or does not ship at all, is undetectable at
  runtime from a source checkout.

### Stakeholder Confidence Goals

- A macOS user reporting "No browsers running for this tab" can run `open <url>`
  and see the browser in the panel.
- Nobody's `open somefile` breaks inside an omniterm tab.
- A Linux user is not regressed — this change adds a command there rather than
  shadowing one.

## Evidence Strategy

| What | Priority | Viable How | Selected How | Why | Residual Risk |
| --- | --- | --- | --- | --- | --- |
| `open <url>` launches a browser that REGISTERS with the tab registry | P2 | e2e, agent, integration | **integration** (real shim → real `omniterm-browser.js` → real headless Chrome → local registry; CDP endpoint probed for liveness) | Cheapest modality capable of proving a real launch registers. A unit test cannot start Chrome; an agent test costs far more and adds no proof here | Not proven through the omniterm UI panel itself — only through the registry contract the panel reads |
| Non-URL `open` arguments reach the real `open` untouched | P1 | unit, integration | **unit** (recording stand-ins) + **integration** (no Chrome launched, no registration) | Blast-radius risk; cheap to enumerate exhaustively at unit level, plus one real-process proof | Argument forms not enumerated (e.g. future `open` flags) default to pass-through, which is the safe direction |
| Shim dir leads PATH after a profile that REORDERS it (macOS `path_helper`) | P1 | unit, integration | **unit** (real `sh`, profile fixture) + **integration** (real tmux pane, `command -v open`) | This is the actual root cause; proving it at both the script and the live-pane layer is warranted for a P1 invariant | An rc file that *assigns* PATH after the profile pass can still demote it — accepted and documented |
| Shim dir leads PATH after a profile that REPLACES it (Debian) | P1 | unit | **unit** (real `sh`, profile fixture) | Same mechanism, second profile shape | As above |
| Re-prepend is idempotent and adds no empty PATH field | P1 | unit | **unit** (stub shell, isolated from host `/etc/profile`) | Cheap; the empty-field case is a real security-flavored footgun | Middle-of-PATH duplicates are possible but harmless |
| `OMNITERM_BIN_DIR` is stamped and allowlisted | P1 | unit | **unit** | Pure function; a regression here silently disables everything above | — |
| Wrapper is POSIX (runs under dash) | P1 | unit | **unit, implicit in CI** (suite spawns `sh`, which is dash on ubuntu-latest) | Free — CI already provides the second shell | Verified manually under Debian dash/zsh locally; not a named assertion |
| A non-POSIX login shell (fish/csh/nu) still starts | P1 | unit | **unit** (stub shell, asserts the `-l` shape) | Regression introduced mid-change and caught in review; a dead pane is worse than a missing feature | fish + `initialCommand` remains imperfect — pre-existing, unchanged |
| Resolver never execs itself (loop guard) | P1 | unit | **unit** (shim symlinked into a second PATH dir, capped timeout) | A hang is the worst failure mode and invisible without a dedicated case | — |
| Resolver treats PATH entries literally (no globbing) | P1 | unit | **unit** (decoy directory the glob actually matches) | Without a matching decoy the test cannot discriminate; with one it is exact | — |
| Shims ship in the tarball and are executable | P1 | static, script | **static** (declaration guard over `package.sh` / `postinstall` / `.gitignore`) + release-gate artifact check in CI | Full `pnpm pack` per test run is disproportionate; the release workflow already gates on the built artifact | Tarball file mode not asserted automatically — verified once by hand this session |
| Adopted (pre-upgrade) tmux sessions pick up the fix | P1 | integration | **NOT COVERED — knowingly accepted** | Cannot be fixed for an already-running pane (env is fixed at exec), and re-stamping `default-command` would scrub sessions the user created outside omniterm | Users must recreate a tab after upgrading; documented at `sessions.ts` `adoptSession` |

Out of scope:

- Windows. omniterm requires `tmux` + `ttyd`; there is no native Windows
  support. WSL2 is covered by the Linux rows.
- The omniterm browser **panel UI** (rendering, DevTools placement, tab
  scoping) — owned by spec 001 US2, unchanged here.
- `omniterm-browser.js`'s Chrome lifecycle beyond registration (singleton
  hand-off, stale-lock recovery) — pre-existing, untouched.
- Whether an interactive `open <url>` *should* be intercepted for a human user
  (a product decision, raised separately).

## Test Cases

### URLINT-T01 `open <url>` registers a real browser with the tab registry

- Testing what: the end-to-end product behavior of issue #25 (US2, P2).
- Source refs: issue #25; spec 001 US2 acceptance scenario 1.
- Preconditions:
  - Required account / role: none.
  - Required data: none.
  - Required external services: a local Chrome/Chromium. Self-skips when absent.
- Automated checks:
  ```bash
  cd packages/core && NODE_ENV=test pnpm exec tsx --test \
    plugins/terminal/lib/browserShims.integration.test.ts
  ```
- Steps:
  1. Start a stand-in registry on an ephemeral loopback port.
  2. Run the real `bin/open` with a URL, a dedicated temp user-data-dir, and
     `OMNITERM_BROWSER_HEADLESS=1`.
  3. Await the `POST /browsers` body.
  4. Probe the advertised CDP port's `/json/version`.
- Pass criteria:
  - A registration arrives with `label: omniterm-browser`, a positive integer
    pid, and a `ws://127.0.0.1:<port>/devtools/browser/<uuid>` url.
  - That port answers `200` and reports the **same** `webSocketDebuggerUrl` —
    proving a live endpoint, not merely a well-formed string.
  - `DevToolsActivePort` exists in the dedicated dir, proving this run started
    the browser rather than reusing one.
- Cleanup: kill the pid recorded in the dir's `SingletonLock` (the true owner —
  the registered pid is the pre-re-exec process on macOS), wait for exit, then
  remove the temp dir.
- If not executable: `SKIPPED` when no Chrome/Chromium is installed.

### URLINT-T02 Shadowing `open` does not take over the command

- Testing what: blast-radius risk; the pass-through contract.
- Source refs: issue #25 "it must be more careful than the `xdg-open` shim".
- Automated checks:
  ```bash
  cd packages/core && NODE_ENV=test pnpm exec tsx --test \
    plugins/terminal/lib/browserShims.test.ts
  ```
- Steps: invoke the real shim with each of a file, a directory, `-a AppName`
  plus a URL, `-R`, `-e`, `mailto:`, `file://`, `-n -a`, and no arguments.
- Pass criteria: every one reaches the recording stand-in for the real `open`
  with its argv intact, and none reach `omniterm-browser`.
- Cleanup: temp dirs removed.

### URLINT-T03 The shim dir leads PATH in a live pane

- Testing what: the root-cause invariant (P1), at the live-pane layer.
- Source refs: spec 001 FR-010; issue #25 "secondary issue".
- Preconditions: `tmux` installed; self-skips otherwise.
- Automated checks:
  ```bash
  cd packages/core && NODE_ENV=test pnpm exec tsx --test \
    plugins/terminal/lib/tmux.integration.test.ts
  ```
- Steps: create a real tmux session through production `createTmuxSession` with
  a `~/.profile` that hoists the system dirs (the `path_helper` shape), then ask
  the pane for `$PATH` and `command -v open`.
- Pass criteria: the bin dir is the first PATH entry, and `open` resolves to the
  shim rather than `/usr/bin/open`.
- Cleanup: the suite's isolated tmux server is torn down by session name.

### URLINT-T04 A pane starts for every shell, including non-POSIX ones

- Testing what: the "dead on arrival" risk (P1).
- Automated checks:
  ```bash
  cd packages/core && NODE_ENV=test pnpm exec tsx --test plugins/terminal/lib/tmux.test.ts
  ```
- Steps: run the wrapper with a stub named `bash` and a stub named `fish`, and
  record the argv each receives.
- Pass criteria: `bash` receives `-lc` carrying the re-prepend; `fish` receives
  a plain `-l` with no sh syntax.

### URLINT-T05 Packaging ships the shims executable

- Testing what: the release behavior (P1).
- Automated checks:
  ```bash
  cd apps/omniterm && node --test scripts/bin-shims.test.mjs
  ```
- Steps: assert every non-source file in `packages/core/bin` is copied by
  `scripts/package.sh`, listed in `.gitignore`, and — unless it is in the
  `package.json` `bin` map — chmod'd by `postinstall`.
- Pass criteria: all three hold for `open` and `xdg-open`.
- If not executable: n/a (static).

## Fixtures And Environments

No secrets are required by any case in this spec.

### Local Development

- Web URL: n/a — these cases exercise shell/process behavior, not the web app.
- Accounts / roles: none.
- Data fixtures: temp dirs created per test; no repo fixtures.
- External service fixtures: a local Chrome/Chromium for URLINT-T01; `tmux` for
  URLINT-T03. Both self-skip when absent.
- Environment setup: `pnpm install` at the repo root.
- Mutation policy: `seeded_fixtures_only` — every case writes only inside
  `mkdtemp` directories and an isolated tmux socket dir.
- Known local limitations: URLINT-T01 launches a real headless Chrome against a
  dedicated user-data-dir; it never touches the user's profile or the shared
  `~/.omniterm/browser-profile`.

### Dev / Staging / Production

Not applicable — this target has no deployed surface. The published npm package
is the only release artifact, gated by URLINT-T05 plus the release workflow's
build-artifact check.

## Report Expectations

- Stable report path: `specs/007-macos-url-interception/test-report.md`.
- Report every case with `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` / `SKIPPED` /
  `NOT RUN` / `DEFERRED` / `ABORTED` / `UNKNOWN`.
- Blocking failures first.
- No secrets: none of these cases handle credentials.

## Coverage Notes

- Every behavior above maps to at least one selected strategy except the
  adopted-session row, which is explicitly `NOT COVERED` and accepted.
- Two guards (exec loop, PATH globbing) were confirmed non-vacuous by removing
  the guard and observing the test fail; record that when re-verifying.
- The Linux rows were additionally verified by hand in Docker (Debian 12, bash /
  dash / zsh). That evidence is a manual log in the report, not an automated
  gate — CI provides the dash coverage implicitly by running the suite on Ubuntu.
