/**
 * Per-workspace host UI state that survives reloads.
 *
 * This used to hold the browser/files side-panel visibility per workspace.
 * Those panels are gone (pages and files open as tabs), so the legacy
 * `workspacePanelState` setting is no longer read. What remains per workspace
 * is the tab-strip order — pure helpers here, wired up in `useHomeState`.
 *
 * Model: `tabOrder[path]` is a list of tab ids, left to right. It may contain
 * ids of tabs that are not open right now (an integration has not restored
 * them yet); those are kept so a late restore still lands in its old slot.
 * Closing a tab is the only thing that drops its id.
 */

export type TabOrders = Record<string, string[]>;

/** Upper bound on remembered ids per workspace (stale ids of tabs that died
 *  outside a user close would otherwise accumulate forever). */
export const MAX_TAB_ORDER_LENGTH = 200;

/** Validate the persisted `tabOrder` setting. Anything malformed — including
 *  the absence of the key in an old settings file — reads as empty. */
export function parseTabOrders(raw: unknown): TabOrders {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: TabOrders = {};
  for (const [path, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    const clean = ids.filter((id): id is string => typeof id === 'string');
    if (clean.length > 0) out[path] = [...new Set(clean)];
  }
  return out;
}

/**
 * The order to save after the strip changed: every current id in strip order,
 * with saved ids that are not open right now slotted back in right after their
 * saved predecessor (or at the front when they had none). Over the cap, the
 * oldest absent ids go first; open tabs are never dropped.
 */
export function mergeTabOrder(current: ReadonlyArray<string>, saved: ReadonlyArray<string>): string[] {
  const result = [...new Set(current)];
  const present = new Set(result);
  const absent: string[] = [];
  for (let i = 0; i < saved.length; i++) {
    const id = saved[i];
    if (present.has(id)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = result.indexOf(saved[j]);
      if (idx !== -1) {
        at = idx + 1;
        break;
      }
    }
    result.splice(at, 0, id);
    present.add(id);
    absent.push(id);
  }
  let overflow = result.length - MAX_TAB_ORDER_LENGTH;
  if (overflow <= 0) return result;
  const drop = new Set<string>();
  for (const id of absent) {
    if (overflow-- <= 0) break;
    drop.add(id);
  }
  return result.filter((id) => !drop.has(id));
}

/**
 * Slot tabs that just appeared (in `next` but not in `prev`) into their saved
 * positions relative to the tabs around them. Tabs already on the strip keep
 * their relative order, so a user's live arrangement is never shuffled, and
 * tabs with no saved position stay where the caller put them. `pinned` ids
 * (placed explicitly, e.g. `openTab(..., { after })`) are left alone.
 *
 * Returns `next` itself when nothing moved.
 */
export function placeBySavedOrder<T extends { id: string }>(
  prev: ReadonlyArray<T>,
  next: T[],
  saved: ReadonlyArray<string> | undefined,
  pinned?: ReadonlySet<string>,
): T[] {
  if (!saved || saved.length === 0 || next.length < 2) return next;
  const rank = new Map<string, number>();
  saved.forEach((id, i) => rank.set(id, i));
  const prevIds = new Set(prev.map((t) => t.id));
  const arriving = next
    .filter((t) => !prevIds.has(t.id) && rank.has(t.id) && !pinned?.has(t.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  if (arriving.length === 0) return next;

  const arrivingIds = new Set(arriving.map((t) => t.id));
  const list = next.filter((t) => !arrivingIds.has(t.id));
  for (const tab of arriving) {
    const r = rank.get(tab.id)!;
    // After the last ranked tab that belongs before it...
    let at = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const ri = rank.get(list[i].id);
      if (ri !== undefined && ri < r) {
        at = i + 1;
        break;
      }
    }
    // ...else before the first ranked tab that belongs after it...
    if (at === -1) {
      const i = list.findIndex((t) => {
        const ri = rank.get(t.id);
        return ri !== undefined && ri > r;
      });
      if (i !== -1) at = i;
    }
    // ...else where the caller put it, relative to the unranked tabs.
    if (at === -1) {
      const original = next.indexOf(tab);
      at = Math.min(original, list.length);
    }
    list.splice(at, 0, tab);
  }
  return list.every((t, i) => t === next[i]) ? next : list;
}

/** The tab to activate when `removedId` leaves the strip: its right neighbour,
 *  else its left one, else none. */
export function neighbourAfterRemoval<T extends { id: string }>(
  tabs: ReadonlyArray<T>,
  removedId: string,
): string | null {
  const i = tabs.findIndex((t) => t.id === removedId);
  if (i === -1) return null;
  return tabs[i + 1]?.id ?? tabs[i - 1]?.id ?? null;
}
