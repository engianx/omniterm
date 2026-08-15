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
