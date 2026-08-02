/**
 * Host-level types for the omniterm app shell.
 *
 * These intentionally describe ONLY what the host needs to manage the
 * generic tab list and dispatch to plugins. Plugin-specific shapes
 * (terminal layout tree, debugger session id, agent process port, ...)
 * stay inside each plugin's own module. The host stores tabs as the
 * minimal `{ type, id, name }` triple; plugins keep per-tab extras in
 * their own `Map<tabId, ...>` if they need them.
 */

import type { ReactNode } from 'react';

/** A tab in the host's tab list. Plugin-extension fields live elsewhere. */
export interface Tab {
  /** Plugin discriminator. "terminal", "debugger", "agent", etc. */
  type: string;
  /** Stable id, used as the URL key for plugin proxies and as the tab key. */
  id: string;
  /** Display label in the tab bar. Plugins/host may rename. */
  name: string;
}

/**
 * Imperative API the host hands to plugin callbacks (file handlers,
 * tab-type create handlers). Plugins use it to surface their tabs in
 * the host's UI after spawning backend state.
 */
export interface HostApi {
  /**
   * Append a tab to the host's list. Idempotent on id.
   * Activates the new tab unless `options.activate === false` (used by the
   * host to spawn background landing tabs without stealing focus).
   */
  openTab(tab: Tab, options?: { activate?: boolean }): void;
}

/** Render context passed to a plugin's `mainContent` slot. */
export interface MainContentContext {
  /** Currently active tab; never null when the slot is invoked. */
  activeTab: Tab;
  /** Whether the host's "show browsers" top-bar toggle is on. Plugins
   *  that render a side-pane browser view (terminal, agent-standalone)
   *  use this to decide whether to render it inline. */
  browserPanelOpen: boolean;
}

/**
 * A bundle of host-extension points contributed by ONE plugin's React
 * integration. Multiple integrations are merged via `composeIntegrations`
 * before being passed into `<Home />`.
 */
export interface PluginIntegration {
  /**
   * Entry for the `[+]` dropdown. The host puts every integration's
   * choice in the order they appear in the integrations array; the first
   * is what `[+]` clicks resolve to in single-plugin installs.
   *
   * `autoOpenOnLanding`: opt-in for the host's workspace-landing
   * auto-spawn. `tabTypeChoices[0]` always auto-spawns (focused);
   * additional choices with `autoOpenOnLanding === true` also auto-spawn
   * in declaration order, but silently (appended without stealing focus).
   */
  tabTypeChoice?: {
    type: string;
    label: string;
    onCreate: (api: HostApi) => void | Promise<void>;
    autoOpenOnLanding?: boolean;
  };
  /** Like `tabTypeChoice` but for one integration that contributes MANY tab
   *  types at once (the manifest-driven plugin consumer). Merged after each
   *  integration's singular `tabTypeChoice`. */
  tabTypeChoices?: ReadonlyArray<{
    type: string;
    label: string;
    onCreate: (api: HostApi) => void | Promise<void>;
    autoOpenOnLanding?: boolean;
  }>;
  /** Called by the host when a tab whose `type` belongs to this plugin
   *  is closed. Plugins should ignore tabs of other types. */
  onCloseTab?: (tab: Tab) => void;
  /** Tab types whose state is process-bound and should NOT be restored
   *  from saved settings on page reload. */
  ephemeralTabTypes?: ReadonlySet<string>;
  /** File-context-menu entries for the file panel. */
  fileHandlers?: ReadonlyArray<{
    pattern: string;
    label: string;
    onSelect: (absPath: string, api: HostApi) => void | Promise<void>;
  }>;
  /** Files currently "live" in this plugin's tabs (renders an indicator
   *  next to the file name in the file panel). */
  fileIndicatorPaths?: ReadonlySet<string>;
  /** Render slot for the active tab's component-mode content. Returns
   *  `null` for tabs this integration doesn't own. */
  mainContent?: (ctx: MainContentContext) => ReactNode;
  /** Render slot for the host's iframe overlay. Each integration mounts
   *  its own live tabs (all stay rendered; CSS toggles visibility). */
  iframeTabsLayer?: (state: { activeTabId: string | null }) => ReactNode;
  /** Workspace paths with pending alerts (drives the workspace-icon
   *  badge). Driven by plugin SSE / polling. */
  alertedPaths?: ReadonlySet<string>;
  /** Tab ids with pending alerts (drives the per-tab alert dot). */
  alertedTabIds?: ReadonlySet<string>;
  /** True when restoration for the current `activePath` is done. Absence = always ready. */
  workspaceReady?: boolean;
  /** Plugin-side workspace refresh. Composed into the host's
   *  `refreshWorkspaces`, so it fires both on the panel ⟳ button and on
   *  every internal repo/worktree mutation. Use this for workspace-scoped
   *  data the host doesn't own (orphan tmux sessions, agent status, ...). */
  onWorkspaceRefresh?: () => void | Promise<void>;
}

