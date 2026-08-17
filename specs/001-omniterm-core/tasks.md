# Tasks: omniterm core

**Input**: `specs/001-omniterm-core/` (spec.md, plan.md)

**Tests**: Included — SC-005 requires the ported unit suites to pass.

**Nature**: This feature is a 1:1 extraction of the existing `packages/omniterm`
+ `apps/omniterm` into scoped packages, plus the decided de-branding (registry env
var + shim rename). The user-story phases here are mostly **validation** of the
shared ported code, not separate code paths.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[Story]**: US1 (terminals) / US2 (browser-view) / US3 (workspace) / — (shared)

---

## Phase 1: Setup (repo scaffolding)

- [ ] T001 Create `pnpm-workspace.yaml` with globs `apps/*`, `packages/*`,
  `plugins/*`; preserve the required linker settings (`nodeLinker: hoisted`,
  `shamefullyHoist: true`, `publicHoistPattern: ['*']`); `allowBuilds` limited to
  what core/host need (e.g. `esbuild`, `unrs-resolver`).
- [ ] T002 Create root `package.json` (private, workspace scripts: `build`,
  `test`, `typecheck`, `lint`), `.nvmrc` (`24.13.0`), `.npmrc`.
- [ ] T003 [P] Create root `tsconfig.json` (base) and
  `.gitignore` (preserve the relevant source-workspace carve-outs).

---

## Phase 2: Foundational — port the two packages (blocks all stories)

### @omniterm/core (`packages/core/`)

- [ ] T004 Copy source `packages/omniterm/**` → `packages/core/**` (all source,
  excluding `node_modules`/`dist`).
- [ ] T005 `packages/core/package.json`: name `@omniterm/core`, `private: true`,
  keep deps (codemirror set, express, http-proxy, ignore, marked) + peer
  react/react-dom; keep `exports` map; build scripts (`vite build` client +
  `tsc -p tsconfig.build.json`).
- [ ] T006 Port `packages/core/tsconfig.json`, `tsconfig.build.json`,
  `vite.config.ts`; fix any self-referential `omniterm-core` specifier.

### @omniterm/host (`apps/omniterm/`)

- [ ] T007 Copy source `apps/omniterm/**` → `apps/omniterm/**`.
- [ ] T008 `apps/omniterm/package.json`: name `@omniterm/host`, `bin.omniterm`,
  deps `@omniterm/core` (`workspace:*`) + express/http-proxy/ignore/marked;
  devDeps tsup/tsx/typescript. Do not package a DevTools frontend dependency.
- [ ] T009 Rewrite `'omniterm-core'` → `'@omniterm/core'` in `src/server.ts` and
  `tsup.config.ts` (`noExternal`); port `tsup.config.ts`, `tsconfig.json`,
  `bin/omniterm.js`, `scripts/package.sh`.

**Checkpoint**: `pnpm i` resolves; `pnpm -r typecheck` passes.

---

## Phase 3: De-branding (decided; blocks acceptance)

- [ ] T010 Rename the vendor-prefixed browser shim in `packages/core/bin/` →
  `omniterm-browser.js`; update its env read to
  `OMNITERM_BROWSER_REGISTRY_URL`; update the `bin` key in `package.json`.
- [ ] T011 Update `packages/core/plugins/terminal/lib/sessions.ts` `buildTabEnv`:
  set `OMNITERM_BROWSER_REGISTRY_URL` (replacing the vendor-prefixed name); point
  `BROWSER`/shim-path at `omniterm-browser`; rename the corresponding
  vendor-prefixed path constants in `lib/paths.ts` to `OMNITERM_BIN_DIR`.
- [ ] T012 Update `packages/core/browserRegistry/tabRegistry.ts` protocol
  comments/strings to `OMNITERM_BROWSER_REGISTRY_URL`.
