/**
 * Live browser/page discovery for a set of terminal tabs ("owners").
 *
 * Per owner: the registry snapshot (`GET /t/<owner>/browsers`) then its SSE
 * stream (`/t/<owner>/events`) for browsers coming and going. Per registered
 * browser: one CDP WebSocket through the OmniTerm proxy
 * (`/t/<owner>/b/<id>/browser`) with target discovery on, which is the only
 * source of page targets and also the channel for `Target.*` commands
 * (activate / close / create).
 *
 * Framework-free so the React hook stays thin: `subscribe` + `getSnapshot`
 * fit `useSyncExternalStore`. The snapshot is the `OwnerState[]` shape the
 * pure reconcile in browserTabs.ts consumes.
 *
 * Freshness: a page is `fresh` (and so gets focused) when it appears while we
 * are watching — a `targetCreated` after the browser's target snapshot, or a
 * never-seen page in the first snapshot of a browser that registered while we
 * were watching (the shim opens the page *before* it registers, so an
 * xdg-open into a cold or newly-registered Chrome looks exactly like that).
 * Pages that already existed when we connected are not fresh.
 *
 * Ownership: each browser's registry view carries `pageOwners`, the claims of
 * whichever terminal opened each page; `claims` SSE events keep it current. A
 * fresh page is `pendingClaim` for `CLAIM_GRACE_MS`, because its target
 * reaches us over CDP before the opener's claim POST reaches the registry.
 */

import type { Browser } from './browserTypes';
import {
  isUserPage,
  pageKey,
  type BrowserState,
  type CdpTargetInfo,
  type OwnerState,
} from './browserTabs';

interface TargetEntry {
  info: CdpTargetInfo;
  fresh: boolean;
  /** Until when an unclaimed fresh page waits for its claim (epoch ms). */
  claimDeadline: number;
}

interface BrowserConn {
  info: Browser;
  /** Registered after the owner's initial snapshot. */
  live: boolean;
  ws: WebSocket | null;
  connected: boolean;
  /** Has ever finished loading (a later load is a reconnect). */
  everLoaded: boolean;
  targetsLoaded: boolean;
  targets: Map<string, TargetEntry>;
  error: string | null;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retries: number;
}

interface OwnerConn {
  ownerTabId: string;
  baseUrl: string;
  es: EventSource | null;
  browsersLoaded: boolean;
  browsers: Map<string, BrowserConn>;
  disposed: boolean;
  esOpenedOnce: boolean;
}

export interface BrowserConnStatus {
  connected: boolean;
  error: string | null;
}

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 5;
/** How long a fresh, unclaimed page waits for its opener's claim before the
 *  reconcile falls back to placing it by heuristic. */
export const CLAIM_GRACE_MS = 1500;

