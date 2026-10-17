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

import { createElement, Fragment, type CSSProperties, type ReactNode } from 'react';

/** A tab in the host's tab list. Plugin-extension fields live elsewhere. */
export interface Tab {
  /** Plugin discriminator. "terminal", "debugger", "agent", etc. */
  type: string;
  /** Stable id, used as the URL key for plugin proxies and as the tab key. */
  id: string;
  /** Display label in the tab bar. Plugins/host may rename. */
  name: string;
  /** Unsaved changes. The tab bar shows a dot in place of the close button. */
  dirty?: boolean;
  /** Hover text (e.g. a file's full path or a page's URL). Defaults to `name`. */
  title?: string;
  /** Image drawn as the tab's icon (e.g. a page favicon). Falls back to the
   *  owning integration's `tabIcon`, then to the host's per-type default. */
  iconUrl?: string;
  /** `false` hides double-click rename (file and browser tabs are named by
   *  what they show). Default: renamable. */
  renamable?: boolean;
}

/** A section of the left sidebar, shown beside the built-in Workspaces list. */
export interface SidebarPanel {
  /** Stable key (also persisted as the selected section). */
  id: string;
  /** Label on the sidebar's section switcher. */
  label: string;
  /** Icon on the sidebar's section switcher. */
  icon: ReactNode;
  /** Count pill on the switcher button (e.g. pending changes); hidden at 0. */
  badge?: number;
  /** Section body. `closeSidebar` lets an overlay/mobile sidebar dismiss
   *  itself after the user picks something (e.g. opens a file). */
  render: (ctx: { isMobile: boolean; closeSidebar: () => void }) => ReactNode;
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
  openTab(tab: Tab, options?: { activate?: boolean; after?: string }): void;
  /** Patch a tab's display fields (name, dirty, title, iconUrl). No-op for an
   *  unknown id. */
  updateTab(id: string, patch: Partial<Omit<Tab, 'id' | 'type'>>): void;
  /** Drop a tab whose backing thing is already gone (a closed page, a deleted
   *  file). Unlike a user close, this does NOT run `beforeCloseTab` or
   *  `onCloseTab`. If it was active, the host activates a neighbour. */
  removeTab(id: string): void;
  /** Bring an existing tab to the front. No-op for an unknown id. */
  activateTab(id: string): void;
}

/** Side of the content area a pane sits on (split view: primary = left). */
export type PaneSide = 'primary' | 'secondary';

/** Render context passed to a plugin's `mainContent` slot. The host calls the
 *  slot once per VISIBLE pane (one, or two in a split), each inside its own
 *  host-positioned box (`position: absolute`, `display: flex`). */
export interface MainContentContext {
  /** The tab this pane shows (the active tab in single-pane mode). Never null
   *  when the slot is invoked. */
  activeTab: Tab;
  /** @deprecated Browser pages are tabs now; the host always passes `false`. */
  browserPanelOpen: boolean;
  /** Which pane this call renders. Absent from older hosts: read as 'primary'. */
  pane?: PaneSide;
  /** This pane holds the strip's active tab. Absent from older hosts: true. */
  focused?: boolean;
  /** A pane/sidebar divider is being dragged: hold off expensive relayouts
   *  (the browser view pauses screencast refits) until it flips back. */
  resizing?: boolean;
}

/** Render state passed to a plugin's `iframeTabsLayer` slot. */
export interface IframeTabsLayerState {
  /** The strip's active tab (= the focused pane's tab). */
  activeTabId: string | null;
  /**
   * Where a tab must render: an absolutely-positioned box within the content
   * area (`position`, `top`, `right`, `bottom`, `left` — spread it onto the
   * pane's root, and do not also set `inset`), or null when the tab is not
   * visible (keep it mounted, `display: none`). Returned objects are stable
   * while the layout is unchanged, so they are safe props for memo'd panes.
   * Absent from older hosts: show only `activeTabId`, filling the area.
   */
  paneStyleFor?: (tabId: string) => CSSProperties | null;
}

/** The box that fills the whole content area (single pane). */
export const FULL_PANE_STYLE: CSSProperties = Object.freeze({
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
}) as CSSProperties;

/** `state.paneStyleFor`, falling back to the single-pane rule for older hosts. */
export function paneStyleResolver(
  state: IframeTabsLayerState,
): (tabId: string) => CSSProperties | null {
  return (
    state.paneStyleFor ?? ((tabId: string) => (tabId === state.activeTabId ? FULL_PANE_STYLE : null))
  );
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
  /** Asked before a user-initiated close of a tab this integration owns.
   *  Resolve `false` to keep the tab (e.g. the user cancelled an unsaved-
   *  changes prompt). Every integration is asked; any `false` vetoes. */
  beforeCloseTab?: (tab: Tab) => boolean | Promise<boolean>;
  /** Icon for a tab this integration owns; `null` for other tabs. */
  tabIcon?: (tab: Tab) => ReactNode | null;
  /** Extra left-sidebar sections (e.g. the file tree). */
  sidebarPanels?: ReadonlyArray<SidebarPanel>;
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
   *  its own live tabs (all stay rendered; CSS toggles visibility). Position
   *  each visible tab with `state.paneStyleFor(tabId)` and set `paneAware`.
   *  Elements must manage their own `pointer-events` (a layer's root should be
   *  `none` wherever it shows nothing, its visible panes `auto`). */
  iframeTabsLayer?: (state: IframeTabsLayerState) => ReactNode;
  /** This integration's `iframeTabsLayer` positions its panes with
   *  `paneStyleFor`. Without it (a legacy layer that only reads
   *  `activeTabId` and fills the area), `composeIntegrations` confines the
   *  layer to the focused pane's box with `pointer-events: none`, so it can
   *  only show the focused tab, and its interactive elements must set
   *  `pointer-events: auto` themselves. */
  paneAware?: boolean;
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
  const sidebarPanels = integrations.flatMap((i) => i.sidebarPanels ?? []);
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
    beforeCloseTab: async (tab: Tab): Promise<boolean> => {
      for (const i of integrations) {
        if (i.beforeCloseTab && (await i.beforeCloseTab(tab)) === false) return false;
      }
      return true;
    },
    tabIcon: (tab: Tab): ReactNode | null => {
      for (const i of integrations) {
        const icon = i.tabIcon?.(tab);
        if (icon) return icon;
      }
      return null;
    },
    sidebarPanels,
    mainContent: (ctx: MainContentContext): ReactNode => {
      for (const i of integrations) {
        const r = i.mainContent?.(ctx);
        if (r) return r;
      }
      return null;
    },
    iframeTabsLayer: (state: IframeTabsLayerState): ReactNode => {
      const layers: ReactNode[] = [];
      integrations.forEach((i, index) => {
        const node = i.iframeTabsLayer?.(state);
        if (node == null || node === false) return;
        if (i.paneAware) {
          // Keyed by integration (not layer) index: a layer that renders
          // nothing this time must not shift the others' identity.
          layers.push(createElement(Fragment, { key: `layer-${index}` }, node));
          return;
        }
        // Legacy layer: it fills its container with the active tab, so give it
        // the focused pane's box as that container.
        const box = (state.activeTabId && state.paneStyleFor?.(state.activeTabId)) || FULL_PANE_STYLE;
        layers.push(
          createElement('div', { key: `legacy-layer-${index}`, style: { ...box, pointerEvents: 'none' } }, node),
        );
      });
      return layers.length === 0 ? null : layers;
    },
  };
}