- [ ] T013 Audit: a case-insensitive grep for the old vendor prefix across
  `packages/core` and `apps/omniterm` returns nothing; no vendor-scoped
  dependency is allowed (spec.md FR-009).

---

## Phase 4: User Story 1 — persistent terminals (P1) 🎯 MVP

- [ ] T014 [US1] `pnpm --filter @omniterm/host build` succeeds.
- [ ] T015 [US1] Launch `omniterm` with zero plugins; create a terminal, run a
  long process, reload the browser → session + scrollback intact (SC-001, SC-002).

**Checkpoint**: standalone terminals work.

---

## Phase 5: User Story 2 — browser-view panel (P2)

- [ ] T016 [US2] In a terminal, a child process registers a CDP endpoint to
  `OMNITERM_BROWSER_REGISTRY_URL` → browser appears in the tab's panel; kill the
  process → entry removed within the liveness interval (SC-003).
- [x] T021 [US2] Inject a feature-detected, same-origin presentation shim into
  the proxied DevTools iframe; hide the screencast split's inspector sidebar
  when `hideSidebar()` is available and fail open to stock DevTools otherwise.
- [x] T022 [US2] Verify against a live supported Chrome that the screencast fills
  the browser view, remains interactive, and an unsupported/missing internal API
  leaves stock DevTools usable.
- [x] T023 [US2] Add persisted browser panel display mode (`docked` or `overlay`)
  to shared settings, host state, Settings UI, and terminal rendering.
- [x] T024 [US2] Add persisted inspector placement (`hidden`, `right`, or
  `bottom`) and apply it through the feature-detected DevTools shim.
- [x] T025 [US2] Verify all six wide-layout combinations, mobile/full-screen
  fallback, live setting changes, persistence across reload, and fail-open
  behavior against a compatible Chrome frontend.

---

## Phase 6: User Story 3 — workspace & files (P3)

- [ ] T017 [US3] `POST /repos` a local path → it lists via repos API + appears in
  the file panel; a file read outside tracked roots is rejected (SC-004).

---

## Phase 7: Polish & evidence

- [ ] T018 [P] Wire and run the ported unit suites under `vitest`/`tsx --test`:
  paths, repos, worktrees, languages, startServer, tabRegistry, workspaceSelection,
  osc52, silenceMonitor, ttyd, ttydReadiness, warmWorkspaces, worktreeSessionErrors
  → all pass (SC-005).
- [ ] T019 Document install/dev/build/test in the root README and run it.
- [ ] T020 Run the test/typecheck/build gates and set the public spec status.

## Phase 8: Session environment (FR-010 – FR-013)

Maintenance on the terminal-session behavior this feature already owns: the pane env
scrub was shipped but unspecified, and neither the operator nor an API caller could add
to it. Names are interpolated into the wrapper script that starts every pane and into the
per-session `default-command`, so validation is a security boundary, not tidiness; values
are never interpolated (they travel as `tmux -e` argv words that tmux hands to execvp),
so they need only a length bound.

- [x] T026 `packages/core/lib/sessionEnv.ts`: one name validator (POSIX shape + reserved
  `TMUX`/`TMUX_PANE`), comma-list and argv parsing, and the host-level name list. Shared by
  both entry points so they cannot drift.
- [x] T027 `plugins/terminal/lib/tmux.ts`: `CLEAN_ENV_VARS` → `buildCleanEnvScript(extras)`,
  threaded through BOTH places the wrapper is emitted — the `new-session` argv and the
  per-session `default-command` — so a split is not a downgrade. `CLEAN_ENV_SCRIPT` stays as
  the no-extras value, keeping the unconfigured shape byte-identical.
- [x] T028 `plugins/terminal/routes/sessions.ts`: optional `env` on create-session (bounded
  32 vars × 4096 chars, no NUL, whole request rejected on any bad key), applied on create
  only; `GET /api/session-env` returns the accepted names and no values.
