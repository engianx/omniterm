/**
 * Which page the browser view activates when the active page goes away.
 *
 * Split out of TabBrowserView so the rules are unit-testable without a DOM:
 * they are pure, and they are the part users notice immediately when wrong.
 *
 * The model is a most-recently-used stack per browser rather than strip
 * position. Position is a poor proxy for intent: after closing a page the
 * user almost always wants to be back where they just were, which is a
 * question about history, not about which chip happens to sit adjacent.
 */

/**
 * Move `activeId` to the front of the MRU stack, dropping any entry that is
 * no longer a live page.
 *
 * Pruning here is what keeps the stack bounded — it is the only writer, and
 * it runs on every selection change, so ids of closed pages cannot pile up.
 * Pages that exist but were never activated are deliberately absent: they
 * have no recency, so they should not outrank a page the user actually used.
 */
export function promoteMru(
  mru: readonly string[],
  activeId: string,
  liveIds: readonly string[],
): string[] {
  const live = new Set(liveIds);
  return [activeId, ...mru.filter((id) => id !== activeId && live.has(id))];
}

/**
 * Pick the page to activate after the active one is closed.
 *
 * Primary rule: the most recently used surviving page. Given A, B, C opened
 * in that order and then visited A, C, the stack is [C, A, B] — so closing C
 * returns to A, where the user last was, rather than to B, which merely
 * happens to sit next to it.
 *
 * Fallback, when the MRU stack has nothing to say (every survivor is a page
 * that was opened but never activated): take over the *slot* the closed page
 * occupied, the way a tabbed browser does. Whatever slid into that index is
 * the closed page's right-hand neighbour; when the closed page was last in
 * the strip the index clamps down to the new last page instead.
 *
 * `mru` is most-recent-first and may still contain the closed id or other
 * stale entries — survivors are filtered against `nextIds`. `prevIds` is the
 * page order as it stood *before* the close (it carries the closed page's
 * index); `nextIds` is the order after. Returns null when nothing is left.
 */
export function pickTargetAfterClose(
  mru: readonly string[],
  prevIds: readonly string[],
  nextIds: readonly string[],
  closedId: string,
): string | null {
  if (nextIds.length === 0) return null;

  const live = new Set(nextIds);
  const mostRecentSurvivor = mru.find((id) => id !== closedId && live.has(id));
  if (mostRecentSurvivor !== undefined) return mostRecentSurvivor;

  const closedIdx = prevIds.indexOf(closedId);
  // Unknown index (the page was never seen in this browser's order) — fall
  // back to the head rather than guessing a neighbour.
  if (closedIdx < 0) return nextIds[0] ?? null;
  return nextIds[Math.min(closedIdx, nextIds.length - 1)] ?? null;
}

/** What the browser view should do in response to a change in its page list. */
export type SelectionOutcome =
  /** Activate this page (null when there is nothing left to activate). */
  | { kind: 'select'; targetId: string | null }
  /** Selection is already correct — fold it into the MRU stack. */
  | { kind: 'record' }
  /** Nothing to do. */
  | { kind: 'idle' };

/**
 * Decide what the active page should be after the page list changes.
 *
 * This is the whole branch cascade the browser view used to run inline. It
 * lives here because the ordering between its cases is subtle and has been
 * wrong twice: the cases are mutually exclusive by position, so an earlier
 * one silently preempting a later one is invisible at the call site and
 * shows up only as a page you did not expect being activated.
 *
 * Callers must not invoke this until the page list is known to describe the
 * currently selected browser AND to have been populated at least once. A
 * browser switch briefly presents an empty list for the new browser; feeding
 * that here makes `pageIds.length > prevIds.length` true on the very next
 * call (N > 0), which fires the "new page appeared" case for what is really
 * just the first load, and jumps to the browser's last page instead of its
 * first.
 */
export function nextSelection(input: {
  /** True on the first call after the selected browser changed. */
  justSwitchedBrowser: boolean;
  /** Page order at the previous call, for this browser. */
  prevIds: readonly string[];
  /** Page order now. */
  pageIds: readonly string[];
  /** Currently active page, if any. */
  selectedTargetId: string | null;
  /** MRU stack for this browser, most-recent-first. */
  mru: readonly string[];
}): SelectionOutcome {
  const { justSwitchedBrowser, prevIds, pageIds, mru } = input;

  // A page id held over from the browser the user just left is not a
  // selection in this browser. Normalise it away rather than letting the
  // "active page went away" case below read it as a page that was closed
  // here — that case consults this browser's recency and would land on
  // whatever the user last viewed, which is neither the documented
  // behaviour nor reachable consistently (it only happens when the browser
  // has a remembered stack). The caller does zero the selection on a switch
  // in a separate effect, but relying on that leaves the rule correct only
  // by arrangement, and effect ordering is what broke this code twice.
  const selectedTargetId =
    justSwitchedBrowser && input.selectedTargetId && !pageIds.includes(input.selectedTargetId)
      ? null
      : input.selectedTargetId;

  // A page was added while the user was watching — show them what just
  // opened, which is what they want after `$BROWSER url`. mergeTargets is
  // append-only, so the newest target is last.
  if (!justSwitchedBrowser && pageIds.length > prevIds.length && pageIds.length > 0) {
    return { kind: 'select', targetId: pageIds[pageIds.length - 1] ?? null };
  }
  // No active page yet — the first load of a browser, including one the user
  // has just switched to. Start at the head of its strip.
  if (!selectedTargetId && pageIds.length > 0) {
    return { kind: 'select', targetId: pageIds[0] ?? null };
  }
  // The active page went away.
  if (selectedTargetId && !pageIds.includes(selectedTargetId)) {
    return {
      kind: 'select',
      targetId: pickTargetAfterClose(mru, prevIds, pageIds, selectedTargetId),
    };
  }
  if (selectedTargetId) return { kind: 'record' };
  return { kind: 'idle' };
}

