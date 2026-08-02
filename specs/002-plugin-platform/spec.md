# Feature Specification: plugin platform

**Feature**: `002-plugin-platform`

**Created**: 2026-06-14

**Status**: Implemented

**Input**: Make omniterm extensible at runtime — load plugins by path or package
name without rebuilding the host, render plugin tab types from a manifest (no
plugin code compiled into the host client), and expose host services to plugins
through a public `HostContext` so plugins never import host internals. (See
`docs/prd.md` FR-005…008.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enable plugins at launch (Priority: P1)

A host operator runs `omniterm --plugin <spec>` to turn on extra tab types. `spec`
is a filesystem path (dev) or a package name (installed). The flag is repeatable
and plugins compose. With no `--plugin`, the host runs as the plain base.

**Why this priority**: The loader is the entry point of the whole platform;
without it nothing else is reachable.

**Independent Test**: Launch with `--plugin ./fixtures/<plugin>` and with
`--plugin <installed-name>`; confirm both load, and that two `--plugin` flags both
take effect.

**Acceptance Scenarios**:

1. **Given** a plugin package on disk, **When** the host starts with
   `--plugin <path>`, **Then** the plugin's routes are mounted and it appears in
   the manifest.
2. **Given** a plugin installed in the invocation's `node_modules`, **When** the
   host starts with `--plugin <name>`, **Then** it resolves CWD-first and loads.
3. **Given** two `--plugin` flags, **When** the host starts, **Then** both plugins
   load in declaration order.
4. **Given** no `--plugin` flag, **When** the host starts, **Then** the base host
   (terminals + browser-view + workspace) works unchanged.

---

### User Story 2 - Plugin tab type renders from the manifest, no rebuild (Priority: P1)

A loaded plugin contributes a tab type whose UI is its own SPA shown in an iframe.
The stock host client renders the plugin's `[+]` entry, file-context-menu item,
live-tab iframes (kept mounted across tab switches), and indicators — all from
manifest data fetched at runtime, with no plugin code compiled into the host
client bundle.

**Why this priority**: This is what makes plugins truly runtime-loadable and is
the precondition for the clean-cut guarantee.

**Independent Test**: Load a fixture iframe-plugin; confirm its tab type, file
handler, and persisted iframe all appear with the host client bundle unchanged.

**Acceptance Scenarios**:

1. **Given** a loaded iframe-plugin, **When** the client loads, **Then** its tab
   type appears in the `[+]` menu sourced from `GET /api/plugins`.
2. **Given** a file matching the plugin's pattern, **When** the user opens its
   context menu, **Then** the plugin's file-handler entry is offered.
3. **Given** two open plugin tabs, **When** the user switches between them, **Then**
   both iframes stay mounted (state preserved) and only the active one is visible.
4. **Given** a host client bundle built before the plugin existed, **When** the
   plugin is loaded, **Then** its tab type renders with **no** client rebuild.

---

### User Story 3 - Build a plugin against the public API only (Priority: P1)

A plugin author implements a tab type using only the published plugin contract:
the `TabTypePlugin` shape, and a `HostContext` that exposes the host services a
plugin needs — event broadcast, workspace root, **path confinement / allowed
roots**, and **settings / repos / worktrees** accessors — without importing any
host or core internal module.

**Why this priority**: Plugins reaching into core internals would defeat the clean
boundary and couple plugins to host internals; the debugger plugin (003) needs
these services.

**Independent Test**: A fixture plugin that resolves an allowed path via
`HostContext` (not by importing `lib/paths`) and lists repos/worktrees through
`HostContext`; confirm it works with no internal imports.

**Acceptance Scenarios**:

1. **Given** a plugin, **When** it confines a user-supplied path, **Then** it uses
   `HostContext.confinePath`/`allowedRoots` and rejects out-of-root paths.
2. **Given** a plugin, **When** it needs workspace repos/worktrees/settings, **Then**
   it reads them through `HostContext`, not `@omniterm/core` internals.

---

### User Story 4 - Plugins are deletable (clean cut) (Priority: P2)

Removing a plugin (dropping its `--plugin` flag, and deleting its package) leaves
the host building, typechecking, and booting with full base functionality.

**Why this priority**: The clean-cut invariant is the architectural promise of the
whole extraction; it must be verifiable.

**Independent Test**: Run the host with no plugins after deleting a plugin package;
confirm build + typecheck + boot are green.

**Acceptance Scenarios**:

1. **Given** the host with no plugins configured, **When** it builds and boots,
   **Then** terminals + browser-view + workspace all work.
2. **Given** a plugin package is deleted from disk, **When** the host is built and
   started without its flag, **Then** nothing in host/core fails to resolve.

---

### Edge Cases

- `--plugin` spec that cannot be resolved/imported → host fails fast with a clear
  error naming the spec (does not crash silently or half-load).
- A plugin whose factory throws on load → host reports which plugin failed and
  refuses to start (or starts without it) deterministically, not partially.
- Two plugins declaring the same tab `type` or URL prefix → deterministic,
  reported conflict rather than silent shadowing.
- Manifest fetched before any plugin is loaded → returns an empty set; client
  renders the base host with no errors.
- A plugin in the manifest whose iframe URL 404s → the tab surfaces an error, the
  rest of the host keeps working.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The host MUST accept a repeatable `--plugin <spec>` flag; `spec`
  resolves by Node rules — relative/absolute/`file:` as a filesystem path,
  otherwise a bare package name resolved **CWD-first** then host-local.
- **FR-002**: The host MUST load each plugin by dynamic `import()` of a documented
  entry (a factory returning a `TabTypePlugin`), mount its routes/upgrades, and
  compose multiple plugins in declaration order.
- **FR-003**: The host MUST expose `GET /api/plugins` returning, per plugin, the
  client-facing descriptor: `type`, `label`, `icon`, `fileHandlers`
  (pattern + label), tab render contract (iframe URL template), ephemerality, and
  the endpoints the client needs to create/list/close instances.
- **FR-004**: The host client MUST render plugin `[+]` entries, file-context-menu
  items, live-tab iframes (persisted across tab switches), and indicators from the
  manifest at runtime, with **no** plugin-specific code compiled into the client
  bundle.
- **FR-005**: `HostContext` MUST expose, beyond `broadcast`/`workspaceRoot`, the
  services plugins need: path confinement (`confinePath`) and allowed roots,
  and accessors for settings, repos, and worktrees — so plugins never import
  host/core internals.
- **FR-006**: The host MUST support opening a terminal with an initial command, so
  a file handler can offer a "run in terminal" action that drives a process whose
  browser auto-registers via `OMNITERM_BROWSER_REGISTRY_URL`.
- **FR-007**: Loading failures (unresolvable spec, throwing factory, duplicate
  type/prefix) MUST be reported clearly and handled deterministically.
- **FR-008**: With zero plugins, the host MUST behave exactly as the base host
  (clean-cut); no plugin code may be statically imported by host or core.

### Key Entities

- **Plugin spec**: the `--plugin` argument (path or package name) the loader
  resolves and imports.
- **Plugin module / factory**: the importable entry that returns a `TabTypePlugin`
  (server routes/upgrade/spawn + render contract) given a `HostContext`.
- **Plugin manifest entry**: the runtime, client-facing JSON descriptor served by
  `GET /api/plugins` (type, label, icon, fileHandlers, iframe render, endpoints,
  ephemerality) — pure data, no code.
- **HostContext**: the public service surface handed to a plugin
  (broadcast, workspaceRoot, confinePath/allowedRoots, settings/repos/worktrees).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `omniterm --plugin <path>` and `omniterm --plugin <name>` both load a
  plugin; two `--plugin` flags compose (FR-001/002).
- **SC-002**: A fixture iframe-plugin's tab type, file handler, and persisted
  iframe render from `GET /api/plugins` with the host client bundle unchanged
  (FR-003/004).
- **SC-003**: A fixture plugin performs path confinement and reads
  repos/worktrees/settings using only `HostContext` — no `@omniterm/core` internal
  import (FR-005).
- **SC-004**: Deleting a plugin package and dropping its flag leaves
  `pnpm -r build` + `pnpm -r typecheck` green and the host booting base
  functionality (FR-008) — the clean-cut acceptance test.
- **SC-005**: A file handler opens a terminal that runs a given command (FR-006).
- **SC-006**: An unresolvable/throwing plugin fails fast with a clear,
  plugin-named error and never half-loads (FR-007).

## Assumptions

- 001 (host + base SDK) is in place; this feature adds the plugin platform on top.
- The terminal plugin remains a built-in `component`-mode plugin (compiled in);
  the manifest/iframe path is for *external* plugins. The base client keeps its
  existing terminal + browser-view rendering.
- The current build-time client plugin composition (`composeIntegrations` /
  `useHomeState` / `PluginIntegration`) is superseded for external plugins by the
  manifest-driven path; any host-bundle plugin glue specific to a downstream
  consumer is removed.
- Validation uses a tiny in-repo fixture plugin (iframe + a HostContext-using
  route); the real example plugin (an out-of-tree debugger plugin) is 003
  and proves the contract end-to-end.
- No plugin search-path / drop-in directory in this feature (deferred until a
  second drop-in plugin justifies it).