/**
 * Merge several plugin integrations into a single object that fits
 * `<Home />`'s prop surface. Integrations are tried in order for slots
 * with first-match semantics (`mainContent`).
 */
export function composeIntegrations(...integrations: ReadonlyArray<PluginIntegration>) {
  const tabTypeChoices = integrations.flatMap((i) => [
    ...(i.tabTypeChoice ? [i.tabTypeChoice] : []),
    ...(i.tabTypeChoices ?? []),
  ]);
  const fileHandlers = integrations.flatMap((i) => i.fileHandlers ?? []);
  const ephemeralTabTypes = new Set<string>();
  for (const i of integrations) for (const t of i.ephemeralTabTypes ?? []) ephemeralTabTypes.add(t);
  const fileIndicatorPaths = new Set<string>();
  for (const i of integrations)
    for (const p of i.fileIndicatorPaths ?? []) fileIndicatorPaths.add(p);
  const alertedPaths = new Set<string>();
  for (const i of integrations) for (const p of i.alertedPaths ?? []) alertedPaths.add(p);
  const alertedTabIds = new Set<string>();
  for (const i of integrations) for (const id of i.alertedTabIds ?? []) alertedTabIds.add(id);
  // `!== false` so `undefined` (didn't gate) and `true` both pass; only `false` blocks.
  const workspaceReady = integrations.every((i) => i.workspaceReady !== false);
  const refreshHandlers = integrations.flatMap((i) =>
    i.onWorkspaceRefresh ? [i.onWorkspaceRefresh] : [],
  );

  return {
    tabTypeChoices,
    fileHandlers: fileHandlers.length > 0 ? fileHandlers : undefined,
    ephemeralTabTypes: ephemeralTabTypes.size > 0 ? ephemeralTabTypes : undefined,
    fileIndicatorPaths,
    alertedPaths,
    alertedTabIds,
    workspaceReady,
    onWorkspaceRefresh: async () => {
      // Fan out in parallel; one slow plugin shouldn't gate the others.
      // Errors are surfaced via console so a single broken plugin doesn't
      // void the host's repo/worktree refresh.
      await Promise.all(
        refreshHandlers.map(async (h) => {
          try {
            await h();
          } catch (err) {
            console.warn(
              '[home] plugin workspace refresh failed:',
              err instanceof Error ? err.message : String(err),
            );
          }
        }),
      );
    },
    onCloseTab: (tab: Tab) => {
      for (const i of integrations) i.onCloseTab?.(tab);
    },
    mainContent: (ctx: MainContentContext): ReactNode => {
      for (const i of integrations) {
        const r = i.mainContent?.(ctx);
        if (r) return r;
      }
      return null;
    },
    iframeTabsLayer: (state: { activeTabId: string | null }): ReactNode => {
      const layers = integrations
        .map((i) => i.iframeTabsLayer?.(state))
        .filter((n): n is ReactNode => n != null && n !== false);
      return layers.length === 0 ? null : layers;
    },
  };
}
