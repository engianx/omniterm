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
  deps `@omniterm/core` (`workspace:*`) + the vendored-DevTools package (kept as
  a carve-out — **later dropped**, see spec.md FR-009) + express/http-proxy/
  ignore/marked; devDeps tsup/tsx/typescript.
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
  `packages/core` and `apps/omniterm` returns nothing. (Originally one vendor-scoped dependency
  was allowed under the DevTools carve-out. That carve-out is gone, so the audit
  now allows none; see spec.md FR-009.)

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
