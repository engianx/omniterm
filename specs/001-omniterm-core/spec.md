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
developer can choose whether the browser is docked beside or overlaid on the
terminal. The developer can hide the DevTools inspector or place it to the right
or below the interactive page. Stock DevTools remains the compatibility
fallback.

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
4. **Given** Chrome's proxied DevTools frontend exposes the screencast split-view
   API and the inspector setting is `hidden`, **When** the browser view loads,
   **Then** the interactive screencast fills the view and the inspector is hidden.
5. **Given** a DevTools frontend that does not expose the expected internal API,
   **When** the browser view loads, **Then** the shim makes no structural changes
   and the stock DevTools view remains usable.
6. **Given** a wide viewport, **When** the user selects `docked` or `overlay` for
   the browser panel, **Then** an open browser view respectively consumes layout
   space beside the terminal or floats above it without shrinking the terminal.
7. **Given** an open browser view, **When** the user selects inspector placement
   `hidden`, `right`, or `bottom`, **Then** the DevTools split updates to page
   only, page with inspector on the right, or page with inspector below.
8. **Given** saved browser display and inspector settings, **When** the host is
   reloaded, **Then** both choices are restored. Narrow/mobile viewports use the
   existing full-screen overlay presentation regardless of the saved panel mode.

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
- Chrome changes or removes the internal DevTools screencast split-view API →
  the optional presentation shim fails open to the unmodified frontend.
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
  HTTP + WebSocket (CDP) traffic through the host. The browser panel MUST offer
  persisted `docked` and `overlay` display modes on wide viewports. It MUST offer
  persisted inspector placements `hidden`, `right`, and `bottom`. Inspector
  layout changes MUST be feature-detected and MUST leave the stock frontend
  usable when unsupported. Narrow/mobile layouts MUST keep the existing
  full-screen overlay behavior.
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
  product package; base functionality is self-contained. The browser view uses
  the DevTools frontend served by the inspected Chromium and MAY apply a small,
  fail-open presentation shim. `OMNITERM_DEVTOOLS_DIR` MAY supply a custom
  frontend without making that frontend a host dependency.

### Key Entities

- **Terminal session**: a persistent shell (tmux session + ttyd), keyed by tab
  id, with its own layout/panes and injected environment.
- **Browser entry / view**: a registered CDP endpoint (cdpUrl, label, pid)
  belonging to a tab, presented to the client as a view with proxied DevTools.
- **Workspace item**: a tracked repo or directory, with its git worktrees.
- **Tab**: the host's minimal `{type, id, name}` unit; the base host ships the
  terminal type.
- **Settings**: persisted host/UI configuration (e.g. default shell).
- **Browser presentation settings**: persisted panel display mode (`docked` or
  `overlay`) and DevTools inspector placement (`hidden`, `right`, or `bottom`).

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
- **SC-006**: Against a compatible Chrome frontend, the browser view hides the
  inspector sidebar while retaining a visible interactive screencast; when the
  internal API is unavailable, stock DevTools remains unchanged.
- **SC-007**: Browser panel display mode and inspector placement apply without a
  host restart, survive reload, and produce all supported dock/overlay and
  hidden/right/bottom layouts.

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
