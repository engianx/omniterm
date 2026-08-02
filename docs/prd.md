# Product Requirements Document

## Product Summary

omniterm is a lightweight, browser-based development host. It gives a user
persistent terminals, a live browser-view panel, and workspace/file management
in one screen, and it is extensible at runtime through a plugin API. omniterm is
a **generic, standalone, publishable product**: it knows nothing about any
particular downstream domain. Domain-specific capabilities (e.g. a YAML test
debugger) are delivered as separate, optional plugins that can be added or
removed without touching the host.

Why now: the host shell, terminal multiplexer, and browser-view panel solve a
general problem and support more than one integration. A generic product with a
clean plugin boundary can evolve independently and be embedded by unrelated
consumers.

## Product Actors And Jobs

- **Developer / end user**: open persistent terminals, run commands, watch the
  browser a command drives, and browse/edit workspace files — all in the browser,
  surviving disconnects.
- **Plugin author**: add a new tab type (its own UI + backend routes) without
  forking or rebuilding the host.
- **Host integrator** (an app that launches or embeds omniterm): run omniterm as
  a standalone process and enable a chosen set of plugins, with no compile-time
  coupling to host internals.

## Goals

- A generic terminal multiplexer with persistent sessions.
- A browser live-view panel fed by a simple runtime registration protocol.
- Workspace, repo/worktree, and file management.
- Runtime plugin extensibility: load plugins by path or package name, no host
  rebuild, multiple plugins compose.
- A clean plugin boundary: any plugin is deletable; the host still runs.
- No product-specific dependencies in the host or its SDK.

## Non-Goals

- Domain-specific behavior (YAML test debugging, recorders, locator pickers).
  These are plugins, not host features.
- Coupling to any single downstream product or its npm packages.
- A plugin marketplace / search-path discovery (deferred until a second
  drop-in plugin justifies it).

## Core Workflows

1. **Launch host**: `omniterm` boots a server; the browser UI shows terminals +
   the browser-view panel with zero plugins configured.
2. **Persistent terminal**: open a terminal tab; it survives client reconnect
   (tmux + ttyd). Commands run in the tab inherit a registry URL env var.
3. **Watch a browser**: a process started in a terminal launches a browser and
   registers its CDP endpoint to the tab's registry; the panel renders it; CDP
   is proxied through the host.
4. **Load a plugin**: `omniterm --plugin <path|name>` (repeatable). The host
   dynamically imports each plugin, mounts its routes, and serves its manifest
   entry; the client renders the plugin's tab type / file handlers / iframe from
   manifest data — no client rebuild.
5. **Remove a plugin**: deleting a plugin package and dropping its `--plugin`
   flag leaves the host fully functional.

## Requirements

### Functional Requirements

- FR-001: Persistent terminal sessions backed by tmux + ttyd, surviving client
  disconnect/reconnect, with per-session environment injection. Each session
  starts from a clean environment — a new tab behaves like a freshly opened
  terminal window rather than inheriting arbitrary variables from whatever
  launched the host — with only an explicit allowlist carried through. Panes
  and windows opened inside a session are equally clean.
- FR-002: Browser-view registry — a runtime HTTP protocol where child processes
  POST a CDP endpoint to a tab-scoped registry URL; the client subscribes (SSE)
  and renders the live browser; CDP HTTP/WS is proxied through the host. The
  registry URL is exposed to processes via `OMNITERM_BROWSER_REGISTRY_URL`,
  auto-set on every terminal the host opens.
- FR-003: Workspace management — track repos, directories, and git worktrees;
  expose them over HTTP (`GET/POST /repos`, worktrees) and in a file panel with
  context-menu file handlers.
- FR-004: Settings persistence for host/UI configuration.
- FR-005: Runtime plugin loader — `--plugin <spec>` repeatable; `spec` resolved
  by Node's rules (relative/absolute/`file:` = filesystem path; otherwise a bare
  package name resolved CWD-first, then host-local). Plugins compose in order.
- FR-006: Plugin manifest — `GET /api/plugins` returns each plugin's
  `{type, label, icon, fileHandlers, render, ...}`; the host client renders the
  `[+]` entry, file-context-menu items, indicators, and persisted iframe tabs
  from this data with no plugin code compiled into the client bundle.
- FR-007: `HostContext` services for plugins — `broadcast`, `workspaceRoot`,
  `allowedRoots`, `confinePath`, settings/repos/worktrees accessors — so plugins
  never import host/core internals.
- FR-008: Clean-cut guarantee — removing any plugin package (and its flag)
  leaves the host building and booting with full base functionality.
