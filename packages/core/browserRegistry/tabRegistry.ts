/**
 * Terminal tab-local browser registry.
 *
 * Each terminal tab gets its own browser registry keyed by the tab's id.
 * Child processes spawned in that tab's shell inherit
 * `OMNITERM_BROWSER_REGISTRY_URL=http://<host>/t/<tabId>/registry` and POST their
 * browser registrations there. The tab's UI subscribes to
 * `/t/<tabId>/events` for real-time updates.
 *
 * Storage: `Map<tabId, TabRegistry>` lives in this module. `cleanupTab`
 * drops the whole entry (called by the plugin when the owning terminal
 * tab closes).
 */

import { EventEmitter } from 'events';
import { Router, type Request, type Response } from 'express';
import httpProxy from 'http-proxy';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

/**
 * The registry URL handed to a tab's child processes, as loopback.
 *
 * This MUST NOT be built from the request's `Host` header. The shim runs on the
 * same machine as this server, but the Host header is whatever the *browser*
 * used to reach us — and when omniterm is served through a proxy that is a
 * public hostname, often behind authentication. On a hosted Linux box that made
 * the shim POST to `https://<box>.example.com/t/<tab>/registry` with no session
 * cookie and get **401**, so no browser ever reached the UI. The same code path
 * worked on macOS purely because the developer browses `localhost:<port>` there,
 * so the header happened to be loopback.
 *
 * `req.socket.localPort` is the port this connection actually landed on, which
 * is correct under any proxying. `OMNITERM_PORT` is the fallback, matching
 * startServer's own resolution order.
 */
export function registryUrlForRequest(
  req: { socket?: { localPort?: number | null } },
  tabId: string,
): string {
  const port = req.socket?.localPort ?? Number(process.env.OMNITERM_PORT) ?? null;
  const resolved = Number.isFinite(port) && Number(port) > 0 ? Number(port) : 17717;
  return `http://127.0.0.1:${resolved}/t/${tabId}/registry`;
}

export interface BrowserEntry {
  id: string;
  cdpUrl: string;
  label: string;
  pid?: number;
  startedAt: number;
}

export interface BrowserView {
  id: string;
  label: string;
  startedAt: number;
  browserCdpUrl: string;
  pageCdpUrlTemplate: string;
  devtoolsFrontendUrl: string;
  /**
   * Forwarded from the registration so the UI's browser switcher can tell
   * two entries apart. `label` alone is not enough: the omniterm-browser
   * shim hardcodes it, so every shim-launched Chrome registers under the
   * same name. Absent when the registrant didn't report a pid.
   */
  pid?: number;
  /**
   * Which terminal tab opened each page of this Chrome, as `targetId → tabId`.
   *
   * One Chrome is shared by every terminal (the shim keeps one instance per
   * user-data-dir, and each terminal that runs it registers the same CDP
   * endpoint), so the browser alone says nothing about who a page belongs to.
   * The opener does: the shim reports the target it opened to its own tab's
   * registry, and the UI's [+] Browser action does the same after
   * `Target.createTarget`. The map spans every tab — it is keyed by CDP
   * endpoint, not by registry — so a client watching one workspace can tell a
   * page that is someone else's from one nobody has claimed.
   */
  pageOwners: Record<string, string>;
}

interface TabRegistry {
  entries: Map<string, BrowserEntry>;
  nextId: number;
  emitter: EventEmitter;
}

const tabs = new Map<string, TabRegistry>();

// ---- Page ownership claims ----
//
// `cdpUrl → (targetId → owner tabId)`. Global rather than per-registry because
// the thing being claimed — a page of a shared Chrome — is global: the latest
// claim for a target wins whichever registry it came through. Map insertion
// order doubles as recency, for the cap.
const claims = new Map<string, Map<string, string>>();
/** Per-Chrome cap; targets die without telling us, so claims can go stale. */
const MAX_CLAIMS_PER_BROWSER = 500;

