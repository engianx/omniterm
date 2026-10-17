/**
 * Side-by-side split view: pure state transitions.
 *
 * The content area shows one pane, or two (primary = left, secondary =
 * right). Exactly one pane is focused, and the focused pane always shows the
 * host's `activeTabId` — so the strip's active tab and the focused pane can
 * never disagree. The split state therefore only stores the OTHER visible
 * tab (`otherTabId`), which side has focus, and the divider ratio.
 *
 * Every transition takes the current `(split, activeTabId, tabIds)` and
 * returns the next `{ split, activeTabId }`; the host applies both together.
 */

export type PaneSide = 'primary' | 'secondary';

export interface SplitState {
  /** Tab shown in the pane that does NOT have focus; null = single pane. */
  otherTabId: string | null;
  /** Which side the focused pane (showing `activeTabId`) is on. */
  focused: PaneSide;
  /** Primary pane's share of the content width, clamped to [MIN, 1 - MIN]. */
  ratio: number;
}

/** What each side shows. `secondary === null` means a single pane. */
export interface Panes {
  primary: string | null;
  secondary: string | null;
  focused: PaneSide;
}

export interface SplitResult {
  split: SplitState;
  activeTabId: string | null;
}

/** Persisted per workspace in `settings.splitView[path]`. */
export interface PersistedSplit {
  secondaryTabId: string | null;
  /** The left tab, so a restore does not depend on which tab is active. */
  primaryTabId?: string | null;
  ratio: number;
  focused: PaneSide;
}

export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_PANE_RATIO = 0.2;
/** Below this content width the split collapses to the focused pane. */
export const MIN_SPLIT_CONTENT_WIDTH = 640;

export const otherSide = (side: PaneSide): PaneSide =>
  side === 'primary' ? 'secondary' : 'primary';

