/**
 * Tab-Type Plugin API — the whole contract between omniterm and a plugin.
 *
 * This package contains TYPES ONLY. It is published separately from
 * `@omniterm/host` so a plugin can be developed and built in its own
 * repository, with no dependency on omniterm's internals and nothing to
 * install at runtime (every import below is erased at build time).
 *
 * `@omniterm/core` re-exports everything here, so in-repo code can keep
 * importing from `plugins/types.js`, `lib/repos.js`, and `lib/settings.js`
 * as before. This file is the single source of truth for those shapes.
 *
 * omniterm hosts multiple "tab types" — terminal, debugger, agent. Each tab
 * type is a plugin that owns its backend process, its HTTP/WS routes, and
 * its frontend rendering. The host knows nothing about tab-type-specific
 * behavior; it just dispatches to plugins.
 *
 * Key architectural decisions:
 *
 *   1. Terminal is a "built-in plugin" (distributed with the host) — no
 *      special-casing. Debugger is also a plugin, just in a separate
 *      folder. Both register through the same interface.
 *
 *   2. Plugins own their layout. The host hands each plugin a rectangle
 *      of screen space; the plugin renders whatever it wants inside,
 *      including internal splits (terminal's panes) or iframes
 *      (debugger's SPA). Simpler API, fewer host concerns.
 *
 *   3. Render contract supports both iframe and native React component.
 *      Terminal uses component mode (xterm.js is a React widget operating
 *      on raw WebSocket bytes; no point putting it in an iframe).
 *      Debugger uses iframe mode (its UI is a separate SPA bundle with
 *      its own build).
 *
 *   4. Plugins own their HTTP routes under a proxyPrefix. The host mounts
 *      each plugin's router at its declared prefix. Event streams,
 *      registrations, and any other plugin-specific endpoints live under
 *      the prefix and don't collide across plugins.
 *
 *   5. Tab lifecycle is plugin-driven. Host calls `spawn()` to create an
 *      instance; plugin returns a `TabInstance` with `close()`. The host
 *      never interprets the instance's internal state — it just holds
 *      the handle and calls `close()` when the user closes the tab.
 *
 *   6. Iframe persistence (FR-005: keep debugger iframes mounted across
 *      tab switches so in-flight session state survives) is handled by
 *      the render contract: the host mounts every live tab's rendering
 *      simultaneously, toggling visibility via CSS. Plugins that DON'T
 *      care about persistence pay no cost (their component just renders
 *      hidden). Plugins that DO care (debugger) get the property for
 *      free.
 */

import type { Router } from 'express';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

// ========================================================================
// Workspace data shapes
//
// These cross the plugin boundary via HostContext, so they live here rather
// than in core. Core's lib/repos.ts, lib/worktrees.ts, and lib/settings.ts
// re-export them — those modules still own the behavior, this file owns the
// shape.
// ========================================================================

/** A tracked repository or plain directory in the workspaces panel. */
export interface Repo {
  /** Path-derived and unique — see core's lib/ids.ts. Not the directory name. */
  id: string;
  /** Directory name, for display only. Two tracked repos may share one. */
  name: string;
  remoteUrl: string;
  path: string;
}

/** A git worktree belonging to a tracked repo. */
export interface Worktree {
  /** Path-derived and globally unique — see core's lib/ids.ts. Not the directory name. */
  id: string;
  repoId: string;
  branch: string;
  path: string;
  name: string;
  isMain: boolean;
}

/** Display mode shared by side panels with docked/overlay support. */
export type PanelDisplayMode = 'overlay' | 'docked';
export type WorkspacesPanelMode = PanelDisplayMode;
export type FilesPanelMode = PanelDisplayMode;

/** xterm renderer used by ttyd: 'webgl' (GPU, fast) or 'dom' (compatible fallback). */
export type TerminalRenderer = 'webgl' | 'dom';

