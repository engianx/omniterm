# Tasks: plugin platform

**Input**: `specs/002-plugin-platform/` (spec.md, plan.md)

**Tests**: Included — SC-001…006 need executable proof (fixture-plugin + clean-cut).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Foundational — contract first (blocks all stories)

- [ ] T001 `packages/core/plugins/types.ts`: widen `HostContext` with
  `confinePath(raw, roots?)`, `allowedRoots()`, and `settings()`/`repos()`/
  `worktrees(repoPath, repoId)` accessors; add a client-facing `manifest`
  descriptor type to `TabTypePlugin` (`{type,label,icon?,ephemeral?,tabTypeChoice?,
  fileHandlers?,endpoints,iframe:{urlTemplate}}`). Document the factory entry
  convention `(host) => TabTypePlugin`.
- [ ] T002 `packages/core/server/startServer.ts`: build the widened `HostContext`
  from `lib/{paths,settings,repos,worktrees}` (replace `{broadcast,
  workspaceRoot:()=>null}`); pass it to every `createRouter`.

**Checkpoint**: typecheck green with the new contract; terminal plugin still builds.

---

## Phase 2: User Story 1 — `--plugin` loader (P1)

- [ ] T003 `packages/core/server/routes/manifest.ts` (NEW) + mount `GET /api/plugins`
  in startServer: return each plugin's `manifest` descriptor (built-ins included
  where they opt in; terminal need not expose an iframe manifest).
- [ ] T004 `apps/omniterm/src/server.ts` + `bin/omniterm.js`: parse repeatable
  `--plugin <spec>`; resolve (relative/absolute/`file:` = path; else bare name
  CWD-first via `import.meta.resolve` from `process.cwd()`, then host-local);
  dynamic `import()` the factory; compose in order; `startServer({plugins})`.
  Fail-fast with a plugin-named error on unresolvable/throwing/duplicate.
- [ ] T005 [P] [US1] Test loader resolution (path + name + multiple) and
  fail-fast (unresolvable spec, throwing factory, duplicate type/prefix).

**Checkpoint**: `omniterm --plugin <fixture>` loads; `/api/plugins` lists it.

---

## Phase 3: User Story 2 — manifest-driven client (P1, largest)

- [ ] T006 `packages/core/app/manifestPlugins.tsx` (NEW): fetch `GET /api/plugins`,
  produce the generic integration — `[+]` entries (POST `create` → `openTab`),
  file-context-menu handlers, persisted iframe layer (mount-all + CSS visibility),
  indicators (poll `list`), close (DELETE) — all from manifest data.
- [ ] T007 `packages/core/app/page.tsx` (+ `app/types.ts`): consume the manifest
  integration alongside the built-in terminal; keep terminal `component` rendering;
  no plugin-specific imports.
- [ ] T008 [US2] Verify a fixture iframe-plugin's tab type + file handler +
  persisted iframe render from the manifest with the client bundle unchanged.

---

## Phase 4: User Story 4 — terminal initial command (P2, FR-006)

- [ ] T009 `packages/core/plugins/terminal/lib/{sessions,tmux}.ts`: optional
  initial command (tmux `send-keys` after create); host route + a built-in
  terminal file-handler action ("run in terminal") surfaced in the manifest.

---

## Phase 5: Fixture, tests, gates

- [ ] T010 `plugins/_fixture-plugin/` (NEW, dev/test only): a tiny factory plugin —
  an iframe tab type + one route that uses `HostContext.confinePath`/`repos` —
  proving the public API (US3/SC-003). Not published.
- [ ] T011 [P] Tests: manifest endpoint shape; `HostContext` services; grep gate
  that `@omniterm/core` + `@omniterm/host` never `import` a plugin package.
- [ ] T012 Clean-cut acceptance (SC-004): load fixture via `--plugin <path>` and
  `--plugin <name>`; then remove it → `pnpm -r build` + `pnpm -r typecheck` green,
  host boots base functionality.
- [ ] T013 Run gates (typecheck, tests, build, boot smoke) and set the public
  spec status.

---

## Dependencies

- Phase 1 (contract) blocks all. Phase 2 (loader+manifest endpoint) before Phase 3
  (client consumes manifest). Phase 4 independent of 3. Phase 5 last.

## Notes

- Keep the terminal a compiled-in built-in; only *external* plugins go through the
  manifest/iframe path.
- The clean-cut gate (T012) is the non-negotiable acceptance for this feature.
