/**
 * Browser pages as host tabs — the pure half.
 *
 * Every CDP page target of every browser registered under a terminal tab is
 * one top-level host tab. This module owns everything about that mapping that
 * can be decided without a DOM or a socket, so it is unit-testable:
 *
 *   - the reversible tab-id scheme (`browserTabId` / `parseBrowserTabId`),
 *   - which targets are user-facing pages (`isUserPage`),
 *   - what a page's tab is called (`pageTabName`),
 *   - and `reconcileBrowserTabs`, which diffs the live pages against the
 *     host's tab list into open / update / remove actions.
 *
 * One Chrome is normally shared by every terminal: the omniterm-browser shim
 * keeps a single instance per user-data-dir and each terminal that runs it
 * registers that same CDP endpoint in its own registry. So the same page is
 * reported by several owners. Pages are therefore keyed by the browser's CDP
 * URL plus target id (`pageKey`), and each key is given to exactly one owner.
 *
 * Which owner is recorded at the source: whoever opened a page claims it in
 * the registry (the shim for xdg-open / $BROWSER, the client for [+] Browser),
 * and every browser view carries the Chrome-wide claim map (`pageOwners`). A
 * popup inherits its opener's claim. Only pages nobody claimed fall back to
 * the placement heuristic in `reconcileBrowserTabs`.
 *
 * No React/DOM imports: type-only imports are erased at runtime.
 */

import type { Tab } from '../app/types';

export const BROWSER_TAB_TYPE = 'browser';
const ID_PREFIX = 'browser:';

export interface BrowserTabRef {
  /** Terminal tab id whose registry the browser is registered in. */
  ownerTabId: string;
  /** Registry id of the browser within that owner (`/t/<owner>/b/<id>`). */
  browserId: string;
  /** CDP target id of the page. */
  targetId: string;
}

/**
 * `browser:<owner>:<browserId>:<targetId>`, each part URI-component encoded.
 * `encodeURIComponent` escapes `:`, so the three parts split back unambiguously
 * whatever characters a terminal id or target id carries.
 */
export function browserTabId(ref: BrowserTabRef): string {
  return (
    ID_PREFIX +
    [ref.ownerTabId, ref.browserId, ref.targetId].map((p) => encodeURIComponent(p)).join(':')
  );
}

/** Inverse of `browserTabId`; `null` for anything that is not one. */
export function parseBrowserTabId(id: string): BrowserTabRef | null {
  if (!id.startsWith(ID_PREFIX)) return null;
  const parts = id.slice(ID_PREFIX.length).split(':');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  try {
    const [ownerTabId, browserId, targetId] = parts.map((p) => decodeURIComponent(p));
    return { ownerTabId, browserId, targetId };
  } catch {
    return null;
  }
}

/** Identity of a page across owners: one Chrome, many registrations. */
export function pageKey(browserCdpUrl: string, targetId: string): string {
  return `${browserCdpUrl}|${targetId}`;
}

export interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  /** Set for prerender / portal targets, which are not tabs. */
  subtype?: string;
  openerId?: string;
}

/**
 * True for targets that are tabs a user would recognise. Everything else a
 * Chrome reports as `type: 'page'` is browser UI: a DevTools window, the
 * WebUI bubbles of the top chrome (tab search, omnibox popup, read-later),
 * and prerendered pages that have not been shown yet.
 */
export function isUserPage(t: Pick<CdpTargetInfo, 'type' | 'url' | 'subtype'>): boolean {
  if (t.type !== 'page') return false;
  if (t.subtype) return false;
  const url = t.url ?? '';
  if (url.startsWith('devtools://')) return false;
  if (url.startsWith('chrome-untrusted://')) return false;
  if (/^chrome:\/\/[^/]*\.top-chrome(?:\/|$)/.test(url)) return false;
  if (url.startsWith('chrome://omnibox-popup')) return false;
  return true;
}