function pageOwnersFor(cdpUrl: string): Record<string, string> {
  return Object.fromEntries(claims.get(cdpUrl) ?? []);
}

/** Record a claim. Returns true when it changed anything. */
function setClaim(cdpUrl: string, targetId: string, ownerTabId: string): boolean {
  let map = claims.get(cdpUrl);
  if (!map) claims.set(cdpUrl, (map = new Map()));
  const prev = map.get(targetId);
  map.delete(targetId);
  map.set(targetId, ownerTabId);
  while (map.size > MAX_CLAIMS_PER_BROWSER) map.delete(map.keys().next().value as string);
  return prev !== ownerTabId;
}

/** Tell every registry that lists this Chrome that its claims changed. */
function notifyClaims(cdpUrl: string): void {
  for (const reg of tabs.values()) {
    for (const entry of reg.entries.values()) {
      if (entry.cdpUrl === cdpUrl) reg.emitter.emit('claims', entry);
    }
  }
}

/** Forget a Chrome's claims once no registry lists it any more. */
function pruneClaimsIfOrphaned(cdpUrl: string): void {
  for (const reg of tabs.values()) {
    for (const entry of reg.entries.values()) if (entry.cdpUrl === cdpUrl) return;
  }
  claims.delete(cdpUrl);
}

/** Record that `ownerTabId` opened `targetId` in the Chrome at `cdpUrl`. */
export function claimPage(cdpUrl: string, targetId: string, ownerTabId: string): void {
  if (setClaim(cdpUrl, targetId, ownerTabId)) notifyClaims(cdpUrl);
}

/** Snapshot of the claims for one Chrome (`targetId → owner tabId`). */
export function pageOwners(cdpUrl: string): Record<string, string> {
  return pageOwnersFor(cdpUrl);
}

function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function getOrCreate(tabId: string): TabRegistry {
  let reg = tabs.get(tabId);
  if (!reg) {
    reg = { entries: new Map(), nextId: 1, emitter: new EventEmitter() };
    tabs.set(tabId, reg);
  }
  return reg;
}

function derivePageCdpUrlTemplate(browserCdpUrl: string): string {
  const match = browserCdpUrl.match(/^(ws:\/\/[^/]+)\/devtools\/browser\/[^/]+$/);
  if (match) return `${match[1]}/devtools/page/{targetId}`;
  try {
    const u = new URL(browserCdpUrl);
    return `ws://${u.host}/devtools/page/{targetId}`;
  } catch {
    return `${browserCdpUrl.replace(/\/?$/, '')}/devtools/page/{targetId}`;
  }
}

function toView(entry: BrowserEntry, devtoolsFrontendUrl: string): BrowserView {
  return {
    id: entry.id,
    label: entry.label,
    startedAt: entry.startedAt,
    browserCdpUrl: entry.cdpUrl,
    pageCdpUrlTemplate: derivePageCdpUrlTemplate(entry.cdpUrl),
    devtoolsFrontendUrl,
    pid: entry.pid,
    pageOwners: pageOwnersFor(entry.cdpUrl),
  };
}

/**
 * When the consumer doesn't supply a DevTools frontend URL, point the
 * proxy at the registered browser's own Chromium server. Chromium serves
 * the DevTools UI on the same port as its CDP (`http://host:port/devtools/...`),
 * so we just take the host:port from the entry's `cdpUrl` (which is a `ws://`)
 * and rebuild as `http://`.
 */