export function clampRatio(ratio: unknown): number {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(1 - MIN_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
}

export function singlePane(ratio: number = DEFAULT_SPLIT_RATIO): SplitState {
  return { otherTabId: null, focused: 'primary', ratio: clampRatio(ratio) };
}

/** Collapse to one pane, keeping the ratio (and the identity when already single). */
function collapse(split: SplitState): SplitState {
  return split.otherTabId === null && split.focused === 'primary' ? split : singlePane(split.ratio);
}

/**
 * What the panes show. A split whose other tab is gone (or equals the active
 * one) reads as a single pane, so a stale state can never show a blank side.
 */
export function resolvePanes(
  split: SplitState,
  activeTabId: string | null,
  tabIds: ReadonlyArray<string>,
): Panes {
  const other = split.otherTabId;
  if (
    !activeTabId ||
    !other ||
    other === activeTabId ||
    !tabIds.includes(other) ||
    !tabIds.includes(activeTabId)
  ) {
    return { primary: activeTabId, secondary: null, focused: 'primary' };
  }
  return split.focused === 'primary'
    ? { primary: activeTabId, secondary: other, focused: 'primary' }
    : { primary: other, secondary: activeTabId, focused: 'secondary' };
}

/** Inverse of `resolvePanes`. */
export function fromPanes(panes: Panes, ratio: number): SplitResult {
  const { primary, secondary } = panes;
  if (!primary || !secondary || primary === secondary) {
    return { split: singlePane(ratio), activeTabId: primary ?? secondary };
  }
  const focused = panes.focused;
  return {
    split: {
      otherTabId: focused === 'primary' ? secondary : primary,
      focused,
      ratio: clampRatio(ratio),
    },
    activeTabId: focused === 'primary' ? primary : secondary,
  };
}

/** The side a tab is visible on, or null. */
export function sideOf(panes: Panes, tabId: string): PaneSide | null {
  if (panes.primary === tabId) return 'primary';
  if (panes.secondary === tabId) return 'secondary';
  return null;
}

/**
 * Strip click: show the tab in the focused pane. A tab already visible in the
 * other pane is not moved — that pane just takes focus.
 */
export function selectTab(
  split: SplitState,
  activeTabId: string | null,
  tabIds: ReadonlyArray<string>,
  tabId: string,
): SplitResult {
  const panes = resolvePanes(split, activeTabId, tabIds);
  if (!panes.secondary) return { split: collapse(split), activeTabId: tabId };
  const side = sideOf(panes, tabId);
  if (side) return fromPanes({ ...panes, focused: side }, split.ratio);
  return fromPanes({ ...panes, [panes.focused]: tabId }, split.ratio);
}

/** Focus a side (pointerdown / iframe focus inside that pane). */
export function focusPane(
  split: SplitState,
  activeTabId: string | null,
  tabIds: ReadonlyArray<string>,
  side: PaneSide,
): SplitResult {
  const panes = resolvePanes(split, activeTabId, tabIds);
  if (!panes.secondary || panes.focused === side) return { split, activeTabId };
  return fromPanes({ ...panes, focused: side }, split.ratio);
}

/** Left neighbour of `tabId` in strip order, else the right one. */
function neighbourOf(tabIds: ReadonlyArray<string>, tabId: string): string | null {
  const i = tabIds.indexOf(tabId);
  if (i === -1) return null;
  return tabIds[i - 1] ?? tabIds[i + 1] ?? null;
}

/**
 * Show `tabId` on `side` (default: the unfocused side, or the right when not
 * split) and focus it.
 *
 * - Not split: the current active tab stays on the opposite side. Opening the
 *   active tab itself to the side puts its strip neighbour opposite it (a tab
 *   is shown in one pane only); with no other tab, nothing happens.
 * - Split, tab visible on the opposite side: the two panes swap.
 * - Split, tab not visible: it replaces whatever `side` showed.
 */
export function openToSide(
  split: SplitState,
  activeTabId: string | null,
  tabIds: ReadonlyArray<string>,
  tabId: string,
  side?: PaneSide,
): SplitResult {
  if (!tabIds.includes(tabId)) return { split, activeTabId };
  const panes = resolvePanes(split, activeTabId, tabIds);
  if (!panes.secondary) {
    const target = side ?? 'secondary';
    const base = tabId === activeTabId || !activeTabId ? neighbourOf(tabIds, tabId) : activeTabId;
    if (!base) return { split: collapse(split), activeTabId: tabId };
    return fromPanes(
      target === 'secondary'
        ? { primary: base, secondary: tabId, focused: 'secondary' }
        : { primary: tabId, secondary: base, focused: 'primary' },
      split.ratio,
    );
  }
  const target = side ?? otherSide(panes.focused);
  const current = sideOf(panes, tabId);
  if (current === target) return fromPanes({ ...panes, focused: target }, split.ratio);
  if (current) {
    return fromPanes(
      { primary: panes.secondary, secondary: panes.primary, focused: target },
      split.ratio,
    );
  }
  return fromPanes({ ...panes, [target]: tabId, focused: target }, split.ratio);
}

/** Context menu "Move to other side": a visible tab swaps sides (keeping
 *  focus on it); anything else opens to the side. */
export function moveToOtherSide(
  split: SplitState,
  activeTabId: string | null,
  tabIds: ReadonlyArray<string>,
  tabId: string,
): SplitResult {
  const panes = resolvePanes(split, activeTabId, tabIds);
  const side = panes.secondary ? sideOf(panes, tabId) : null;
  return openToSide(split, activeTabId, tabIds, tabId, side ? otherSide(side) : undefined);
}

/** Back to one pane showing the focused tab. */
export function closeSplit(split: SplitState, activeTabId: string | null): SplitResult {
  return { split: collapse(split), activeTabId };
}

/**
 * The tab to activate after `removedId` leaves the strip. Closing the focused
 * tab of a split focuses the other pane's tab; otherwise the host's usual
 * neighbour. (The split itself collapses via `followActive` once the tab is
 * gone.)
 */
export function activeAfterRemoval(
  split: SplitState,
  activeTabId: string | null,
  tabIds: ReadonlyArray<string>,
  removedId: string,
  neighbour: string | null,
): string | null {
  if (activeTabId !== removedId) return activeTabId;
  const panes = resolvePanes(split, activeTabId, tabIds);
  if (panes.secondary) return panes.focused === 'primary' ? panes.secondary : panes.primary;
  return neighbour;
}

/**
 * Keep the split consistent after `activeTabId` changed outside a split
 * transition (an integration's `activateTab`, a removal, a restore):
 * - the newly active tab is the other pane's → the panes keep their tabs and
 *   focus moves there;
 * - the other pane's tab is gone (or a tab moved in on top of it) → collapse.
 */
export function followActive(
  split: SplitState,
  prevActive: string | null,
  nextActive: string | null,
  tabIds: ReadonlyArray<string>,
): SplitState {
  const other = split.otherTabId;
  if (!other) return split;
  if (!tabIds.includes(other) || !nextActive) return collapse(split);
  if (nextActive !== other) return split;
  if (prevActive && prevActive !== nextActive && tabIds.includes(prevActive)) {
    return { ...split, otherTabId: prevActive, focused: otherSide(split.focused) };
  }
  return collapse(split);
}

// ----- persistence -----

export function toPersisted(
  split: SplitState,
  activeTabId: string | null,
  tabIds: ReadonlyArray<string>,
): PersistedSplit {
  const panes = resolvePanes(split, activeTabId, tabIds);
  if (!panes.secondary) {
    return { secondaryTabId: null, primaryTabId: null, ratio: split.ratio, focused: 'primary' };
  }
  return {
    secondaryTabId: panes.secondary,
    primaryTabId: panes.primary,
    ratio: split.ratio,
    focused: panes.focused,
  };
}

/** Validate the persisted `splitView` setting; anything malformed is dropped. */
export function parseSplitViews(raw: unknown): Record<string, PersistedSplit> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PersistedSplit> = {};
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    out[path] = {
      secondaryTabId: typeof e.secondaryTabId === 'string' && e.secondaryTabId ? e.secondaryTabId : null,
      primaryTabId: typeof e.primaryTabId === 'string' && e.primaryTabId ? e.primaryTabId : null,
      ratio: clampRatio(e.ratio),
      focused: e.focused === 'secondary' ? 'secondary' : 'primary',
    };
  }
  return out;
}

/**
 * Re-apply a saved split once its tabs exist (they restore asynchronously).
 * `'wait'` = not yet; the caller gives up after a while (the tab may never
 * come back). The saved primary falls back to the active tab.
 */
export function restoreSplit(
  saved: PersistedSplit,
  activeTabId: string | null,
  tabIds: ReadonlyArray<string>,
): SplitResult | 'wait' {
  const secondary = saved.secondaryTabId;
  if (!secondary) return { split: singlePane(saved.ratio), activeTabId };
  if (!tabIds.includes(secondary)) return 'wait';
  let primary = saved.primaryTabId ?? null;
  if (!primary || !tabIds.includes(primary)) {
    // The saved left tab may restore later; meanwhile settle for the active
    // tab only when there is no saved one to wait for.
    if (primary && !tabIds.includes(primary)) return 'wait';
    primary = activeTabId && activeTabId !== secondary ? activeTabId : null;
  }
  if (!primary || primary === secondary) return 'wait';
  return fromPanes({ primary, secondary, focused: saved.focused }, saved.ratio);
}
