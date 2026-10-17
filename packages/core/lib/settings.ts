import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { SETTINGS_PATH } from './paths.js';
import { displayNameForPath, repoIdForPath } from './ids.js';
import { isGitRepo } from './gitDir.js';

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

export interface WorkspacePanelState {
  /** null preserves the responsive first-use default: open on desktop, closed on mobile. */
  browserOpen: boolean | null;
  filesOpen: boolean;
}

/** xterm renderer used by ttyd: 'webgl' (GPU, fast) or 'dom' (compatible fallback). */
export type TerminalRenderer = 'webgl' | 'dom';

/** Persisted host settings, as handed to plugins by `HostContext.settings()`. */
export interface Settings {
  /**
   * Every folder the user has opened as a workspace, in panel order: absolute
   * paths spelled as the user gave them (see lib/ids.ts on why a symlink and its
   * target stay two entries), deduped. Git is a capability detected on each
   * entry by lib/workspaces.ts, never a separate list.
   */
  workspaces: string[];
  /**
   * @deprecated Derived from `workspaces` on every load/save (the entries that
   * are git repo roots), so HostContext.repos(), allowedRoots and the terminal
   * plugin keep working. Writing it still works for legacy callers — see
   * saveSettings — but `workspaces` is the source of truth.
   */
  trackedRepos: string[];
  /** @deprecated The non-git counterpart of `trackedRepos`; same derivation. */
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
   * @deprecated The panel no longer filters — live workspaces sort first
   * instead. Still parsed so existing settings files round-trip unchanged.
   */
  workspaceFilterActiveOnly: boolean;
  /**
   * @deprecated The right-hand files panel is gone (files open as tabs and the
   * tree lives in the left sidebar). Still accepted so old settings parse.
   */
  filesPanelMode?: FilesPanelMode;
  /**
   * @deprecated The side-by-side browser view is gone (pages open as tabs).
   * Still accepted so old settings parse.
   */
  browserPanelMode?: BrowserPanelMode;
  /** Placement of Chrome DevTools' inspector relative to its screencast. */
  browserInspectorPosition: BrowserInspectorPosition;
  /**
   * @deprecated Per-workspace browser/file pane visibility, from when those
   * were side panels. No longer read by the UI; kept so old settings parse.
   */
  workspacePanelState?: Record<string, WorkspacePanelState>;
  /**
   * Per-workspace open file tabs. Key is the workspace dir (matches
   * activePath); value lists the open files (relative paths, or `{ path, kind }`
   * to distinguish a source tab from a rendered preview) and the active one.
   * Empty/missing key → no tabs.
   */
  filePanelTabs: Record<
    string,
    { open: Array<{ path: string; kind: 'source' | 'preview' } | string>; active?: string | null }
  >;
  /**
   * Per-workspace tab-strip order: tab ids, left to right, across every tab
   * kind (terminal, browser, file, plugin). Integrations restore their tabs
   * asynchronously; the host slots each reappearing id back into its saved
   * position. Ids of tabs not currently open are kept so a late restore still
   * lands in place; closing a tab drops its id.
   */
  tabOrder: Record<string, string[]>;
  /**
   * Per-workspace side-by-side split of the content area. `secondaryTabId`
   * null = one pane (the ratio is still remembered). `primaryTabId` is the
   * left tab; `focused` is the side showing the active tab. Restored once the
   * tabs exist (they restore asynchronously); dropped if they never appear.
   */
  splitView: Record<
    string,
    {
      secondaryTabId: string | null;
      primaryTabId?: string | null;
      ratio: number;
      focused: 'primary' | 'secondary';
    }
  >;
  /** Selected left-sidebar section: "workspaces" or a plugin panel id. */
  sidebarSection: string;
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
  workspaces: [],
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
  browserInspectorPosition: 'hidden',
  filePanelTabs: {},
  tabOrder: {},
  splitView: {},
  sidebarSection: 'workspaces',
  telemetryEnabled: true,
  terminalRenderer: 'webgl',
};

function onlyStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * onlyStrings, keeping the first of any repeated entry. A tracked path can be
 * appended twice — e.g. a repo whose checkout vanished (container rebuilt)
 * stays tracked but hidden, and cloning it again re-adds the same path — and
 * every duplicate renders as a second identical workspace with the same id.
 */
function uniqueStrings(value: unknown): string[] {
  return [...new Set(onlyStrings(value))];
}

/**
 * Split `workspaces` back into the legacy repo/dir lists. Classified on disk
 * each time rather than stored, so a folder that gains (or loses) a `.git`
 * moves between them without any bookkeeping.
 */