const BLANK_URLS = new Set(['', 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page/']);

/** Tab label: the page title, else its hostname, else "New tab". */
export function pageTabName(title: string, url: string): string {
  const t = (title ?? '').trim();
  // Chrome reports an untitled page's URL as its title.
  const untitled = !t || t === url;
  if (BLANK_URLS.has(url) && untitled) return 'New tab';
  if (!untitled) return t;
  try {
    const host = new URL(url).hostname;
    if (host) return host;
  } catch {}
  return t || 'New tab';
}

/** The host tab a page is shown as. */
export function pageTab(ref: BrowserTabRef, page: { title: string; url: string }): Tab {
  return {
    type: BROWSER_TAB_TYPE,
    id: browserTabId(ref),
    name: pageTabName(page.title, page.url),
    title: page.url || undefined,
    renamable: false,
  };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface PageState {
  targetId: string;
  title: string;
  url: string;
  /** Appeared while we were watching (xdg-open, window.open, new tab), as
   *  opposed to already existing when we connected. Fresh pages are focused. */
  fresh: boolean;
  /** CDP `openerId`: the page that window.open'd / ctrl-clicked this one. */
  openerId?: string;
  /** Fresh and young enough that its opener's claim may still be in flight
   *  (the page reaches us over CDP before the claim POST reaches the
   *  registry). An unclaimed pending page is held back, not guessed. */
  pendingClaim?: boolean;
}

export interface BrowserState {
  id: string;
  browserCdpUrl: string;
  startedAt: number;
  /** `Target.getTargets` has answered, so `pages` is authoritative. */
  targetsLoaded: boolean;
  pages: PageState[];
  /** Registry claims for this Chrome (`targetId → owner tabId`), every tab's. */
  pageOwners?: Readonly<Record<string, string>>;
}

export interface OwnerState {
  ownerTabId: string;
  /** The registry's browser list has been read, so `browsers` is authoritative. */
  browsersLoaded: boolean;
  browsers: BrowserState[];
}

export interface PageAssignment {
  ownerTabId: string;
  /** Workspace the owner was in when the assignment was made. */
  workspacePath: string | null;
}

export type BrowserTabAction =
  | { kind: 'open'; tab: Tab; activate: boolean; after?: string }
  | { kind: 'update'; id: string; patch: Pick<Tab, 'name' | 'title'> }
  | { kind: 'remove'; id: string };

export interface ReconcileInput {
  /** Watched owners (the workspace's terminal tabs), in strip order. */
  owners: ReadonlyArray<OwnerState>;
  tabs: ReadonlyArray<Tab>;
  activeTabId: string | null;
  activePath: string | null;
  /** Sticky page → owner choices from earlier passes (any workspace). */
  assignments: ReadonlyMap<string, PageAssignment>;
  /** Tab ids already opened once — a re-add never steals focus again. */
  announced: ReadonlySet<string>;
  /** Tab ids the user just closed whose target has not died yet. */
  suppressed: ReadonlySet<string>;
}

export interface DesiredPage {
  tab: Tab;
  ref: BrowserTabRef;
  key: string;
  fresh: boolean;
}

export interface ReconcileResult {
  actions: BrowserTabAction[];
  /** Assignments to keep (input entries plus any new ones). */
  assignments: Map<string, PageAssignment>;
  /** Every page that should be a tab right now, by tab id. */
  desired: Map<string, DesiredPage>;
}

/**
 * The terminal that claimed a page, following `openerId` for popups and
 * ctrl-clicked tabs (which nobody claims themselves). `undefined` when no
 * claim is found anywhere up the chain.
 */
export function resolvePageOwner(
  targetId: string,
  pageOwners: Readonly<Record<string, string>>,
  pages: ReadonlyMap<string, Pick<PageState, 'openerId'>>,
): string | undefined {
  const visited = new Set<string>();
  let id: string | undefined = targetId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const owner = Object.prototype.hasOwnProperty.call(pageOwners, id) ? pageOwners[id] : undefined;
    if (owner) return owner;
    id = pages.get(id)?.openerId;
  }
  return undefined;
}

/**
 * Diff the live pages against the host's tabs.
 *
 * Owner choice for a page reported by several owners: the terminal that
 * claimed it in the registry (directly or through its opener). A claimed page
 * whose claimant is not one of `owners` belongs to another workspace and is
 * never shown here, whatever tab or assignment says otherwise.
 *
 * Unclaimed pages (typed into Chrome, or opened before claims existed) are
 * placed by heuristic, in order: the owner of a tab that already shows it; a
 * sticky earlier assignment; the active tab when it is a candidate terminal;
 * the owner of the active browser tab; the first candidate in strip order. A
 * page assigned that way to an owner in a different workspace is skipped. A
 * fresh unclaimed page still inside its claim grace (`pendingClaim`) waits.
 *
 * Removal is conservative: a browser tab is only dropped when the data that
 * would justify it is authoritative (owner gone, browser list loaded without
 * it, or targets loaded without the page). While sockets are still connecting
 * nothing is removed, so a warm-restored tab is not flickered away and back.
 */
export function reconcileBrowserTabs(input: ReconcileInput): ReconcileResult {
  const { owners, tabs, activeTabId, activePath, announced, suppressed } = input;
  const assignments = new Map(input.assignments);
  const ownersById = new Map(owners.map((o) => [o.ownerTabId, o] as const));
  const ownerOrder = new Map(owners.map((o, i) => [o.ownerTabId, i] as const));

  // key → candidates (owner, browser, page)
  type Candidate = { owner: OwnerState; browser: BrowserState; page: PageState };
  const candidates = new Map<string, Candidate[]>();
  // Per Chrome: the merged claim map and every page (for opener chains). Each
  // registration of a Chrome carries the same global map; merging covers one
  // that is a beat behind on an SSE update.
  const claimsByCdp = new Map<string, Record<string, string>>();
  const pagesByCdp = new Map<string, Map<string, PageState>>();
  for (const owner of owners) {
    for (const browser of owner.browsers) {
      const merged = claimsByCdp.get(browser.browserCdpUrl) ?? {};
      Object.assign(merged, browser.pageOwners ?? {});
      claimsByCdp.set(browser.browserCdpUrl, merged);
      let pagesHere = pagesByCdp.get(browser.browserCdpUrl);
      if (!pagesHere) pagesByCdp.set(browser.browserCdpUrl, (pagesHere = new Map()));
      for (const page of browser.pages) {
        pagesHere.set(page.targetId, page);
        const key = pageKey(browser.browserCdpUrl, page.targetId);
        let list = candidates.get(key);
        if (!list) candidates.set(key, (list = []));
        list.push({ owner, browser, page });
      }
    }
  }

  // Existing browser tabs, resolved to page keys where possible.
  const tabKeyOwner = new Map<string, string>();
  for (const t of tabs) {
    if (t.type !== BROWSER_TAB_TYPE) continue;
    const ref = parseBrowserTabId(t.id);
    if (!ref) continue;
    const browser = ownersById.get(ref.ownerTabId)?.browsers.find((b) => b.id === ref.browserId);
    if (!browser) continue;
    tabKeyOwner.set(pageKey(browser.browserCdpUrl, ref.targetId), ref.ownerTabId);
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeOwner =
    activeTab?.type === 'terminal'
      ? activeTab.id
      : activeTab?.type === BROWSER_TAB_TYPE
        ? (parseBrowserTabId(activeTab.id)?.ownerTabId ?? null)
        : null;

  const desired = new Map<string, DesiredPage>();
  for (const [key, list] of candidates) {
    const has = (ownerId: string | null | undefined) =>
      ownerId ? list.find((c) => c.owner.ownerTabId === ownerId) : undefined;
    const cdpUrl = list[0].browser.browserCdpUrl;
    const claimed = resolvePageOwner(
      list[0].page.targetId,
      claimsByCdp.get(cdpUrl) ?? {},
      pagesByCdp.get(cdpUrl) ?? new Map(),
    );
    let chosen: Candidate | undefined;
    if (claimed !== undefined) {
      chosen = has(claimed);
      // Claimed by a terminal of another workspace: never ours to show.
      if (!chosen) continue;
    } else if (list.some((c) => c.page.pendingClaim) && !tabKeyOwner.has(key)) {
      // Its claim is probably on the way; guessing now could show another
      // workspace's page here for a moment (and focus it).
      continue;
    }
    chosen ??= has(tabKeyOwner.get(key));
    if (!chosen && claimed === undefined) {
      const prior = assignments.get(key);
      if (prior) {
        chosen = has(prior.ownerTabId);
        // Given to a terminal of another workspace: not ours to show. (Same
        // workspace but no longer a candidate means that owner is gone or
        // dropped the browser — reassign.)
        if (!chosen && prior.workspacePath !== activePath) continue;
      }
    }
    chosen ??=
      has(activeOwner) ??
      [...list].sort(
        (a, b) =>
          (ownerOrder.get(a.owner.ownerTabId) ?? 0) - (ownerOrder.get(b.owner.ownerTabId) ?? 0),
      )[0];
    assignments.set(key, { ownerTabId: chosen.owner.ownerTabId, workspacePath: activePath });
    const ref: BrowserTabRef = {
      ownerTabId: chosen.owner.ownerTabId,
      browserId: chosen.browser.id,
      targetId: chosen.page.targetId,
    };
    const tab = pageTab(ref, chosen.page);
    desired.set(tab.id, {
      tab,
      ref,
      key,
      // Any owner seeing it appear live is enough.
      fresh: list.some((c) => c.page.fresh),
    });
  }

  const actions: BrowserTabAction[] = [];
  const byId = new Map(tabs.map((t) => [t.id, t] as const));

  // Removals first, so placement below never anchors on a tab about to go.
  const removed = new Set<string>();
  for (const t of tabs) {
    if (t.type !== BROWSER_TAB_TYPE || desired.has(t.id)) continue;
    const ref = parseBrowserTabId(t.id);
    if (!ref) continue;
    const owner = ownersById.get(ref.ownerTabId);
    let drop: boolean;
    if (!owner) drop = true;
    else if (!owner.browsersLoaded) drop = false;
    else {
      const browser = owner.browsers.find((b) => b.id === ref.browserId);
      drop = !browser || browser.targetsLoaded;
    }
    if (drop) {
      removed.add(t.id);
      actions.push({ kind: 'remove', id: t.id });
    }
  }

  // Working copy of the strip order, so several opens in one pass each land
  // after the previous one rather than all after the same anchor.
  const order = tabs.map((t) => t.id).filter((id) => !removed.has(id));
  const anchorFor = (ownerTabId: string): string | undefined => {
    let anchor: string | undefined = order.includes(ownerTabId) ? ownerTabId : undefined;
    for (const id of order) {
      if (parseBrowserTabId(id)?.ownerTabId === ownerTabId) anchor = id;
    }
    return anchor;
  };

  for (const [id, d] of desired) {
    const existing = byId.get(id);
    if (existing) {
      if (existing.name !== d.tab.name || existing.title !== d.tab.title) {
        actions.push({ kind: 'update', id, patch: { name: d.tab.name, title: d.tab.title } });
      }
      continue;
    }
    if (suppressed.has(id)) continue;
    // Only a page that appeared live is placed next to its terminal. One that
    // already existed (hydration after a reload, a warm workspace switch, a
    // re-add) opens without `after`, so the host restores its saved slot —
    // `after` takes precedence over the saved order, and passing it here
    // reshuffled the strip on every reload.
    const placeLive = d.fresh && !announced.has(id);
    const after = placeLive ? anchorFor(d.ref.ownerTabId) : undefined;
    actions.push({
      kind: 'open',
      tab: d.tab,
      activate: placeLive,
      ...(after !== undefined ? { after } : {}),
    });
    const at = after ? order.indexOf(after) + 1 : order.length;
    order.splice(at, 0, id);
  }

  return { actions, assignments, desired };
}

/**
 * Which terminal a new browser tab belongs to: the active tab when it is a
 * terminal, else the owner of the active browser tab, else the workspace's
 * first terminal. `null` when the workspace has no terminal.
 */
export function pickOwnerForNewPage(
  tabs: ReadonlyArray<Tab>,
  activeTabId: string | null,
): string | null {
  const terminals = tabs.filter((t) => t.type === 'terminal');
  const active = tabs.find((t) => t.id === activeTabId);
  if (active?.type === 'terminal') return active.id;
  if (active?.type === BROWSER_TAB_TYPE) {
    const owner = parseBrowserTabId(active.id)?.ownerTabId;
    if (owner && terminals.some((t) => t.id === owner)) return owner;
  }
  return terminals[0]?.id ?? null;
}