/** Persisted host settings, as handed to plugins by `HostContext.settings()`. */
export interface Settings {
  trackedRepos: string[];
  trackedDirs: string[];
  lastActiveWorktree: string | null;
  sidebarCollapsed: boolean;
  namingSchemes: Record<string, string>;
  terminalFontSize: number;
  defaultShell: string;
  // path -> terminal tabs (each 1:1 with a tmux session). Persists tab order
  // and custom names; the live session set is the source of truth on restore.
  // Migrated from the legacy `tabLayouts` key, whose entries carried a now-
  // removed `layout` field from the split-pane feature (dropped on migration).
  terminalTabs: Record<string, { id: string; name: string }[]>;
  activeSessionId: string | null;
  activePath: string | null;
  /**
   * Display mode for the left workspaces panel on wide viewports.
   * "docked" pins it as a permanent left sidebar; "overlay" floats it
   * over the terminal area. Narrow viewports (< 768px) always overlay
   * regardless of this value.
   */
  workspacesPanelMode: WorkspacesPanelMode;
  /**
   * Visibility of the docked workspaces panel. Only consulted when
   * `workspacesPanelMode === "docked"` and the viewport is wide. The
   * overlay path uses transient in-memory state, not this setting.
   */
  workspacesPanelDockedOpen: boolean;
  /**
   * Display mode for the right files panel on wide viewports.
   * "docked" pins it as a permanent right sidebar (auto-narrows to
   * tree-only when no file tabs are open); "overlay" floats it over
   * the terminal area. Narrow viewports (< 768px) always overlay.
   */
  filesPanelMode: FilesPanelMode;
  /**
   * Visibility of the docked files panel. Only consulted when
   * `filesPanelMode === "docked"` and the viewport is wide. The
   * overlay path uses transient in-memory state, not this setting.
   */
  filesPanelDockedOpen: boolean;
  /**
   * Whether the browser-view side panel is open in the UI. null means
   * "user has never interacted with it" — the frontend picks a default
   * (open on desktop, closed on mobile) on first render.
   */
  browserPanelOpen: boolean | null;
  /**
   * Per-workspace open file tabs. Key is the workspace dir (matches
   * activePath); value is the list of relative paths currently open in
   * the file panel and which one is active. Empty/missing key → no tabs.
   */
  filePanelTabs: Record<string, { open: string[]; active: string | null }>;
  /**
   * Whether pseudonymous usage + performance telemetry is enabled. Opt-out:
   * defaults to true; set false (via the Settings UI or `omniterm telemetry
   * off`) to disable. Env signals (DO_NOT_TRACK, OMNITERM_TELEMETRY=0) override
   * this and force telemetry off regardless.
   */
  telemetryEnabled: boolean;
  /**
   * xterm renderer for terminals. 'webgl' (default) is GPU-accelerated and far
   * faster for large scrollback; 'dom' is the compatible fallback if webgl
   * misbehaves (rendering/selection glitches on some GPUs or remote setups).
   * Applies to newly opened terminals.
   */
  terminalRenderer: TerminalRenderer;
}

// ========================================================================
// Plugin contract
// ========================================================================

/**
 * A tab-type plugin. One plugin per tab type (terminal, debugger, etc).
 * Registered with the host at startup.
 */
export interface TabTypePlugin<TInstance extends TabInstance = TabInstance> {
  /** Stable identifier. Shown in the [+] dropdown and stored on tabs. */
  readonly type: string;

  /** Human-readable label for the [+] dropdown entry. */
  readonly label: string;

  /** Optional: SVG icon path or inline SVG string. */
  readonly icon?: string;

  /**
   * Express mount point for this plugin's router. Passed directly to
   * `app.use(proxyPrefix, plugin.createRouter(host))`.
   *
   * Two common shapes:
   *   - Parameterized: `"/t/:tabId"` — router's relative paths are
   *     automatically tab-scoped and its `req.params.tabId` is populated.
   *     Used by plugins whose URLs carry the tab id (terminal).
   *   - Root: `""` — router handles all its own paths, including the
   *     plugin's URL prefix inline. Used by plugins whose routes don't
   *     share a single prefix (debugger has `/api/debugger/*`,
   *     `/debugger/static/*`, `/debugger/:id/*`).
   */
  readonly proxyPrefix: string;