/** Per-browser bookkeeping the selection rules read. */
interface BrowserSelectionState {
  /** Page order as of the last *evaluated* call for this browser. */
  prevIds: readonly string[];
  /** MRU stack, most-recent-first. */
  mru: readonly string[];
}

export interface SelectionState {
  browsers: Readonly<Record<string, BrowserSelectionState>>;
  /** Browser evaluated on the previous call, across all browsers. */
  lastBrowserId: string | null;
}

export const emptySelectionState: SelectionState = { browsers: {}, lastBrowserId: null };

/**
 * Drop bookkeeping for browsers that are no longer registered, so a future
 * browser reusing an id cannot inherit a stale order. Ids are reused in
 * practice: the registry hands them out from a per-process counter, so a
 * host restart starts again at "1".
 *
 * Callers must run this even when no browser is selected — that is exactly
 * the state a registry goes through when its last browser disappears, and
 * skipping it there is how the entry survives to be inherited.
 */
export function pruneSelectionState(
  state: SelectionState,
  liveBrowserIds: readonly string[],
): SelectionState {
  const live = new Set(liveBrowserIds);
  const browsers: Record<string, BrowserSelectionState> = {};
  for (const [id, entry] of Object.entries(state.browsers)) {
    if (live.has(id)) browsers[id] = entry;
  }
  return { browsers, lastBrowserId: state.lastBrowserId };
}

/**
 * Advance the browser view's page-selection state by one observation.
 *
 * This owns the *sequencing* around `nextSelection`: which observations are
 * trustworthy enough to record, when a call counts as a browser switch, and
 * when per-browser bookkeeping is dropped. Both bugs this code has had lived
 * here rather than in the rules themselves — an untrustworthy observation
 * recorded as fact, which then made a later, honest observation look like
 * something it wasn't. Keeping it pure is what lets a test drive a whole
 * switch sequence instead of a single frame.
 *
 * Two observations are refused outright:
 *   - `targetsBrowserId !== browserId` — the page list still describes the
 *     browser the user left, because the discovery hook resets on its own
 *     schedule. Recording it files one browser's pages under another's id.
 *   - `!targetsLoaded` — no snapshot has arrived for this browser yet, so the
 *     empty page list is an artifact of the reset rather than a real state.
 *     Recording it erases the browser's remembered order, and makes the next
 *     call look like every one of its pages had just been opened.
 */
export function advanceSelection(
  state: SelectionState,
  input: {
    browserId: string;
    pageIds: readonly string[];
    selectedTargetId: string | null;
    /** Which browser `pageIds` actually describes. */
    targetsBrowserId: string | null;
    /** Whether a target snapshot has arrived for that browser. */
    targetsLoaded: boolean;
    /** Browsers still registered; anything else is dropped from state. */
    liveBrowserIds: readonly string[];
  },
): { state: SelectionState; outcome: SelectionOutcome } {
  const { browserId, pageIds, selectedTargetId, targetsBrowserId, targetsLoaded } = input;

  const pruned = pruneSelectionState(state, input.liveBrowserIds);
  const browsers = pruned.browsers;

  if (targetsBrowserId !== browserId || !targetsLoaded) {
    return { state: pruned, outcome: { kind: 'idle' } };
  }

  const entry = browsers[browserId] ?? { prevIds: [], mru: [] };
  const justSwitchedBrowser = state.lastBrowserId !== browserId;
  const outcome = nextSelection({
    justSwitchedBrowser,
    prevIds: entry.prevIds,
    pageIds,
    selectedTargetId,
    mru: entry.mru,
  });

  const mru =
    outcome.kind === 'record' && selectedTargetId
      ? promoteMru(entry.mru, selectedTargetId, pageIds)
      : entry.mru;

  return {
    state: {
      browsers: { ...browsers, [browserId]: { prevIds: [...pageIds], mru } },
      lastBrowserId: browserId,
    },
    outcome,
  };
}
