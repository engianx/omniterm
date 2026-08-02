# Implementation Plan: omniterm core

**Feature**: `001-omniterm-core` | **Date**: 2026-06-14 | **Spec**: `specs/001-omniterm-core/spec.md`

**Input**: Feature specification from `specs/001-omniterm-core/spec.md`

## Summary

Establish the omniterm repo and extract the existing generic host + SDK into two
scoped packages — `@omniterm/core` (SDK) and `@omniterm/host`
(CLI app) — building cleanly and booting standalone with terminals, browser-view
panel, and workspace/file/settings management, zero plugins. The port carries the
behavior 1:1 except for the de-branding decided for this product: the browser
registry env var becomes `OMNITERM_BROWSER_REGISTRY_URL` and the launch shim
becomes `omniterm-browser`. The host originally kept a vendored Chrome DevTools
frontend (BSD-3) for the browser-view panel's live view, as a documented
carve-out. **Superseded:** that dependency was dropped when the repo was
open-sourced — the panel now uses the inspected browser's own DevTools frontend
(see spec.md FR-009).

## Technical Context

**Language/Version**: Node.js 24+, TypeScript 5 (strict, ESM only)

**Primary Dependencies**: express 5, http-proxy, ignore, marked, codemirror (lang
packs/merge/view/state), tmux + ttyd (runtime binaries); build: tsup (host
bundle), vite + @vitejs/plugin-react (core client), tsx (dev/test)

**Storage**: filesystem (settings file, workspace/repo tracking); no database

**Testing**: `tsx --test` for the ported unit suites (node:test)

**Target Platform**: Linux/macOS server process serving a browser SPA

**Project Type**: pnpm monorepo — `apps/*` (host CLI), `packages/*` (SDK), `plugins/*` (later)

**Performance Goals**: terminal session create + ttyd ready within current
budgets (ttyd readiness ~3s timeout); no regression from pre-extraction behavior

**Constraints**: host + core carry no product-specific dependencies; terminals
auto-set `OMNITERM_BROWSER_REGISTRY_URL`; boots with zero plugins

**Scale/Scope**: single-user workspace host; ~70 source files ported

## Constitution Check

*GATE: must pass before and after design.*

- **I. Specification Authority** — PASS. This plan derives from `spec.md`; the
  pre-extraction code is the artifact, not the truth.
- **II. Generic Host (No Product Coupling)** — originally PASS with one
  documented carve-out (a content-generic vendored Chrome DevTools frontend
  published under a vendor-scoped package name). **Superseded:** the carve-out
  was removed rather than re-vendored — see spec.md FR-009. Now PASS with no
  exceptions. Verified by: `@omniterm/host` and `@omniterm/core` package.json
  declare no vendor-scoped dependency at all, and no vendor-prefixed identifiers
  remain in shipped code.
- **III. Clean Plugin Boundary** — N/A for 001 (no plugin loader yet; 002). 001
  must not introduce any plugin-specific import into core/host.
- **IV. Runtime Extensibility** — N/A for 001 (002). The built-in terminal plugin
  stays compiled in (it is the base, `component`-mode).
- **V. Test/Evidence Discipline** — PASS. All existing unit suites are ported and
  must pass; SC-001…005 are the acceptance evidence.

No violations → Complexity Tracking empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-omniterm-core/
├── spec.md
├── plan.md          # this file
└── tasks.md         # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
omniterm/
├── apps/
│   └── omniterm/                 # @omniterm/host (bin: omniterm)
│       ├── bin/omniterm.js
│       ├── src/server.ts         # startServer({ port }) — no devtools-assets
│       ├── tsup.config.ts        # bundles @omniterm/core (noExternal)
│       └── package.json
├── packages/
│   └── core/                     # @omniterm/core (private, bundled)
│       ├── index.ts
│       ├── server/               # startServer + routes (fs/preview/repos/settings/worktrees)
│       ├── plugins/terminal/     # built-in terminal plugin + types.ts
│       ├── browserRegistry/      # tabRegistry + TabBrowserView
│       ├── app/                  # React client shell (page.tsx, components, globals.css)
│       ├── client/               # vite entry (index.html, main.tsx)
│       ├── lib/                  # paths/repos/worktrees/settings/languages/events/...
│       ├── bin/omniterm-browser.js   # renamed shim (+ xdg-open)
│       ├── vite.config.ts
│       └── package.json
├── pnpm-workspace.yaml           # apps/* packages/* plugins/*
├── tsconfig.json  .npmrc  .gitignore  .nvmrc
```

**Structure Decision**: Preserve the source layout in scoped packages.
`packages/omniterm` → `packages/core` (`@omniterm/core`); `apps/omniterm` →
`apps/omniterm` (`@omniterm/host`). Directory shapes inside each package are
unchanged so the port is mechanical and reviewable.

### Extraction mapping

| source | omniterm target | transform |
| --- | --- | --- |
| `packages/omniterm/**` | `packages/core/**` | copy as-is |
| `apps/omniterm/**` | `apps/omniterm/**` | copy as-is |
| pkg name `omniterm-core` | `@omniterm/core` | rename + update all importers |
| pkg name `omniterm` | `@omniterm/host` | rename; keep `bin.omniterm` |
| import `'omniterm-core'`/subpaths | `'@omniterm/core'`/subpaths | rewrite specifiers (incl. tsup `noExternal`) |
| vendor-prefixed browser shim bin | `bin/omniterm-browser.js` | rename; read new env var |
| vendor-prefixed registry env var (buildTabEnv, tabRegistry, shim) | `OMNITERM_BROWSER_REGISTRY_URL` | rename, no alias |
| vendor-prefixed browser-path constants / bin refs | omniterm-browser path | rename constants in `lib/paths.ts`, `sessions.ts` |
| `apps/omniterm` vendored-DevTools dep | kept at the time; later dropped | superseded — `devtoolsBundleDir` is now unset by default, so the panel falls back to the inspected browser's own DevTools (spec.md FR-009) |

### Key transformations (beyond file copy)

1. Package renames + specifier rewrites across both packages.
2. Registry env var + shim bin rename (decided); audit that **no** vendor-prefixed
   identifier remains in shipped code (tests/comments included).
3. Host `src/server.ts`: keep `startServer({ port, devtoolsBundleDir })` (panel
   live view) unchanged. **Superseded:** the vendored-DevTools resolution this
   step preserved was later deleted; `devtoolsBundleDir` is now set only from
   `OMNITERM_DEVTOOLS_DIR` (spec.md FR-009).
4. Repo tooling: `pnpm-workspace.yaml`, root `tsconfig`, `.npmrc`
   (`shamefully-hoist` / hoisted linker for dependency resolution), `.nvmrc`, `.gitignore`.
   Port the per-package `tsconfig`/`tsconfig.build`/`vite.config`/`tsup.config`.
5. Port all unit suites and wire `vitest`/`tsx --test` so they run in the new repo.

## Development entry points

Install, development, build, and test commands live in the repository
[`README.md`](../../README.md#development).

## Complexity Tracking

No constitution violations; section intentionally empty.