function defaultDevtoolsFrontendUrl(entry: BrowserEntry): string {
  try {
    const u = new URL(entry.cdpUrl);
    return `http://${u.host}/devtools/`;
  } catch {
    return '';
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Periodic pid-liveness sweep across ALL tab registries. Drops entries
// whose pid is gone. Single timer, unref'd so it doesn't pin the process.
const SWEEP_INTERVAL_MS = 5000;
const sweep = setInterval(() => {
  for (const [, reg] of tabs) {
    for (const [id, entry] of reg.entries) {
      if (entry.pid !== undefined && !isAlive(entry.pid)) {
        reg.entries.delete(id);
        reg.emitter.emit('removed', id);
        pruneClaimsIfOrphaned(entry.cdpUrl);
      }
    }
  }
}, SWEEP_INTERVAL_MS);
sweep.unref();

// ========================================================================
// Public API (used by the host + future plugin wrapper)
// ========================================================================

/** Get a snapshot of a tab's browsers (e.g. for an admin view). */
export function listBrowsers(tabId: string): BrowserEntry[] {
  return Array.from(tabs.get(tabId)?.entries.values() ?? []);
}

/**
 * Drop a tab's entire registry and every page claim it holds (called on tab
 * close). Claims go even for Chromes other tabs still list: a page whose
 * terminal is gone is nobody's, and the UI falls back to its own placement.
 */
export function cleanupTab(tabId: string): void {
  const reg = tabs.get(tabId);
  if (reg) {
    reg.emitter.removeAllListeners();
    tabs.delete(tabId);
  }
  for (const [cdpUrl, map] of [...claims]) {
    let changed = false;
    for (const [targetId, owner] of [...map]) {
      if (owner === tabId) {
        map.delete(targetId);
        changed = true;
      }
    }
    if (map.size === 0) claims.delete(cdpUrl);
    if (changed) notifyClaims(cdpUrl);
  }
  if (reg) for (const entry of reg.entries.values()) pruneClaimsIfOrphaned(entry.cdpUrl);
}

// ========================================================================
// Express router for /t/:tabId/* — mounted by the host
// ========================================================================

export interface RouterOptions {
  /**
   * Absolute URL to a Chrome DevTools frontend bundle (e.g. a vendored
   * static bundle served at `http://host/devtools/`). When unset, the
   * /b/:browserId/devtools/* proxy targets the registered browser's own
   * Chromium server (which serves DevTools UI on the same port as CDP),
   * so consumers don't need to ship a bundle. Override only when you
   * want a customized DevTools frontend (e.g. testbox's locator picker).
   */
  devtoolsFrontendUrl?: string;
  /**
   * Enables `POST /browsers/launch`: start a browser that registers under this
   * tab (the UI's "new browser tab" when the tab has no live browser). Called
   * with the tab id, the loopback registry URL its browser must POST to, and
   * the page to open. Throw `LaunchRejectedError` to refuse (e.g. unknown
   * tab); anything else is a 500. Unset → the route answers 501.
   */
  launchBrowser?: (args: { tabId: string; registryUrl: string; url: string }) => void | Promise<void>;
}

/** Thrown by a `launchBrowser` implementation to refuse with a client error. */
export class LaunchRejectedError extends Error {
  constructor(
    message: string,
    readonly status = 404,
  ) {
    super(message);
    this.name = 'LaunchRejectedError';
  }
}

/** Only these schemes may be handed to the browser launcher as the first page. */
function isLaunchableUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function createTabRegistryRouter(opts: RouterOptions): Router {
  const router = Router({ mergeParams: true });
  // changeOrigin: Chrome's embedded DevTools/CDP HTTP server rejects requests
  // whose Host header isn't a loopback address or IP (DNS-rebinding guard),
  // so the proxy must rewrite Host to match the Chrome target rather than
  // forwarding the omniterm host's Host header through unchanged.
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
  proxy.on('error', (err) => console.error('[tab-registry proxy] error:', err.message));

  // ---- Registrations (cross-process writes from subprocess clients) ----

  // POST /t/:tabId/registry/browsers
  //
  // Dedupes by cdpUrl within a tab: if the same CDP endpoint is already
  // registered here, return the existing id without emitting. Lets the
  // omniterm-browser wrapper re-POST on every invocation without spamming
  // the UI with duplicates of the same singleton-locked Chrome. Cross-tab
  // is unaffected because each tab has its own `entries` Map.
  //
  // Optional `targetId`: the page the registrant just opened, claimed for this
  // tab (see `pageOwners` on BrowserView). Applied on a dedupe too — that is
  // the common case, a second `xdg-open` into the shared Chrome.
  router.post('/registry/browsers', (req: Request, res: Response) => {
    const tabId = paramValue(req.params.tabId);
    const { cdpUrl, label, pid, targetId } = (req.body ?? {}) as {
      cdpUrl?: unknown;
      label?: unknown;
      pid?: unknown;
      targetId?: unknown;
    };
    if (typeof cdpUrl !== 'string' || !cdpUrl) {
      res.status(400).json({ error: 'cdpUrl is required' });
      return;
    }
    if (targetId !== undefined && (typeof targetId !== 'string' || !targetId)) {
      res.status(400).json({ error: 'targetId must be a non-empty string' });
      return;
    }
    const reg = getOrCreate(tabId);
    for (const [existingId, existing] of reg.entries) {
      if (existing.cdpUrl === cdpUrl) {
        if (targetId) claimPage(cdpUrl, targetId, tabId);
        res.json({ id: existingId, entry: existing, deduped: true });
        return;
      }
    }
    // Claim before announcing, so the `added` view already carries it and the
    // page never shows unowned in between.
    const claimChanged = targetId ? setClaim(cdpUrl, targetId, tabId) : false;
    const id = String(reg.nextId++);
    const entry: BrowserEntry = {
      id,
      cdpUrl,
      label: typeof label === 'string' && label ? label : 'browser',
      pid: typeof pid === 'number' ? pid : undefined,
      startedAt: Date.now(),
    };
    reg.entries.set(id, entry);
    reg.emitter.emit('added', entry);
    // Other tabs listing the same Chrome learn of the claim too.
    if (claimChanged) notifyClaims(cdpUrl);
    res.json({ id, entry });
  });

  // POST /t/:tabId/registry/browsers/:browserId/pages {targetId}
  //
  // Claim a page of a browser already registered here for this tab. Used by
  // the UI after it creates a page itself (`Target.createTarget`), which no
  // shim run reports. The latest claim for a target wins.
  router.post('/registry/browsers/:browserId/pages', (req: Request, res: Response) => {
    const tabId = paramValue(req.params.tabId);
    const browserId = paramValue(req.params.browserId);
    const { targetId } = (req.body ?? {}) as { targetId?: unknown };
    if (typeof targetId !== 'string' || !targetId) {
      res.status(400).json({ error: 'targetId is required' });
      return;
    }
    const entry = tabs.get(tabId)?.entries.get(browserId);
    if (!entry) {
      res.status(404).json({ error: 'Browser not found' });
      return;
    }
    claimPage(entry.cdpUrl, targetId, tabId);
    res.json({ claimed: true, pageOwners: pageOwnersFor(entry.cdpUrl) });
  });

  // DELETE /t/:tabId/registry/browsers/:browserId
  router.delete('/registry/browsers/:browserId', (req: Request, res: Response) => {
    const tabId = paramValue(req.params.tabId);
    const browserId = paramValue(req.params.browserId);
    const reg = tabs.get(tabId);
    const entry = reg?.entries.get(browserId);
    const existed = reg ? reg.entries.delete(browserId) : false;
    if (existed) reg!.emitter.emit('removed', browserId);
    if (entry) pruneClaimsIfOrphaned(entry.cdpUrl);
    res.status(existed ? 200 : 404).json({ removed: existed });
  });

  // ---- UI actions ----

  // POST /t/:tabId/browsers/launch {url?} — start a browser for this tab.
  //
  // The launcher (the omniterm-browser shim, for terminals) registers the
  // browser back through `registryUrl`, so the UI learns about it the normal
  // way: an `added` event on /events, then its pages over CDP. This route only
  // starts it; 202 means "launch requested", not "browser ready".
  router.post('/browsers/launch', async (req: Request, res: Response) => {
    const tabId = paramValue(req.params.tabId);
    if (!opts.launchBrowser) {
      res.status(501).json({ error: 'Launching a browser is not supported for this tab type' });
      return;
    }
    const raw = (req.body ?? {}) as { url?: unknown };
    const url = typeof raw.url === 'string' && raw.url ? raw.url : 'about:blank';
    if (!isLaunchableUrl(url)) {
      res.status(400).json({ error: 'url must be about:blank or http(s)' });
      return;
    }
    try {
      await opts.launchBrowser({ tabId, registryUrl: registryUrlForRequest(req, tabId), url });
      res.status(202).json({ launched: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof LaunchRejectedError ? err.status : 500;
      res.status(status).json({ error: message });
    }
  });

  // ---- UI reads ----

  // GET /t/:tabId/browsers — snapshot on mount
  router.get('/browsers', (req: Request, res: Response) => {
    const tabId = paramValue(req.params.tabId);
    res.setHeader('Cache-Control', 'no-store');
    const list = Array.from(tabs.get(tabId)?.entries.values() ?? []);
    res.json({
      browsers: list.map((e) =>
        toView(e, opts.devtoolsFrontendUrl ?? defaultDevtoolsFrontendUrl(e)),
      ),
    });
  });

  // GET /t/:tabId/events — live SSE stream (added / removed / claims).
  // `claims` is `{ id, pageOwners }`: the full, current claim map of one of
  // this tab's browsers, sent whenever any tab's claim on that Chrome changes.
  router.get('/events', (req: Request, res: Response) => {
    const tabId = paramValue(req.params.tabId);
    const reg = getOrCreate(tabId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const write = (event: { type: string; data: unknown }) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay current state on connect so late joiners don't miss anything.
    for (const entry of reg.entries.values()) {
      write({
        type: 'added',
        data: toView(entry, opts.devtoolsFrontendUrl ?? defaultDevtoolsFrontendUrl(entry)),
      });
    }

    const onAdded = (entry: BrowserEntry) =>
      write({
        type: 'added',
        data: toView(entry, opts.devtoolsFrontendUrl ?? defaultDevtoolsFrontendUrl(entry)),
      });
    const onRemoved = (id: string) => write({ type: 'removed', data: { id } });
    const onClaims = (entry: BrowserEntry) =>
      write({ type: 'claims', data: { id: entry.id, pageOwners: pageOwnersFor(entry.cdpUrl) } });

    reg.emitter.on('added', onAdded);
    reg.emitter.on('removed', onRemoved);
    reg.emitter.on('claims', onClaims);

    const heartbeat = setInterval(() => {
      res.write(': hb\n\n');
    }, 25_000);

    req.on('close', () => {
      reg.emitter.off('added', onAdded);
      reg.emitter.off('removed', onRemoved);
      reg.emitter.off('claims', onClaims);
      clearInterval(heartbeat);
    });
  });

  // ---- CDP proxy: devtools frontend assets (tab-scoped) ----

  // GET /t/:tabId/b/:browserId/devtools/{*rest} → devtoolsFrontendUrl + rest
  router.all('/b/:browserId/devtools/{*rest}', (req: Request, res: Response) => {
    const tabId = paramValue(req.params.tabId);
    const browserId = paramValue(req.params.browserId);
    const entry = tabs.get(tabId)?.entries.get(browserId);
    if (!entry) {
      res.status(404).send('Browser not found');
      return;
    }
    const target = opts.devtoolsFrontendUrl ?? defaultDevtoolsFrontendUrl(entry);
    let upstream: URL;
    try {
      upstream = new URL(target);
    } catch {
      res.status(502).send('Invalid devtoolsFrontendUrl');
      return;
    }
    const full = req.originalUrl ?? req.url ?? '';
    const devIdx = full.indexOf('/devtools/');
    const suffix = devIdx >= 0 ? full.slice(devIdx + '/devtools/'.length) : '';
    const basePath = upstream.pathname.endsWith('/') ? upstream.pathname : `${upstream.pathname}/`;
    req.url = `${basePath}${suffix}`;
    proxy.web(req, res, { target: `${upstream.protocol}//${upstream.host}`, ignorePath: false });
  });

  return router;
}

// ========================================================================
// WebSocket upgrade for tab-scoped CDP
// ========================================================================

/**
 * Try to handle a tab-scoped CDP WebSocket upgrade. Returns true if the URL
 * matched (dispatched or rejected); false if the URL is not tab-scoped CDP
 * (caller should fall through to other handlers, e.g. ttyd).
 *
 * `basePath` is the plugin's URL prefix (no trailing slash, no `:tabId`):
 *   "/t" for terminal, "/a" for agent, etc. Routes handled:
 *     <basePath>/:tabId/b/:id/browser         → Chrome's /devtools/browser/<guid>
 *     <basePath>/:tabId/b/:id/page/:targetId  → Chrome's /devtools/page/<targetId>
 */
export function handleCdpUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: { basePath: string },
): boolean {
  const url = req.url ?? '';
  const escaped = opts.basePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const browserRe = new RegExp(`^${escaped}/([^/]+)/b/([^/]+)/browser(?:$|\\?)`);
  const pageRe = new RegExp(`^${escaped}/([^/]+)/b/([^/]+)/page/([^/?]+)(?:$|\\?)`);
  const browserMatch = url.match(browserRe);
  const pageMatch = url.match(pageRe);
  const m = browserMatch ?? pageMatch;
  if (!m) return false;

  const tabId = m[1];
  const browserId = m[2];
  if (!tabId || !browserId) {
    socket.destroy();
    return true;
  }
  const entry = tabs.get(tabId)?.entries.get(browserId);
  if (!entry) {
    socket.destroy();
    return true;
  }

  let cdpUrl: URL;
  try {
    cdpUrl = new URL(entry.cdpUrl);
  } catch {
    socket.destroy();
    return true;
  }

  const targetPath = pageMatch
    ? cdpUrl.pathname.replace(/\/devtools\/browser\/[^/]+$/, `/devtools/page/${pageMatch[3]}`)
    : cdpUrl.pathname;

  // Chrome's CDP server enforces same-origin on WS upgrades; the browser's
  // `Origin: http://<omniterm-host>` doesn't match Chrome's listener, so
  // Chrome rejects the handshake. Set Origin to a known-allowed value
  // ("http://127.0.0.1") so the wrapper can pass an EXPLICIT
  // `--remote-allow-origins=http://127.0.0.1` to Chrome instead of the
  // permissive `*`. This narrows the surface so a malicious page in the
  // user's actual browser can't drive-by the CDP endpoint with an
  // arbitrary Origin (its Origin would be its own page, not loopback).
  req.headers.origin = 'http://127.0.0.1';
  req.url = targetPath + (cdpUrl.search || '');

  // Chrome also validates the Host header itself against a loopback
  // allowlist (independent of the Origin check above), rejecting anything
  // else with a 500 "Host header is specified and is not an IP address or
  // localhost." When omniterm is reached via a non-loopback hostname (LAN
  // name, Tailscale hostname, etc.), the client's Host header is forwarded
  // through unchanged unless we rewrite it — changeOrigin does that by
  // setting outgoing Host to the proxy target (cdpUrl.host, always
  // 127.0.0.1:<port>).
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
  proxy.on('error', () => {
    try {
      socket.destroy();
    } catch {}
  });
  proxy.ws(req, socket, head, { target: `ws://${cdpUrl.host}` });
  return true;
}