  /**
   * Build the Express router that handles this plugin's HTTP routes.
   * Called once at host startup. The plugin owns everything under
   * `proxyPrefix`: tab-scoped state endpoints, SSE streams, registry
   * writes, whatever the plugin needs.
   */
  createRouter(host: HostContext): Router;

  /**
   * Handle WebSocket upgrades that target this plugin's prefix. Called
   * by the host when the upgrade URL starts with `proxyPrefix`. If the
   * plugin doesn't handle WS, return false (or omit the method).
   */
  handleUpgrade?(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;

  /**
   * Create a new tab instance. Called when the user picks this tab type
   * from the [+] dropdown, or via a context-menu file handler.
   *
   * The returned `TabInstance` lives until `close()` is called.
   */
  spawn?(args: SpawnArgs): Promise<TInstance>;

  /**
   * Optional: called by the host AFTER `instance.close()` when a tab is
   * being removed. Purpose: clean up plugin-scoped state keyed on tabId
   * that lives OUTSIDE the instance (e.g., a tab-local registry stored
   * in a `Map<tabId, ...>` inside the plugin's router). Plugins that
   * keep all state inside the `TabInstance` object don't need this.
   */
  cleanupTab?(tabId: string): void | Promise<void>;

  /**
   * File-association menu entries for the file panel's right-click. When
   * a user right-clicks a file matching `pattern`, the menu includes
   * `label`; clicking it invokes `spawn({ workspaceRoot, openFile })`.
   *
   * Example: debugger's pattern `"*.test.yaml"` + label "Open in debugger".
   */
  readonly fileHandlers?: ReadonlyArray<{
    pattern: string; // glob-like; "*.test.yaml" etc.
    label: string;
  }>;

  /**
   * How the tab's UI is rendered. Two variants:
   *
   *   - `iframe`: host mounts an <iframe src={urlFor(instance)}>. Good for
   *     plugins whose UI is a separate SPA (e.g. debugger). The URL is
   *     typically under the plugin's proxyPrefix.
   *
   *   - `component`: host dynamically imports the module and mounts the
   *     default-exported React component. The component receives the
   *     `TabInstance` as prop. Good for plugins whose UI is tightly
   *     integrated with host React (e.g. terminal's xterm.js splitter).
   *
   * The host mounts every live tab's render simultaneously and toggles
   * visibility via CSS. Plugins that need cross-tab-switch state
   * persistence (debugger) get it automatically; those that don't pay
   * nothing.
   */
  readonly render?:
    | { type: 'iframe'; urlFor: (inst: TabInstance) => string }
    | { type: 'component'; componentPath: string };

  /**
   * Client-facing manifest entry served at `GET /api/plugins`. External
   * iframe plugins MUST provide this so the stock host client can render
   * them from data with no client-bundle rebuild. Built-in component
   * plugins (e.g. terminal) may omit it.
   */
  readonly manifest?: PluginManifestEntry;
}

/**
 * Client-facing, data-only descriptor of a plugin, returned by
 * `GET /api/plugins`. Contains no code: the host client renders the tab
 * type, file handlers, and iframe from these fields. `{id}` placeholders
 * are substituted by the client with the instance id returned by `create`.
 */
export interface PluginManifestEntry {
  readonly type: string;
  /** Human label for the tab type (used for the tab and as the name fallback). */
  readonly label: string;
  readonly icon?: string;
  /** Tab state is process-bound; do not restore from saved settings on reload. */
  readonly ephemeral?: boolean;
  /**
   * When set, the plugin appears in the `[+]` dropdown with this label. Omit for
   * file-handler-only plugins (which are reachable only via the file context menu).
   */
  readonly tabTypeChoice?: { readonly label: string };
  /**
   * File-context-menu entries. When the user picks one for a file matching
   * `pattern`, the client POSTs `{ openFile: <absPath> }` to `endpoints.create`
   * and opens the returned instance as a tab.
   */
  readonly fileHandlers?: ReadonlyArray<{ readonly pattern: string; readonly label: string }>;
  /** URLs the client calls to manage instances. */
  readonly endpoints: {
    /**
     * POST to create/open an instance. Request body: `{ workspaceRoot?, openFile? }`
     * (`openFile` is set for file-handler opens). Response: a `PluginInstance`.
     * The returned `id` is the tab id and the value substituted into
     * `iframe.urlTemplate`.
     */
    readonly create: string;
    /** GET -> `{ items: PluginInstance[] }`. Drives file indicators + reload restore. */
    readonly list?: string;
    /**
     * DELETE template containing `{id}`, called when the tab closes. Stateful
     * plugins MUST set this or they leak backend instances on tab close.
     */
    readonly closeTemplate?: string;
  };
  /**
   * Iframe tab rendering. The client substitutes two placeholders from the
   * instance, each URL-encoded:
   *   - `{id}`   → the instance id (always present).
   *   - `{file}` → the instance's bound `file` (encoded; empty string if absent).
   * A plugin that resolves all context server-side from `{id}` can use just
   * `{id}`; `{file}` is for SPAs that need the bound path in the URL on load
   * (e.g. the embedded debugger restoring its selected test file).
   */
  readonly iframe: { readonly urlTemplate: string };
}

/**
 * An instance row returned by `endpoints.create` and in `endpoints.list`'s
 * `items`. Plugins may extend it with their own fields; the client reads only
 * these. Keeps the data-driven client free of plugin-specific shapes.
 */
export interface PluginInstance {
  readonly id: string;
  /** Tab display name; falls back to the manifest `label` when absent. */
  readonly name?: string;
  /**
   * Lifecycle status. The client mounts the iframe only when `running` (or when
   * `status` is absent), so a still-starting backend isn't shown as a broken tab.
   */
  readonly status?: 'starting' | 'running' | 'ended';
  /** Absolute file this instance is bound to, if any; drives the file-panel indicator. */
  readonly file?: string;
}

/**
 * Handle to a running tab instance. Every plugin returns a `TabInstance`
 * (or subtype) from `spawn()`; the host holds it and calls `close()`
 * when the user closes the tab.
 *
 * Plugins may subtype this to carry instance-specific data (e.g., the
 * terminal plugin's `TerminalTabInstance extends TabInstance` with
 * `layout` + `sessions`). The extra fields are opaque to the host but
 * available to the plugin's own components.
 */
export interface TabInstance {
  /** Stable id, used in URLs and as the host's tab key. */
  readonly tabId: string;
  /** Plugin type this instance belongs to — matches `TabTypePlugin.type`. */
  readonly type: string;
  /** Display name for tab bar. Plugins can set/update via host APIs. */
  name: string;
  /** Close the tab: stop backend process, free resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Args passed to `spawn()`. Three cases covered:
 *
 *   - Plain "new tab": host calls with `workspaceRoot` only.
 *   - From file context menu: `openFile` carries the file path.
 *   - Programmatic (future): host-side triggers like CLI-attach.
 */
export interface SpawnArgs {
  /** Absolute path to the current workspace root (where `cwd` defaults). */
  workspaceRoot: string;
  /** Optional file to open. Used by plugins' fileHandlers. */
  openFile?: string;
  /** Optional workspace/worktree metadata; host passes what it has. */
  worktreeId?: string;
}

// ========================================================================
// Host context — what plugins get access to at create time
// ========================================================================

/**
 * Services the host exposes to plugins at router-creation time. Kept
 * deliberately minimal; plugins should not reach into host internals.
 */
export interface HostContext {
  /**
   * Broadcast a host-level SSE event on `/api/events`. Used for
   * cross-cutting concerns (file-changed, tab-added, etc.) that
   * multiple plugins / the host UI may care about.
   *
   * Plugin-specific events should go through the plugin's own SSE
   * stream under its proxyPrefix, not this broadcaster.
   */
  broadcast(type: string, data?: Record<string, unknown>): void;

