# Implementation Plan: plugin platform

**Feature**: `002-plugin-platform` | **Date**: 2026-06-14 | **Spec**: `specs/002-plugin-platform/spec.md`

**Input**: Feature specification from `specs/002-plugin-platform/spec.md`

## Summary

Turn omniterm into a runtime-extensible host: a repeatable `--plugin` loader in
`@omniterm/host`, a `GET /api/plugins` manifest in `@omniterm/core`, a
manifest-driven client that renders external plugins' tab types/file-handlers/
iframes with no host-bundle rebuild, a widened `HostContext` so plugins use only
the public API, and a terminal "initial command" capability. Validated by a tiny
in-repo fixture plugin and the clean-cut acceptance test.

## Technical Context

**Language/Version**: Node 24, TypeScript 5 (strict, ESM)

**Primary Dependencies**: existing (express, http-proxy); no new runtime deps

**Testing**: `tsx --test` (unit), plus build + boot smoke; fixture-plugin load test

**Project Type**: pnpm monorepo (`@omniterm/core`, `@omniterm/host`, fixture under `plugins/`)

**Constraints**: no plugin code statically imported by host/core; zero-plugin host
unchanged; manifest is pure data; bare `--plugin` names resolve CWD-first

**Scale/Scope**: ~6 code areas changed + 1 fixture plugin + tests

## Constitution Check

- **I. Specification Authority** — PASS (derives from spec.md).
- **II. Generic Host** — PASS (no product deps added; fixture is a dev-only test plugin).
- **III. Clean Plugin Boundary (NON-NEGOTIABLE)** — central goal. Verified by
  SC-004 clean-cut test and a grep that host/core never `import` a plugin.
- **IV. Runtime Extensibility** — the feature itself.
- **V. Test/Evidence Discipline** — fixture-plugin tests for loader, manifest,
  HostContext; clean-cut gate.

No violations → Complexity Tracking empty.

## Architecture decisions

1. **Plugin entry = factory.** A plugin package's entry default-exports
   `(host: HostContext) => TabTypePlugin`. The loader `import()`s the resolved
   spec and calls the factory. (Existing `createTerminalPlugin` already matches
   this shape internally; the terminal stays a compiled-in built-in.)

2. **Manifest contract (pure data).** Extend `TabTypePlugin` with a client-facing
   `manifest` descriptor (or host-derived) exposing what the client needs without
   code:
   ```
   { type, label, icon?, ephemeral?,
     tabTypeChoice?: { label },              // shows in [+]
     fileHandlers?: [{ pattern, label }],
     endpoints: { create, list?, close? },   // URLs the client calls
     iframe: { urlTemplate } }               // e.g. "/debugger/{id}/?embedded=1"
   ```
   `GET /api/plugins` returns the array of these. The client substitutes `{id}`
   (the tab/instance id returned by `create`) into `urlTemplate`.

3. **Manifest-driven client supersedes build-time composition for external
   plugins.** Today `app/page.tsx` consumes build-time `PluginIntegration`s via
   `composeIntegrations`. We add a generic manifest consumer that, from
   `GET /api/plugins`, builds: `[+]` entries (→ POST `create` → `openTab`),
   file-context-menu handlers (→ same), persisted iframe tabs (mount-all + CSS
   visibility, the persistence the render-contract already promises), and
   indicators (poll `list`). The terminal keeps its existing built-in
   `component`-mode rendering; `composeIntegrations` stays only for built-ins.

4. **Widened HostContext.** Replace the inline `{broadcast, workspaceRoot:()=>null}`
   with a context that also exposes `confinePath`, `allowedRoots`, and
   `settings`/`repos`/`worktrees` accessors, sourced from `lib/{paths,settings,
   repos,worktrees}`. Plugins import nothing from `@omniterm/core` internals.

5. **Terminal initial command.** Add an optional initial command to terminal
   session creation (tmux `send-keys` after create) and a host route so a
   file-handler can open a terminal running a command. Manifest exposes this as a
   built-in terminal file-handler action.

6. **Loader failure = fail-fast.** Unresolvable spec, throwing factory, or
   duplicate `type`/`proxyPrefix` → clear, plugin-named error; host does not
   half-load.

## Project Structure / files touched

```text
apps/omniterm/
  src/server.ts        # parse --plugin (repeatable), resolve+import factories, startServer({plugins})
  bin/omniterm.js      # forward argv to the server entry
packages/core/
  plugins/types.ts     # widen HostContext; add manifest descriptor to TabTypePlugin
                       # SUPERSEDED: the contract moved to packages/plugin-types/index.ts
                       # (published as @omniterm/plugin-types); this file is now a
                       # re-export shim so in-repo imports keep resolving.
  server/startServer.ts# build widened HostContext; mount GET /api/plugins; (terminal initial-cmd route)
  server/routes/manifest.ts   # NEW: builds manifest from the plugin list
  plugins/terminal/lib/{sessions,tmux}.ts  # initial-command support
  app/page.tsx         # manifest consumer: [+], file handlers, persisted iframes, indicators
  app/manifestPlugins.tsx (NEW) + app/types.ts # generic manifest→integration adapter
plugins/
  _fixture-plugin/     # NEW: tiny iframe plugin using HostContext (dev/test only)
```

**Structure Decision**: keep the existing server/client split; add the loader in
the host, the manifest endpoint + widened context in core, and a generic
manifest consumer in the client. External plugins never enter the client bundle.

## Phasing (maps to tasks.md)

1. HostContext widening + `plugins/types.ts` manifest descriptor (contract first).
2. `GET /api/plugins` manifest endpoint + wire HostContext in startServer.
3. `--plugin` loader in the host (resolution + dynamic import + fail-fast).
4. Manifest-driven client rendering (the largest piece).
5. Terminal initial-command capability.
6. Fixture plugin + tests (loader, manifest, HostContext, clean-cut) + build/boot.

## Risks

- Manifest-driven client is the biggest net-new surface; the clean-cut guarantee
  depends on it carrying zero plugin-specific code. Mitigate with the fixture
  plugin + the grep/clean-cut gate.
- Iframe persistence + visibility toggling must match today's UX (no flicker /
  state loss on tab switch).

## Complexity Tracking

No constitution violations; section intentionally empty.
