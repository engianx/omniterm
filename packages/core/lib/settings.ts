import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { SETTINGS_PATH } from './paths.js';
import { displayNameForPath, repoIdForPath } from './ids.js';

// The persisted settings file, owned here. These types used to live in
// @omniterm/plugin-types because HostContext.settings() handed the whole file
// to plugins; that method is gone, so host UI state is no longer part of the
// published plugin contract and adding a preference no longer requires a
// plugin-types release.

/** Display mode shared by side panels with docked/overlay support. */
export type PanelDisplayMode = 'overlay' | 'docked';
export type WorkspacesPanelMode = PanelDisplayMode;
export type FilesPanelMode = PanelDisplayMode;
export type BrowserPanelMode = PanelDisplayMode;
export type BrowserInspectorPosition = 'hidden' | 'right' | 'bottom';

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
   * Whether the workspaces panel is filtered to workspaces that have a live
   * tmux session. Applies to both display modes.
   */
  workspaceFilterActiveOnly: boolean;
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
   * Display mode for the browser view on wide viewports. "docked" places it
   * beside the terminal; "overlay" floats it above the terminal without
   * consuming terminal width. Narrow viewports always use their existing
   * full-screen overlay presentation.
   */
  browserPanelMode: BrowserPanelMode;
  /** Placement of Chrome DevTools' inspector relative to its screencast. */
  browserInspectorPosition: BrowserInspectorPosition;
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

const DEFAULT_SETTINGS: Settings = {
  trackedRepos: [],
  trackedDirs: [],
  lastActiveWorktree: null,
  sidebarCollapsed: false,
  namingSchemes: {},
  terminalFontSize: 14,
  defaultShell: 'bash',
  terminalTabs: {},
  activeSessionId: null,
  activePath: null,
  workspacesPanelMode: 'docked',
  workspacesPanelDockedOpen: true,
  workspaceFilterActiveOnly: false,
  filesPanelMode: 'docked',
  filesPanelDockedOpen: false,
  browserPanelMode: 'docked',
  browserInspectorPosition: 'hidden',
  browserPanelOpen: null,
  filePanelTabs: {},
  telemetryEnabled: true,
  terminalRenderer: 'webgl',
};

function onlyStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Rekey `namingSchemes` from the legacy basename ids to the path-derived repo
 * ids introduced in lib/ids.ts. Without this every repo looks unassigned after
 * the upgrade and gets a fresh scheme, while the stale basename keys keep
 * occupying scheme names in assignScheme's "already used" set.
 *
 * Repos that share a basename all point at one legacy key, so only the first
 * tracked one inherits that scheme — the others fall through to a fresh
 * assignment rather than sharing a worktree-name pool. Keys for repos that are
 * no longer tracked are left alone: an untracked repo may be re-added, and
 * dropping its scheme would silently renumber its future worktree names.
 */
export function migrateNamingSchemes(
  namingSchemes: Record<string, string>,
  trackedRepos: string[],
): Record<string, string> {
  const migrated = { ...namingSchemes };
  const claimedLegacyKeys = new Set<string>();
  let changed = false;

  for (const repoPath of trackedRepos) {
    const id = repoIdForPath(repoPath);
    if (migrated[id] !== undefined) continue;
    const legacyKey = displayNameForPath(repoPath);
    if (claimedLegacyKeys.has(legacyKey)) continue;
    const scheme = namingSchemes[legacyKey];
    if (scheme === undefined) continue;
    claimedLegacyKeys.add(legacyKey);
    migrated[id] = scheme;
    delete migrated[legacyKey];
    changed = true;
  }

  // Same reference when nothing moved, so callers can cheaply detect a no-op.
  return changed ? migrated : namingSchemes;
}

export function loadSettings(): Settings {
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Migrate the legacy `tabLayouts` key to `terminalTabs` (split-pane removal).
    // Entries keep only id/name; the obsolete `layout` field is left behind.
    if (parsed.tabLayouts && !parsed.terminalTabs) parsed.terminalTabs = parsed.tabLayouts;
    delete parsed.tabLayouts;
    // Drop the dead `browserPanel` key (removed Browser Panel discovery feature)
    // so a previously-configured discoveryUrl doesn't linger as orphaned data.
    delete parsed.browserPanel;
    const settings = { ...DEFAULT_SETTINGS, ...parsed };
    // Every consumer treats these as strings — path.resolve, existsSync, id
    // derivation — and PUT /api/settings writes the request body verbatim, so a
    // malformed entry can reach disk (JSON.stringify alone turns a hole in an
    // array into null). Drop non-strings here: one bad element must not throw,
    // because the catch below would turn that into a silent reset to defaults
    // and the next save would overwrite the user's real repos and tabs.
    settings.trackedRepos = onlyStrings(settings.trackedRepos);
    settings.trackedDirs = onlyStrings(settings.trackedDirs);
    if (settings.namingSchemes && typeof settings.namingSchemes === 'object') {
      settings.namingSchemes = migrateNamingSchemes(settings.namingSchemes, settings.trackedRepos);
    }
    return settings;
  } catch (e) {
    // Distinguish "no settings yet" from "settings exist but could not be read".
    // The fallback below is a first-run default, and returning it for a file
    // that does exist means the next save silently overwrites it — so at least
    // say so loudly rather than losing the user's data without a trace.
    if (existsSync(SETTINGS_PATH)) {
      console.error(
        `[settings] ${SETTINGS_PATH} exists but could not be loaded; falling back to defaults. ` +
          `The next save will overwrite it. Cause: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // First-ever load — no settings file. Testbox default: prefer /workspace
    // (the bind-mounted project dir) when it exists; fall back to $HOME so
    // the UI is immediately usable even without a workspace mount.
    const home = homedir();
    const workspaceDir = '/workspace';
    const hasWorkspace = existsSync(workspaceDir) && statSync(workspaceDir).isDirectory();
    const activePath = hasWorkspace ? workspaceDir : home;
    const trackedDirs = hasWorkspace ? [workspaceDir, home] : [home];
    return {
      ...DEFAULT_SETTINGS,
      trackedDirs,
      activePath,
    };
  }
}

export function saveSettings(partial: Partial<Settings>): Settings {
  const current = loadSettings();
  const updated = { ...current, ...partial };
  // Deep-merge terminalTabs so saving one workspace doesn't erase others
  if (partial.terminalTabs) {
    updated.terminalTabs = { ...current.terminalTabs, ...partial.terminalTabs };
  }
  if (partial.filePanelTabs) {
    updated.filePanelTabs = { ...current.filePanelTabs, ...partial.filePanelTabs };
  }
  mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}