  /**
   * Workspace root in effect for the host process. Host owns workspace
   * management (see lib/repos, lib/worktrees); plugins just use this.
   */
  readonly workspaceRoot: () => string | null;

  /**
   * Resolve a user-supplied path confined to allowed workspace roots
   * (defaults to `allowedRoots()`). Returns the resolved absolute path, or
   * null if it escapes every allowed root. Plugins MUST use this rather than
   * importing core path internals.
   */
  confinePath(rawPath: string, roots?: string[]): string | null;

  /** All allowed workspace roots: tracked dirs + repos + their worktrees. */
  allowedRoots(): string[];

  /** Current host settings snapshot. */
  settings(): Settings;

  /** Tracked repositories/directories. */
  repos(): Repo[];

  /** Git worktrees for a repo. */
  worktrees(repoPath: string, repoId: string): Worktree[];
}

// ========================================================================
// Notes — flow-walkthrough sketches (non-normative, comments-only)
// ========================================================================

/*
 * Flow: open a new terminal tab via [+] dropdown → "Terminal"
 *
 *   1. User clicks [+], picks "Terminal".
 *   2. Host calls `terminalPlugin.spawn({ workspaceRoot })`.
 *   3. Terminal plugin creates tmux session (via its own lib/tmux code),
 *      spawns ttyd, returns a `TerminalTabInstance` with tabId + layout.
 *   4. Host adds the instance to its `tabs` state, sets activeTabId.
 *   5. Page.tsx iterates plugins.render for each tab. Terminal's render is
 *      `component` mode; host dynamically imports and mounts
 *      `plugins/terminal/components/TerminalTabView.tsx`. That component
 *      receives the TerminalTabInstance (layout, sessions) and renders the
 *      xterm.js splitter + (toggled) TabBrowserView.
 *   6. Terminal tab content shows. User runs a browser-driving command;
 *      child process inherits OMNITERM_BROWSER_REGISTRY_URL=http://.../t/<tabId>/registry
 *      (set via `tmux new-session -e`). Browser registers. Plugin's SSE
 *      (on /t/<tabId>/events) broadcasts to the tab's UI. Pane appears.
 *
 * Flow: right-click .test.yaml → "Open in debugger"
 *
 *   1. File panel shows context menu including debugger plugin's
 *      fileHandlers entry: "Open in debugger" for "*.test.yaml".
 *   2. User clicks. Host calls `debuggerPlugin.spawn({ workspaceRoot, openFile })`.
 *   3. Debugger plugin invokes its wrapped DebuggerManager.openSession,
 *      returns a `DebuggerTabInstance` with tabId + sessionId.
 *   4. Host adds instance to tabs. Page.tsx's render loop picks up
 *      debugger's `iframe` render; mounts <iframe src={urlFor(inst)}>.
 *      URL is `/debugger/<tabId>/?embedded=1&...`.
 *   5. DebuggerSessionsHost (now inside the debugger plugin's component
 *      wrapper) keeps all debugger iframes mounted; CSS visibility toggle
 *      makes only the active one visible.
 *   6. Close tab → host calls instance.close(); plugin terminates
 *      playwright subprocess, unmounts iframe.
 *
 * Flow: switch workspaces
 *
 *   - Host's workspace state changes (a host concern; plugins don't care).
 *   - Host calls each open tab's close(), or keeps them and toggles a
 *     workspace-filter. (Current behavior: tabs persist.)
 *
 * Flow: user closes a tab
 *
 *   1. Host removes tab from state, calls `inst.close()`.
 *   2. Plugin cleans up: tmux kill-session + ttyd stop (terminal), or
 *      DebuggerManager.closeSession (debugger).
 *   3. Plugin can also clean up tab-scoped storage (e.g., terminal's
 *      tab-local browser registry) since nothing will consume it.
 *
 * Flow: MCP-spawned browser from a coding agent
 *
 *   1. User has terminal tab T1. Launches coding agent from T1's shell.
 *   2. Agent reads .mcp.json, spawns a browser-automation MCP process.
 *   3. Agent-driven mcp tool calls launch Chromium. That process reads
 *      OMNITERM_BROWSER_REGISTRY_URL (inherited from T1's env) — which is
 *      http://.../t/<T1-tabId>/registry.
 *   4. Chromium registers via POST to that URL → stored in T1's
 *      tab-local registry.
 *   5. T1's UI already subscribed to /t/<T1-tabId>/events → sees the
 *      browser, shows it in its TabBrowserView.
 *
 * (All of the above work WITHOUT any ownerId field or OMNITERM_OWNER_ID
 * env var — the URL IS the ownership.)
 */
