/**
 * Pure helpers for the terminal plugin's warm-workspace cache.
 *
 * Background: switching workspaces used to tear down every terminal iframe
 * (ttyd WebSocket close + scrollback replay on return). To make switching
 * instant we keep every workspace that has terminals "alive" — its panes stay
 * mounted but hidden (`display: none`), exactly like the per-tab trick already
 * used within a single workspace, lifted up to the workspace level.
 *
 * Everything here is pure (no React, no DOM) so it can be unit-tested in
 * isolation: which data source each live workspace renders from, and how a
 * snapshot is pruned when sessions close. The type-only imports are erased at
 * runtime, so this module never pulls in React/CSS.
 */

import type { Tab } from '../../app/types';

export interface SessionInfo {
  id: string;
  worktreeId: string;
  port: number;
  url: string;
  createdAt: string;
  command?: string;
}

/**
 * Parked terminal state for one workspace. Snapshots of the active workspace's
 * live ("flat") state are written here continuously so that, when the user
 * switches away, the workspace's panes can keep rendering (hidden) from the
 * snapshot without tearing down their ttyd iframes.
 */
export interface WarmSnapshot {
  sessions: Record<string, SessionInfo>;
  /** Terminal tabs only — other plugins' tabs are not warmed here. Each
   *  terminal tab is 1:1 with a tmux session (tab.id === sessionId). */
  tabs: Tab[];
  activeTabId: string | null;
}

/**
 * Drop terminal tabs whose session is no longer live. Each terminal tab is 1:1
 * with a session (tab.id === sessionId), so a tab survives iff its id is in the
 * live set. Shared by the warm-cache snapshot prune and the active flat-state
 * prune so the two never disagree on "which tabs survive when sessions die".
 * Non-terminal tabs are passed through untouched.
 */
export function survivingTerminalTabs(tabs: ReadonlyArray<Tab>, liveIds: Set<string>): Tab[] {
  return tabs.filter((tab) => tab.type !== 'terminal' || liveIds.has(tab.id));
}

/**
 * Remove closed sessions from every parked workspace snapshot. A terminal tab
 * whose session was closed is dropped; a workspace that loses its last terminal
 * is removed entirely (it becomes "inactive"). Returns the same reference when
 * nothing matched, so callers can skip a needless re-render.
 */
export function pruneSessionsFromByPath(
  byPath: Record<string, WarmSnapshot>,
  deadIds: Set<string>,
): Record<string, WarmSnapshot> {
  let changed = false;
  const next: Record<string, WarmSnapshot> = {};
  for (const [path, snap] of Object.entries(byPath)) {
    if (!Object.keys(snap.sessions).some((id) => deadIds.has(id))) {
      next[path] = snap;
      continue;
    }
    changed = true;
    const newSessions = { ...snap.sessions };
    for (const id of deadIds) delete newSessions[id];
    const liveIds = new Set(Object.keys(newSessions));
    const newTabs = survivingTerminalTabs(snap.tabs, liveIds);
    if (newTabs.length === 0) continue; // last terminal gone → drop the workspace
    const activeTabId =
      snap.activeTabId && newTabs.some((t) => t.id === snap.activeTabId)
        ? snap.activeTabId
        : newTabs[0].id;
    next[path] = { sessions: newSessions, tabs: newTabs, activeTabId };
  }
  return changed ? next : byPath;
}

/**
 * For each live workspace, decide which data source backs its render this
 * frame: the live "flat" state (only when it genuinely represents the active
 * workspace) or the workspace's parked snapshot.
 *
 * The `flatPath === activePath` guard is the crux of remount-safety. During a
 * switch there is a transient render where `activePath` has already flipped to
 * the target but the flat state still holds the previous workspace's data
 * (re-hydration happens in an effect). If we naively rendered the active
 * workspace from flat in that window, the target's real iframes (keyed by the
 * snapshot's session ids) would be replaced by stale ids and unmount. By only
 * trusting flat when `flatPath === activePath`, every warm workspace — old and
 * new — renders from a stable snapshot through the transition, so React
 * preserves the iframe elements and no reconnect occurs.
 */
export function buildWarmRenderList<TData>(args: {
  byPath: Readonly<Record<string, TData>>;
  flat: TData;
  /** Path the flat state currently represents (null while unhydrated). */
  flatPath: string | null;
  activePath: string | null;
}): Array<{ path: string; data: TData; visible: boolean; source: 'flat' | 'snapshot' }> {
  const { byPath, flat, flatPath, activePath } = args;
  const usesFlat = (path: string) =>
    path === activePath && activePath !== null && flatPath === activePath;

  const out: Array<{ path: string; data: TData; visible: boolean; source: 'flat' | 'snapshot' }> =
    [];
  const seen = new Set<string>();

  const push = (path: string) => {
    if (seen.has(path)) return;
    const fromFlat = usesFlat(path);
    const data = fromFlat ? flat : byPath[path];
    if (data == null) return;
    seen.add(path);
    out.push({ path, data, visible: path === activePath, source: fromFlat ? 'flat' : 'snapshot' });
  };

  // Render order is the insertion order of `byPath` (stable; path-keyed so
  // order never causes a remount). Object.keys gives that for free, so the
  // render list is fully derived from byPath + activePath — no separate order
  // to keep in sync.
  for (const path of Object.keys(byPath)) push(path);
  // On the active workspace's very first paint its snapshot may not be in
  // `byPath` yet (the continuous-snapshot effect runs after render), so it
  // renders from flat — ensure it's included.
  if (activePath) push(activePath);

  return out;
}
