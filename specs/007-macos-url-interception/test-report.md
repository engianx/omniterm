# Test Report: macOS URL interception (`open <url>` → tab browser registry)

**Test spec**: [test-spec.md](./test-spec.md)
**Branch / commit**: `feng/workspace` @ `7d7425f` — the change under test is the
**uncommitted working tree** on top of that commit
**Last updated**: 2026-09-11
**Tester**: Claude (agent session)

Session record: what was tested, by what test **type**, what ran, and what was
left uncovered. Facts only — no graded confidence verdict.

## Summary

- Overall session status: `PASS`
- What this session added or strengthened:
  - An **integration** proof that `open <url>` ends in a real browser
    **registered** with the tab registry, with the advertised CDP endpoint
    probed for liveness. This chain previously had **no** automated coverage —
    only a manual run — despite being the behavior issue #25 reports.
  - An integration proof of the negative: a non-URL argument starts no browser
    and registers nothing.
  - Two **unit** guards for hardening added during code review — the resolver's
    exec-loop guard and its PATH-globbing guard — both confirmed non-vacuous.
- Blocking findings: none.
- Known gaps left for follow-up:
  - Adopted (pre-upgrade) tmux sessions never pick up the fix — knowingly
    accepted, see *Deferred / Residual Risk*.
  - The published tarball's file **modes** are not asserted automatically.

## Source Material