export class BrowserPagesStore {
  private owners = new Map<string, OwnerConn>();
  private listeners = new Set<() => void>();
  /** Every page key ever seen this session, so a reconnect or a second owner
   *  registering the same Chrome does not re-announce old pages as new. */
  private seen = new Set<string>();
  private snapshot: OwnerState[] = [];
  private notifyQueued = false;
  private disposed = false;
  private graceTimers = new Set<ReturnType<typeof setTimeout>>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): OwnerState[] => this.snapshot;

  /** Watch exactly these owners (order is kept in the snapshot). */
  setOwners(ownerTabIds: ReadonlyArray<string>): void {
    if (this.disposed) return;
    const want = new Set(ownerTabIds);
    for (const [id, owner] of this.owners) {
      if (!want.has(id)) {
        this.closeOwner(owner);
        this.owners.delete(id);
      }
    }
    const next = new Map<string, OwnerConn>();
    for (const id of ownerTabIds) {
      next.set(id, this.owners.get(id) ?? this.openOwner(id));
    }
    this.owners = next;
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.graceTimers) clearTimeout(t);
    this.graceTimers.clear();
    for (const owner of this.owners.values()) this.closeOwner(owner);
    this.owners.clear();
    this.listeners.clear();
  }

  /** Registry entry + connection status for one browser, if watched. */
  browser(ownerTabId: string, browserId: string): (Browser & BrowserConnStatus) | null {
    const conn = this.owners.get(ownerTabId)?.browsers.get(browserId);
    if (!conn) return null;
    return { ...conn.info, connected: conn.connected, error: conn.error };
  }

  /** The newest browser of an owner whose CDP socket is open. */
  liveBrowserId(ownerTabId: string): string | null {
    const owner = this.owners.get(ownerTabId);
    if (!owner) return null;
    let best: BrowserConn | null = null;
    for (const b of owner.browsers.values()) {
      if (b.connected && (!best || b.info.startedAt > best.info.startedAt)) best = b;
    }
    return best?.info.id ?? null;
  }

  /**
   * Send a CDP command on a browser's socket. Resolves with the result, or
   * `undefined` if the socket is not open, the command errors, or it times out.
   */
  send(
    ownerTabId: string,
    browserId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const conn = this.owners.get(ownerTabId)?.browsers.get(browserId);
    const ws = conn?.ws;
    if (!conn || !ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(undefined);
    const id = conn.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve(undefined);
      }, COMMAND_TIMEOUT_MS);
      conn.pending.set(id, { resolve, timer });
      try {
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch {
        clearTimeout(timer);
        conn.pending.delete(id);
        resolve(undefined);
      }
    });
  }

  // ----- internals -----

  private notify(): void {
    if (this.notifyQueued || this.disposed) return;
    this.notifyQueued = true;
    // Coalesce a burst (setDiscoverTargets replays every target as its own
    // event) into one snapshot and one React render.
    queueMicrotask(() => {
      this.notifyQueued = false;
      if (this.disposed) return;
      this.snapshot = this.buildSnapshot();
      for (const fn of this.listeners) fn();
    });
  }

  /**
   * Record a page claim made from this client (e.g. after [+] Browser's
   * `Target.createTarget`) in the owner's registry. The registry echoes it
   * back as a `claims` event, which is what updates the snapshot.
   */
  async claimPage(ownerTabId: string, browserId: string, targetId: string): Promise<boolean> {
    try {
      const res = await fetch(
        `/t/${encodeURIComponent(ownerTabId)}/registry/browsers/${encodeURIComponent(browserId)}/pages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId }),
        },
      );
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as { pageOwners?: Record<string, string> } | null;
      // Apply the answer too, in case the SSE stream is between reconnects.
      const conn = this.owners.get(ownerTabId)?.browsers.get(browserId);
      if (conn && body?.pageOwners) {
        conn.info = { ...conn.info, pageOwners: body.pageOwners };
        this.notify();
      }
      return true;
    } catch {
      return false;
    }
  }

  private buildSnapshot(): OwnerState[] {
    const now = Date.now();
    return [...this.owners.values()].map((o) => ({
      ownerTabId: o.ownerTabId,
      browsersLoaded: o.browsersLoaded,
      browsers: [...o.browsers.values()].map(
        (b): BrowserState => ({
          id: b.info.id,
          browserCdpUrl: b.info.browserCdpUrl,
          startedAt: b.info.startedAt,
          targetsLoaded: b.targetsLoaded,
          pageOwners: b.info.pageOwners ?? {},
          pages: [...b.targets.values()]
            .filter((t) => isUserPage(t.info))
            .map((t) => ({
              targetId: t.info.targetId,
              title: t.info.title ?? '',
              url: t.info.url ?? '',
              fresh: t.fresh,
              ...(t.info.openerId ? { openerId: t.info.openerId } : {}),
              ...(t.fresh && now < t.claimDeadline ? { pendingClaim: true } : {}),
            })),
        }),
      ),
    }));
  }

  private openOwner(ownerTabId: string): OwnerConn {
    const owner: OwnerConn = {
      ownerTabId,
      baseUrl: `/t/${encodeURIComponent(ownerTabId)}`,
      es: null,
      browsersLoaded: false,
      browsers: new Map(),
      disposed: false,
      esOpenedOnce: false,
    };
    void (async () => {
      // Snapshot first: anything in it was there before we looked, anything
      // the SSE stream adds beyond it registered while we were watching.
      await this.resyncBrowsers(owner, { initial: true });
      if (owner.disposed) return;
      const es = new EventSource(`${owner.baseUrl}/events`);
      owner.es = es;
      es.onopen = () => {
        // EventSource reconnects on its own; a `removed` sent while it was
        // down is lost, so re-read the list on every reopen after the first.
        if (owner.esOpenedOnce) void this.resyncBrowsers(owner, { initial: false });
        owner.esOpenedOnce = true;
      };
      es.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data) as { type?: string; data?: Browser & { id?: string } };
          if (evt.type === 'added' && evt.data?.id) this.upsertBrowser(owner, evt.data, true);
          else if (evt.type === 'claims' && evt.data?.id) {
            const conn = owner.browsers.get(evt.data.id);
            if (conn) {
              conn.info = { ...conn.info, pageOwners: evt.data.pageOwners ?? {} };
              this.notify();
            }
          } else if (evt.type === 'removed' && evt.data?.id) this.removeBrowser(owner, evt.data.id);
        } catch {}
      };
    })();
    return owner;
  }

  private async resyncBrowsers(owner: OwnerConn, opts: { initial: boolean }): Promise<void> {
    let list: Browser[] | null = null;
    try {
      const res = await fetch(`${owner.baseUrl}/browsers`, { cache: 'no-store' });
      if (res.ok) list = ((await res.json()) as { browsers?: Browser[] }).browsers ?? [];
    } catch {}
    if (owner.disposed) return;
    if (list) {
      const ids = new Set(list.map((b) => b.id));
      for (const id of [...owner.browsers.keys()]) if (!ids.has(id)) this.removeBrowser(owner, id);
      for (const b of list) this.upsertBrowser(owner, b, !opts.initial);
    }
    // A failed read still counts as loaded (empty): an owner whose registry
    // cannot be read has nothing we could show, and the SSE stream will add
    // whatever does register.
    owner.browsersLoaded = true;
    this.notify();
  }

  private upsertBrowser(owner: OwnerConn, info: Browser, live: boolean): void {
    if (owner.disposed) return;
    const existing = owner.browsers.get(info.id);
    if (existing) {
      existing.info = info;
      this.notify();
      return;
    }
    const conn: BrowserConn = {
      info,
      live,
      ws: null,
      connected: false,
      everLoaded: false,
      targetsLoaded: false,
      targets: new Map(),
      error: null,
      nextId: 1,
      pending: new Map(),
      retryTimer: null,
      retries: 0,
    };
    owner.browsers.set(info.id, conn);
    this.connectBrowser(owner, conn);
    this.notify();
  }

  private removeBrowser(owner: OwnerConn, browserId: string): void {
    const conn = owner.browsers.get(browserId);
    if (!conn) return;
    owner.browsers.delete(browserId);
    this.closeBrowser(conn);
    this.notify();
  }

  private connectBrowser(owner: OwnerConn, conn: BrowserConn): void {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${scheme}://${window.location.host}${owner.baseUrl}/b/${encodeURIComponent(conn.info.id)}/browser`,
    );
    conn.ws = ws;
    conn.targetsLoaded = false;
    const isCurrent = () => conn.ws === ws && owner.browsers.get(conn.info.id) === conn;
    const cdpUrl = conn.info.browserCdpUrl;

    ws.addEventListener('open', () => {
      if (!isCurrent()) return;
      conn.connected = true;
      conn.error = null;
      conn.retries = 0;
      const id1 = conn.nextId++;
      const id2 = conn.nextId++;
      ws.send(JSON.stringify({ id: id1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
      ws.send(JSON.stringify({ id: id2, method: 'Target.getTargets', params: {} }));
      this.notify();
    });
    ws.addEventListener('error', () => {
      if (!isCurrent()) return;
      conn.error = 'Failed to connect to browser via OmniTerm proxy';
      this.notify();
    });
    ws.addEventListener('close', () => {
      if (!isCurrent()) return;
      conn.connected = false;
      conn.ws = null;
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.resolve(undefined);
      }
      conn.pending.clear();
      this.notify();
      // Still registered → the socket dropped, not the browser. Retry; the
      // registry's pid sweep removes the entry if Chrome itself died.
      if (!owner.disposed && conn.retries < MAX_RETRIES) {
        const delay = 1000 * 2 ** conn.retries++;
        conn.retryTimer = setTimeout(() => {
          conn.retryTimer = null;
          if (!owner.disposed && owner.browsers.get(conn.info.id) === conn) {
            this.connectBrowser(owner, conn);
          }
        }, delay);
      }
    });
    ws.addEventListener('message', (event) => {
      if (!isCurrent()) return;
      let msg: {
        id?: number;
        method?: string;
        params?: { targetInfo?: CdpTargetInfo; targetId?: string };
        result?: { targetInfos?: CdpTargetInfo[] } & Record<string, unknown>;
        error?: unknown;
      };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && conn.pending.has(msg.id)) {
        const p = conn.pending.get(msg.id)!;
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg.error ? undefined : msg.result);
        return;
      }
      if (msg.result?.targetInfos) {
        // The getTargets reply is authoritative: drop anything it no longer
        // lists (destroyed while a reconnect was in flight).
        const listed = new Set(msg.result.targetInfos.map((t) => t.targetId));
        for (const id of [...conn.targets.keys()]) if (!listed.has(id)) conn.targets.delete(id);
        const freshOnLoad = conn.live || conn.everLoaded;
        for (const info of msg.result.targetInfos) this.upsertTarget(conn, cdpUrl, info, freshOnLoad);
        conn.targetsLoaded = true;
        conn.everLoaded = true;
        this.notify();
        return;
      }
      if (
        (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') &&
        msg.params?.targetInfo
      ) {
        // Before the snapshot answers these are setDiscoverTargets replaying
        // what already exists; after it, they are genuinely new.
        const freshWindow = conn.targetsLoaded || conn.live || conn.everLoaded;
        this.upsertTarget(conn, cdpUrl, msg.params.targetInfo, freshWindow);
        this.notify();
        return;
      }
      if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
        conn.targets.delete(msg.params.targetId);
        this.notify();
      }
    });
  }

  private upsertTarget(
    conn: BrowserConn,
    cdpUrl: string,
    info: CdpTargetInfo,
    freshIfUnseen: boolean,
  ): void {
    const key = pageKey(cdpUrl, info.targetId);
    const prior = conn.targets.get(info.targetId);
    const fresh = prior ? prior.fresh : freshIfUnseen && !this.seen.has(key);
    let claimDeadline = prior?.claimDeadline ?? 0;
    if (!prior && fresh) {
      claimDeadline = Date.now() + CLAIM_GRACE_MS;
      // Re-snapshot when the grace runs out, so an unclaimed page is placed.
      const timer = setTimeout(() => {
        this.graceTimers.delete(timer);
        this.notify();
      }, CLAIM_GRACE_MS + 20);
      this.graceTimers.add(timer);
    }
    // Only user-facing pages are remembered as seen: a target that starts as
    // about:blank and is filtered out briefly should still announce itself.
    if (isUserPage(info)) this.seen.add(key);
    conn.targets.set(info.targetId, { info, fresh, claimDeadline });
  }

  private closeBrowser(conn: BrowserConn): void {
    if (conn.retryTimer) clearTimeout(conn.retryTimer);
    conn.retryTimer = null;
    const ws = conn.ws;
    conn.ws = null;
    conn.connected = false;
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(undefined);
    }
    conn.pending.clear();
    try {
      ws?.close();
    } catch {}
  }

  private closeOwner(owner: OwnerConn): void {
    owner.disposed = true;
    owner.es?.close();
    owner.es = null;
    for (const conn of owner.browsers.values()) this.closeBrowser(conn);
    owner.browsers.clear();
  }
}