- [x] T029 `server/startServer.ts` + `apps/omniterm/src/server.ts` + `apps/omniterm/bin/omniterm.js`: `--env-passthrough`
  (repeatable) and `OMNITERM_ENV_PASSTHROUGH`, installed before any route is mounted, with
  the variable stripped from `process.env` alongside the other server-only ones. A malformed
  list fails the boot rather than starting terminals that silently lack configuration.
  The launcher must forward the flag EXPLICITLY: it does not pass argv through — it translates
  most flags into env vars and forwards only an allowlist (`--plugin`, now also
  `--env-passthrough`) to the server entry. A flag the server parses correctly is otherwise
  dead on arrival under the published CLI, which is exactly how this shipped the first time.
- [x] T030 Tests: `lib/sessionEnv.test.ts` (validation + parsing + fuzz list, SC-010);
  `tmux.test.ts` (unconfigured shape byte-identical, extras de-duplicated, script stays
  single-quote free, plus a real `sh` run showing an extra name survives `env -i` and an
  unlisted one does not); `routes/sessions.test.ts` (rejection paths, readback endpoint);
  `tmux.integration.test.ts` against a real tmux (per-session value reaches the pane,
  survives the initial command exiting, reaches a new window, absent from a sibling session;
  passthrough name reaches the pane while a listed-but-unset one stays unset; unconfigured
  pane unchanged).
- [x] T031 `apps/omniterm/scripts/cli-flags.test.mjs`: boot the REAL CLI (not the server module)
  and read back `/api/session-env` — forwarding, repeated flags, the unconfigured default, and the
  env-var override. Self-skips without the standalone build or ttyd/tmux. This is the level that
  catches launcher-forwarding regressions; no server-level test can.
- [x] T032 README: both paths documented, including that per-terminal values are visible via
  `ps` and that passthrough values are only as fresh as the terminal backend's start.

**Cross-repo evidence (2026-08-17)**: built the host, packed it, installed it into the real
downstream box image alongside that image's own login-shell hook, launched it through the
published CLI with the flag list the box derives, and drove `create-session` with a body built
by the downstream's own resume-invocation code. The pane came back with the four proxy
variables (image hook + passthrough) AND the per-terminal config dir, with the scrub still
holding (no `npm_*`, `NODE_ENV`, `OMNITERM_PORT`, `OMNITERM_ENV_PASSTHROUGH`, `OMNITERM_VERSION`).
That run is what exposed the launcher-forwarding defect in T029: the first attempt reported an
empty passthrough list despite a correct argv. It also confirms an older CLI simply ignores the
unknown flag rather than failing to boot.

**Evidence (2026-08-17)**: `pnpm typecheck` clean. `pnpm test` — `packages/core` 340 tests,
339 pass / **1 skipped**; the skip is the pre-existing `injector delivers correct bytes
through real ttyd + xterm.js` (Playwright Chromium not installed) and is unrelated.
`plugins/demo-agent` 5 pass, `apps/omniterm` 2 pass. The tmux integration tests **ran**
(tmux installed locally), so FR-010 – FR-013 are covered by executed tests rather than
by a skip.

**Residual risks**: the freshness limit (FR-011) and the visibility of per-terminal values
(FR-012) are documented, not enforced — nothing stops an operator routing a rotating secret
through the passthrough, or a caller sending a secret as a per-terminal value.

---

## Dependencies

- Phase 1 → Phase 2 → Phase 3 are sequential (scaffold, port, de-brand).
- Phases 4–6 (validation) depend on Phase 3; can run in any order.
- Phase 7 after the stories validate.

## Notes

- The port is mechanical; keep directory shapes identical so review is a diff of
  renames + the de-branding edits, not a rewrite.
- No plugin loader in 001 (that is 002); the terminal plugin stays compiled in.
- Commit as a single initial commit once Phase 4 (host boots) is green, per the
  agreed "fresh copy + single initial commit" — on explicit go-ahead.