- Source material used: [issue #25](https://github.com/engianx/omniterm/issues/25);
  `specs/001-omniterm-core/spec.md` (US1 **P1** + FR-010–FR-013; US2 **P2**);
  the working-tree diff; `packages/core/bin/{open,xdg-open,omniterm-browser.js}`.
- Source material not found or not available: no repo-root `TESTING.md` (the
  baked-in default posture applies); no PRD entry specific to this ticket, so
  priorities were carried from spec 001's user stories rather than invented.

## Commands Run

| Command | Result | Notes |
| --- | --- | --- |
| `cd packages/core && pnpm exec tsc --noEmit` | `PASS` | Clean. |
| `cd packages/core && NODE_ENV=test pnpm exec tsx --test '**/*.test.ts' --test-skip-pattern=node_modules` | `PASS` | 376 tests, 375 pass, 1 skip. |
| `cd apps/omniterm && node --test scripts/*.test.mjs` | `PASS` | 9 tests. |
| `cd packages/core && NODE_ENV=test pnpm exec tsx --test plugins/terminal/lib/browserShims.integration.test.ts` | `PASS` | 2 tests; real headless Chrome. |
| `cd packages/core && NODE_ENV=test pnpm exec tsx --test plugins/terminal/lib/browserShims.test.ts` | `PASS` | 10 tests. |
| `cd packages/core && NODE_ENV=test pnpm exec tsx --test plugins/terminal/lib/tmux.integration.test.ts` | `PASS` | 10 tests; real tmux, isolated socket dir. |
| `cd apps/omniterm && pnpm run build` | `PASS` | Verified `bin/open` is staged; `pnpm pack` tarball inspected by hand. |
| `docker run --rm -v …:/work:ro debian:12 sh /work/final.sh` | `PASS` | Linux check across bash / dash / zsh + fish; see *Manual Verification Log*. |

The one skip in the core suite is pre-existing and unrelated
(`injector delivers correct bytes through real ttyd + xterm.js` — Playwright's
chromium is not installed).

## Tests Added Or Updated

Counts are for this ticket's surface only.

| Type | Files | Tests |
| --- | ---: | ---: |
| Unit | 3 | 22 |
| Contract | 0 | 0 |
| Integration | 2 | 3 |
| E2E | 0 | 0 |
| Agent | 0 | 0 |
| Script / static | 1 | 3 |
| **Total** | **6** | **28** |

### File List

- `packages/core/plugins/terminal/lib/browserShims.test.ts` — **new**, 10 tests (unit)
- `packages/core/plugins/terminal/lib/browserShims.integration.test.ts` — **new**, 2 tests (integration)
- `packages/core/plugins/terminal/lib/tmux.test.ts` — +11 tests (unit), 1 assertion updated
- `packages/core/plugins/terminal/lib/tmux.integration.test.ts` — +1 test (integration)
- `packages/core/plugins/terminal/lib/sessions.test.ts` — +1 test (unit), 1 rewritten
- `apps/omniterm/scripts/bin-shims.test.mjs` — **new**, 3 tests (static)

## Coverage Matrix

| Behavior (from test-spec) | Priority | Test type | Coverage | Session result | Notes / gap |
| --- | --- | --- | --- | --- | --- |
| `open <url>` registers a real browser with the tab registry | P2 | integration | `COVERED` | `PASS` | CDP endpoint probed live; not proven through the panel UI |
| Non-URL `open` args pass through untouched | P1 | unit + integration | `COVERED` | `PASS` | 9 argument shapes at unit level, 1 real-process negative |
| Shim dir leads PATH after a REORDERING profile (`path_helper`) | P1 | unit + integration | `COVERED` | `PASS` | Proven at script layer and in a live tmux pane |
| Shim dir leads PATH after a REPLACING profile (Debian) | P1 | unit | `COVERED` | `PASS` | Also confirmed by hand on real Debian |
| Re-prepend idempotent, no empty PATH field | P1 | unit | `COVERED` | `PASS` | Leading and trailing cases, plus PATH == bin dir |
| `OMNITERM_BIN_DIR` stamped and allowlisted | P1 | unit | `COVERED` | `PASS` | Also asserts it is not double-prepended |
| Wrapper is POSIX (runs under dash) | P1 | unit | `IMPLICIT` | `PASS` | CI runs the suite on Ubuntu where `sh` is dash; no named assertion |
| Non-POSIX login shell still starts | P1 | unit | `COVERED` | `PASS` | Regression found in code review; fish gets plain `-l` |
| Resolver never execs itself | P1 | unit | `COVERED` | `PASS` | Fails in 15 s without the guard (was an unbounded hang) |
| Resolver treats PATH entries literally | P1 | unit | `COVERED` | `PASS` | Decoy dir the glob actually matches |
| Shims ship executable in the tarball | P1 | static | `PARTIAL` | `PASS` | Declarations gated; file modes verified manually once |
| Adopted pre-upgrade sessions pick up the fix | P1 | — | `NOT COVERED` | `DEFERRED` | Knowingly accepted; see below |
| Windows support | — | — | `NOT COVERED` | `SKIPPED` | Out of scope: omniterm needs tmux; WSL2 is covered by the Linux rows |

## Agent Test Evidence

None. No agent verification was written for this target: the behaviors are
shell, process, and packaging level, and the one cross-layer behavior (launch →
registry) is fully provable by the cheaper integration test above. This is a
deliberate allocation, not an omission.

## Manual Verification Log

### 2026-09-11

- Environment: macOS 15 (Darwin 25.6.0, arm64), plus Debian 12 / Ubuntu 22.04 /
  Ubuntu 24.04 / Fedora 41 in Docker.
- Scenarios checked:
  1. Real tmux pane on macOS with the developer's own dotfiles — `command -v
     open` resolves to the shim in both the bare-pane and initial-command paths.
  2. `open https://example.com` in a pane against a stand-in registry with
     headless Chrome — registration observed with a live CDP url.
  3. Debian 12 with a PATH-replacing `/etc/profile`, across bash / dash / zsh —
     shim dir leads PATH in all three; fish starts cleanly.
  4. `/usr/bin/open` presence across Debian 12, Ubuntu 22.04/24.04, Fedora 41 —
     **absent on all**; `kbd` ships only `openvt`.
  5. `pnpm pack` tarball — `bin/open` present at `0644`, matching `bin/xdg-open`
     and restored by `postinstall`.
- Result: all as expected.
- Anomalies: finding 4 contradicted a comment in the shim claiming Debian's
  `/usr/bin/open` is `openvt`. The comment and the resolver's hardcoded
  `/usr/bin/open` fallback were both corrected during the session.

## Findings

None blocking.

- [x] **Vacuous test caught and repaired**: the first version of the
  PATH-globbing guard passed with the guard removed — `My [Tools]` is a bracket
  expression matching nothing that exists, and POSIX leaves an unmatched glob
  unchanged. Rewritten with a decoy directory the expression actually matches;
  now fails without `set -f`. Evidence: `browserShims.test.ts`
  *"a PATH entry with glob characters is treated literally"*.
- [x] **Test-side process leak caught and repaired**: the integration test's
  teardown killed the pid the registry received, but macOS Chrome re-execs and
  the real browser is reparented to init — one headless Chrome leaked per run.
  Teardown now kills the owner pid recorded in the profile's `SingletonLock`
  and waits for exit before removing the directory. Verified zero leaked
  processes and zero leftover temp dirs after a run.

## Deferred / Residual Risk

- [ ] **Adopted pre-upgrade tmux sessions**: a session created by an older
  omniterm keeps that version's `default-command` and never receives
  `OMNITERM_BIN_DIR`, so `open <url>` there still resolves to `/usr/bin/open`.
  Not fixed: re-stamping cannot change an already-running pane's environment,
  and applying the clean-env `default-command` to sessions the user created
  outside omniterm would scrub an environment we were never asked to touch.
  Retest: after upgrading, create a **new** tab and run `command -v open`.
  Pass criterion: resolves to `<bin dir>/open`. Documented at `adoptSession` in
  `packages/core/plugins/terminal/lib/sessions.ts`.
- [ ] **Tarball file modes**: `bin-shims.test.mjs` gates the *declarations*
  (`package.sh` copies it, `.gitignore` lists it, `postinstall` chmods it), not
  the packed result. A full `pnpm pack` per test run is disproportionate; the
  release workflow's build-artifact check covers presence.
  Retest: `cd apps/omniterm && pnpm pack && tar tzvf *.tgz | grep package/bin/`.
  Pass criterion: `bin/open` present.
- [ ] **rc files that assign PATH**: the re-prepend runs after the *profile*
  pass but before the interactive shell sources its rc files. An rc that
  assigns `PATH` outright (rather than prepending, as nvm / pnpm / homebrew all
  do) can demote the shim dir again.
  Retest: in a tab, `command -v open`. Pass criterion: resolves to the shim.
- [ ] **Interactive `open <url>` is intercepted for humans too**: a design
  question raised in code review, deliberately left as-is. Typing
  `open https://…` in a tab opens omniterm's dedicated Chrome, not the user's
  default browser. `/usr/bin/open` remains the escape hatch.

## Cleanup

- Cleanup performed: killed the one leaked headless Chrome (by pid) and removed
  three stale `omnitest-udd-*` temp directories left by earlier iterations of
  the integration test before its teardown was fixed; removed the scratch Docker
  probe scripts' outputs. Verified: 0 leftover processes, 0 leftover temp dirs.
- Resources intentionally left behind: `.shiplight-agent-skills-last-update` in
  the repo root (local cache created by the Shiplight shared update-check; not
  intended to be committed — it is currently **untracked and not in
  `.gitignore`**).
- Follow-up cleanup required: none.

## Coverage Summary

- Total testing whats: 13
- COVERED: 9
- PARTIAL: 1
- IMPLICIT: 1
- NOT COVERED: 2 (1 deferred by decision, 1 out of scope)
- NOT MEASURED: 0
- MANUAL: 0
- BLOCKED: 0
- DEFERRED: 1 (the adopted-sessions row, counted above under NOT COVERED)