- FR-009: CLI `omniterm` launches the server (bin name `omniterm`).
- FR-010: Pseudonymous usage and performance telemetry, attributed to a random
  installation id and carrying no names, hostnames, paths, plugin identifiers,
  or content. Server and browser capture disable GeoIP enrichment. It is opt-out
  and fails closed: any opt-out signal, an unconfigured destination, or an
  automated context disables it. Performance timings remain available locally
  regardless of whether telemetry is enabled.
- FR-011: Dedicated in-panel viewers for non-text files — images, PDFs, and
  CSV/TSV — dispatched by extension, delivered through the existing
  path-confined content route, and loaded on demand so they do not weigh down
  first load. Files without a dedicated viewer keep their current behavior.
- FR-012: Mobile terminal input — an on-screen chrome that supplies the meta
  and control keys a soft keyboard lacks, and a compose path that delivers
  dictated or typed text to the terminal exactly once.
- FR-013: Clean terminal environment — new sessions, splits, and tmux windows
  start from an explicit allowlist rather than inheriting arbitrary variables
  from the process that launched omniterm.

### Non-Functional Requirements

- NFR-001: Packaging is fully scoped under `@omniterm/*`. `@omniterm/host`
  publishes the CLI (bin: `omniterm`); `@omniterm/core` is the SDK (private,
  bundled into the host via tsup); `@omniterm/plugin-types` publishes the
  type-only plugin contract, so a plugin can be built in its own repository
  without depending on core; plugins are their own packages.
- NFR-002: Host and core carry **no** product-specific dependencies. Any such
  dependency belongs to a plugin package. The one former carve-out — a vendored
  Chrome DevTools frontend the host served at `/devtools/` (see
  `specs/001-omniterm-core/spec.md` FR-009) — was dropped: the panel now uses the
  DevTools frontend the inspected Chromium already serves on its own CDP port
  (`defaultDevtoolsFrontendUrl`), which removed ~120 MB from every install.
  `OMNITERM_DEVTOOLS_DIR` points the panel at a custom frontend for anyone who
  wants one.
- NFR-003: Node.js 24+ / TypeScript 5 (strict, ESM only).
- NFR-004: The plugin contract (loader, manifest, `HostContext`) is the only
  supported extension surface; plugins do not reach into host internals.

## Data And Integrations

- tmux + ttyd for terminal sessions.
- Chrome DevTools Protocol (CDP) for the browser-view panel, proxied via the
  registry.
- A registry URL env var `OMNITERM_BROWSER_REGISTRY_URL`, auto-set on every
  terminal and inherited by child processes.
- Optional Chrome DevTools frontend bundle (per-plugin asset) for the live view.
- PostHog for opt-out telemetry in official builds; source builds have no key.

## Release Areas

### MVP

- 001 omniterm core — generic host + SDK (terminals, browser-view panel,
  workspace/file/settings).
- 002 plugin platform — `--plugin` loader, manifest-driven iframe client,
  widened `HostContext`.
- 003 first out-of-tree plugin — a YAML test debugger, proving the clean cut.
  Shipped from its own repository; its spec lives there, not under `specs/`.

### Post-MVP

Shipped after the MVP arc, each specified independently under `specs/`:

- 004 telemetry — pseudonymous usage + performance signals, opt-out and
  fail-closed (FR-010).
- 005 richer file viewers — image, PDF, and CSV/TSV viewers in the file panel
  (FR-011).
- 006 mobile terminal input — accessory key bar and compose field for phones
  and tablets (FR-012).
- 007 clean session environment — explicit environment allowlist for new panes
  and windows (FR-013).

### Later

- Plugin search-path / drop-in discovery directory.
- Additional example plugins.

## Success Criteria

- SC-001: `omniterm` boots with persistent terminals + browser-view panel and
  **zero** plugins configured.
- SC-002: `omniterm --plugin <name>` and `omniterm --plugin <path>` both load a
  plugin; multiple `--plugin` flags compose.
- SC-003: Clean-cut test passes: `rm -rf plugins/<plugin>` → `pnpm -r build` +
  `pnpm -r typecheck` green and `omniterm` still boots base functionality.
- SC-004: A plugin contributes a tab type rendered from the manifest with **no**
  rebuild of the host client bundle.

## Risks And Open Questions

- **Resolved.** Registry env var renamed to `OMNITERM_BROWSER_REGISTRY_URL` and
  shim bin renamed to `omniterm-browser`; no legacy alias. Any tool that wants
  its browser to appear in the panel sets that variable and POSTs its CDP URL to
  it — the variable is the whole contract, and the host has no knowledge of who
  sets it.
- **Resolved.** Whether `@omniterm/core` should be published independently: it
  stays private and bundled. The plugin contract it re-exports is published
  separately as `@omniterm/plugin-types`, which is what external plugin authors
  depend on — so core's internals never became a public API.
- The terminal "open with an initial command" capability (needed for one-click
  file-handler → run-in-terminal flows) — host feature, scoped under 001/002.