function deriveLegacyTracking(workspaces: string[]): Pick<Settings, 'trackedRepos' | 'trackedDirs'> {
  const trackedRepos: string[] = [];
  const trackedDirs: string[] = [];
  for (const p of workspaces) (isGitRepo(p) ? trackedRepos : trackedDirs).push(p);
  return { trackedRepos, trackedDirs };
}

/**
 * A legacy write (`saveSettings({ trackedRepos })`, or PUT /api/settings from an
 * older client) replaces one of the two derived lists. Translate it into the
 * equivalent `workspaces`: keep surviving entries in their current order, then
 * append anything new. A list the caller left out stays as it is.
 */
function applyLegacyTracking(current: Settings, partial: Partial<Settings>): string[] {
  const repos = partial.trackedRepos ? onlyStrings(partial.trackedRepos) : current.trackedRepos;
  const dirs = partial.trackedDirs ? onlyStrings(partial.trackedDirs) : current.trackedDirs;
  const wanted = new Set([...repos, ...dirs]);
  return uniqueStrings([...current.workspaces.filter((p) => wanted.has(p)), ...repos, ...dirs]);
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
  workspaces: string[],
): Record<string, string> {
  const migrated = { ...namingSchemes };
  const claimedLegacyKeys = new Set<string>();
  let changed = false;

  for (const repoPath of workspaces) {
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
    // Panel visibility used to be global, with separate persisted state for the
    // docked file pane and no persistence at all for overlay/mobile. Preserve
    // the old values for the active workspace, then remove the legacy keys.
    if (
      !parsed.workspacePanelState &&
      typeof parsed.activePath === 'string' &&
      ('browserPanelOpen' in parsed || 'filesPanelDockedOpen' in parsed)
    ) {
      parsed.workspacePanelState = {
        [parsed.activePath]: {
          browserOpen:
            typeof parsed.browserPanelOpen === 'boolean' ? parsed.browserPanelOpen : null,
          filesOpen:
            typeof parsed.filesPanelDockedOpen === 'boolean' ? parsed.filesPanelDockedOpen : false,
        },
      };
    }
    delete parsed.browserPanelOpen;
    delete parsed.filesPanelDockedOpen;
    const settings = { ...DEFAULT_SETTINGS, ...parsed };
    // Every consumer treats these as strings — path.resolve, existsSync, id
    // derivation — and PUT /api/settings writes the request body verbatim, so a
    // malformed entry can reach disk (JSON.stringify alone turns a hole in an
    // array into null). Drop non-strings here: one bad element must not throw,
    // because the catch below would turn that into a silent reset to defaults
    // and the next save would overwrite the user's real repos and tabs.
    //
    // `workspaces` replaced the trackedRepos/trackedDirs split. A file written
    // before it existed migrates repos-first, so the namingSchemes migration
    // below still lets a repo claim its legacy key ahead of a same-named dir.
    settings.workspaces = Array.isArray(parsed.workspaces)
      ? uniqueStrings(parsed.workspaces)
      : uniqueStrings([...onlyStrings(settings.trackedRepos), ...onlyStrings(settings.trackedDirs)]);
    Object.assign(settings, deriveLegacyTracking(settings.workspaces));
    if (settings.namingSchemes && typeof settings.namingSchemes === 'object') {
      settings.namingSchemes = migrateNamingSchemes(settings.namingSchemes, settings.workspaces);
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
    const workspaces = hasWorkspace ? [workspaceDir, home] : [home];
    return {
      ...DEFAULT_SETTINGS,
      workspaces,
      ...deriveLegacyTracking(workspaces),
      activePath,
    };
  }
}

export function saveSettings(partial: Partial<Settings>): Settings {
  const current = loadSettings();
  const updated = { ...current, ...partial };
  if (partial.workspaces) {
    updated.workspaces = uniqueStrings(partial.workspaces);
  } else if (partial.trackedRepos || partial.trackedDirs) {
    updated.workspaces = applyLegacyTracking(current, partial);
  }
  // Persist the derived lists too, so an older omniterm reading this file
  // still sees every workspace.
  Object.assign(updated, deriveLegacyTracking(updated.workspaces));
  // Deep-merge terminalTabs so saving one workspace doesn't erase others
  if (partial.terminalTabs) {
    updated.terminalTabs = { ...current.terminalTabs, ...partial.terminalTabs };
  }
  if (partial.filePanelTabs) {
    updated.filePanelTabs = { ...current.filePanelTabs, ...partial.filePanelTabs };
  }
  if (partial.tabOrder) {
    updated.tabOrder = { ...current.tabOrder, ...partial.tabOrder };
  }
  if (partial.splitView) {
    updated.splitView = { ...current.splitView, ...partial.splitView };
  }
  if (partial.workspacePanelState) {
    updated.workspacePanelState = {
      ...current.workspacePanelState,
      ...partial.workspacePanelState,
    };
  }
  mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}
