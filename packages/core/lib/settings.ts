import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { SETTINGS_PATH } from './paths.js';
import { displayNameForPath, repoIdForPath } from './ids.js';

// These shapes cross the plugin boundary (HostContext.settings()), so they are
// declared in @omniterm/plugin-types and re-exported here. This module still
// owns the behavior — loading, migrating, and persisting settings.
import type {
  PanelDisplayMode,
  WorkspacesPanelMode,
  FilesPanelMode,
  TerminalRenderer,
  Settings,
} from '@omniterm/plugin-types';

export type {
  PanelDisplayMode,
  WorkspacesPanelMode,
  FilesPanelMode,
  TerminalRenderer,
  Settings,
};

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
  filesPanelMode: 'docked',
  filesPanelDockedOpen: false,
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
