# Implementation Plan: omniterm core

**Feature**: `001-omniterm-core` | **Date**: 2026-06-14 | **Spec**: `specs/001-omniterm-core/spec.md`

**Input**: Feature specification from `specs/001-omniterm-core/spec.md`

## Summary

Establish the omniterm repo and extract the existing generic host + SDK into two
scoped packages — `@omniterm/core` (SDK) and `@omniterm/host`
(CLI app) — building cleanly and booting standalone with terminals, browser-view
panel, and workspace/file/settings management, zero plugins. The browser
registry env var is `OMNITERM_BROWSER_REGISTRY_URL` and the launch shim is
`omniterm-browser`. The panel uses the inspected browser's own DevTools frontend
and injects a tiny, same-origin presentation shim after that frontend loads. The
shim feature-detects the screencast split-view API, hides the inspector sidebar
when compatible, and otherwise leaves stock DevTools unchanged.
The same presentation layer accepts persisted user choices: the browser panel
renders either in the terminal flex row or in an absolute right-side overlay,
and the shim hides the inspector or places it to the right or below the page.

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
- **II. Generic Host (No Product Coupling)** — PASS. `@omniterm/host` and
  `@omniterm/core` declare no vendor-scoped dependency, the browser view reuses
  the inspected browser's frontend, and no vendor-prefixed identifiers remain
  in shipped code.
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
| Chrome DevTools frontend | no packaged dependency | use the inspected browser's own frontend; keep `devtoolsBundleDir` as an operator override |

### Key transformations (beyond file copy)

1. Package renames + specifier rewrites across both packages.
2. Registry env var + shim bin rename (decided); audit that **no** vendor-prefixed
   identifier remains in shipped code (tests/comments included).
3. Host `src/server.ts`: keep `startServer({ port, devtoolsBundleDir })` as an
   operator override. Without it, proxy the inspected browser's own DevTools
   frontend (spec.md FR-009).
4. Repo tooling: `pnpm-workspace.yaml`, root `tsconfig`, `.npmrc`
   (`shamefully-hoist` / hoisted linker for dependency resolution), `.nvmrc`, `.gitignore`.
   Port the per-package `tsconfig`/`tsconfig.build`/`vite.config`/`tsup.config`.
5. Port all unit suites and wire `vitest`/`tsx --test` so they run in the new repo.
6. Browser-view presentation: ship a small public module that is injected into
   the proxied DevTools iframe on load. It imports the frontend's own screencast
   module from the same proxied base URL, waits for its split view, and applies
   `hideSidebar()` or the requested horizontal/vertical split orientation. It
   records diagnostic state. All lookup and mutation is feature-detected;
   failure preserves a usable stock frontend.
7. Persist `browserPanelMode` and `browserInspectorPosition` with the existing
   settings API. Thread them through host state into the terminal integration.
   Docked mode keeps the view in the terminal row; overlay mode positions the
   same resizable view above the terminal on the right. Inspector placement is
   carried on the injected module element and remounts only the DevTools iframe
   when changed.

## Development entry points

Install, development, build, and test commands live in the repository
[`README.md`](../../README.md#development).

## Complexity Tracking

No constitution violations; section intentionally empty.
