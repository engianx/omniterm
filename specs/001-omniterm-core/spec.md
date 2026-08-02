# Feature Specification: omniterm core

**Feature**: `001-omniterm-core`

**Created**: 2026-06-14

**Status**: Implemented

**Input**: omniterm core — a generic, standalone, browser-based development host
providing persistent terminals, a live browser-view panel, and workspace/file/
settings management, usable with no plugins. (See `docs/prd.md`.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Persistent terminals in the browser (Priority: P1)

A developer launches `omniterm`, opens the URL, and works in one or more
terminals. Terminals keep running and retain scrollback if the browser tab is
closed and reopened or the network blips.

**Why this priority**: Persistent terminals are the core value of the host and
the foundation every other capability builds on. With only this, the product is
already a usable remote-terminal workspace.

**Independent Test**: Launch the host with no plugins, open a terminal, start a
long-running command, reload the browser, and confirm the session and output are
intact.

**Acceptance Scenarios**:

1. **Given** a freshly launched host with no plugins, **When** the user opens
   the UI, **Then** they can create a terminal tab and run commands.
2. **Given** a terminal running a process, **When** the browser tab is closed and
   reopened, **Then** the same session is still running with its scrollback.
3. **Given** multiple terminal tabs, **When** the user switches between them,
   **Then** each retains its own independent session and layout.

---

### User Story 2 - Watch a browser a command drives (Priority: P2)

A developer runs a command in a terminal that launches a browser (e.g. a test
run). The live browser appears in a side panel without any manual wiring, and the
developer can inspect it.

**Why this priority**: The browser-view panel is the host's second
differentiator and is what makes terminal-driven browser work observable. It
depends on terminals (P1) but is independently valuable.

**Independent Test**: In a terminal, run a process that registers a browser CDP
endpoint to the tab's registry URL; confirm the browser appears in the panel and
its DevTools view is reachable through the host.

**Acceptance Scenarios**:

1. **Given** a terminal tab, **When** a child process registers a browser to the
   tab's registry URL, **Then** the panel shows that browser for that tab.
2. **Given** a registered browser, **When** its process exits, **Then** the panel
   drops it within the liveness sweep interval.
3. **Given** two terminal tabs each with their own browser, **When** the user
   views a tab, **Then** only that tab's browser(s) are shown (tab-scoped).

---

### User Story 3 - Manage workspace and files (Priority: P3)

A developer adds repositories/directories to the workspace, browses files, opens
them to view, and sees git worktrees.

**Why this priority**: Workspace/file management makes the host a place to work,
not just a terminal. It supports the above stories but is not required for them.

**Independent Test**: Add a local path via the workspace API, confirm it appears
in the file panel, open a file, and confirm file access is confined to tracked
roots.

**Acceptance Scenarios**:

1. **Given** a running host, **When** a local repo/dir path is registered, **Then**
   it appears in the workspace/file panel and is listed by the repos API.
2. **Given** a tracked repo, **When** the user lists worktrees, **Then** the
   repo's worktrees are returned.
3. **Given** a file-read request for a path outside all tracked roots, **When**
   it is made, **Then** it is rejected (path confinement).

---

### Edge Cases

- Host launched with no plugins configured → full base functionality (terminals,
  browser view, workspace) still works.
- Requested port already in use → host fails fast with a clear error.
- tmux/ttyd not present in the runtime → host surfaces a clear startup/diagnostic
  error rather than silently failing.
- A registered browser's process dies → entry removed by the periodic liveness
  sweep; panel updates via the event stream.
- A tracked repo directory disappears → workspace listing degrades gracefully
  (the missing repo does not block access checks for others).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The host MUST provide persistent terminal sessions backed by tmux +
  ttyd that survive client disconnect/reconnect and retain scrollback.
- **FR-002**: Every terminal opened by the host MUST have
  `OMNITERM_BROWSER_REGISTRY_URL` auto-set in its environment to that tab's
  tab-scoped registry URL, so child processes can register a browser CDP endpoint
  at runtime without manual wiring. (This replaces the vendor-prefixed name the
  variable carried before extraction.)
- **FR-003**: The host MUST render registered browsers in a tab-scoped
  browser-view panel, stream add/remove events to the client, and proxy browser
  HTTP + WebSocket (CDP) traffic through the host.
- **FR-004**: The host MUST periodically drop registry entries whose owning
  process is no longer alive.
- **FR-005**: The host MUST manage a workspace of repositories, directories, and
  git worktrees, exposed over HTTP (list/add/remove repos, list worktrees) and in
  a file panel.
- **FR-006**: The host MUST confine file-access operations to tracked workspace
  roots and reject paths outside them.
- **FR-007**: The host MUST persist host/UI settings across restarts.
- **FR-008**: The host MUST be launchable via a `omniterm` CLI and MUST boot with
  full base functionality when zero plugins are configured.
- **FR-009**: The host MUST NOT depend on any domain-specific or downstream-
  product package; base functionality is self-contained.

  **Superseded (open-sourcing).** This originally carried one documented
  carve-out: a vendored vanilla Chrome DevTools frontend (BSD-3) retained for
  the browser-view panel's live view, on the grounds that only its package name
  was vendor-scoped — its contents were generic. The carve-out was
  removed rather than re-vendored. The panel now uses the DevTools frontend the
  inspected Chromium already serves on its own CDP port — a fallback core had
  supported all along (`defaultDevtoolsFrontendUrl` in
  `packages/core/browserRegistry/tabRegistry.ts`) — verified end to end against
  a live browser. `OMNITERM_DEVTOOLS_DIR` serves a custom frontend for anyone
  who wants one. FR-009 now holds with no exceptions, and the install dropped by
  roughly 120 MB.

### Key Entities

- **Terminal session**: a persistent shell (tmux session + ttyd), keyed by tab
  id, with its own layout/panes and injected environment.
- **Browser entry / view**: a registered CDP endpoint (cdpUrl, label, pid)
  belonging to a tab, presented to the client as a view with proxied DevTools.
- **Workspace item**: a tracked repo or directory, with its git worktrees.
- **Tab**: the host's minimal `{type, id, name}` unit; the base host ships the
  terminal type.
- **Settings**: persisted host/UI configuration (e.g. default shell).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `omniterm` launched with zero plugins boots and serves a working
  terminal + browser-view + workspace UI.
- **SC-002**: A terminal session and its scrollback survive a browser reload.
- **SC-003**: A browser registered by a terminal child process appears in the
  panel for that tab and is removed within the liveness interval after its
  process exits.
- **SC-004**: A local path added via the workspace API is listed by the repos API
  and appears in the file panel; a file read outside tracked roots is rejected.
- **SC-005**: Ported unit suites (paths, repos, worktrees, startServer,
  tabRegistry, languages, workspace selection) pass in the new repo.

## Assumptions

- The implementation is extracted from existing `packages/omniterm`
  (`omniterm-core`) and `apps/omniterm` code; that code is the implementation
  artifact of this spec, not the source of truth.
- The runtime provides `tmux` and `ttyd` (as in the current workspace image).
- Node.js 24+ / TypeScript 5 (strict, ESM).
- Plugin extensibility (loader, manifest, widened HostContext) is **out of scope
  for 001** and specified in 002; 001 establishes the host, the built-in terminal
  type, and the browser/workspace/settings foundations only.
- The browser registry env var is renamed to `OMNITERM_BROWSER_REGISTRY_URL`
  (from its vendor-prefixed pre-extraction name); no legacy alias is set. The
  launch shim bin is likewise renamed to `omniterm-browser` and reads the new
  var. Registering tools read the new name; no legacy alias is set. The env var
  is the entire contract — the host does not know or care which tool registers a
  browser with it.
