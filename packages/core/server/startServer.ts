/**
 * Omniterm host server.
 *
 * `startServer({ ... })` boots the Express + WebSocket server, mounts the
 * default terminal plugin alongside any consumer-provided plugins, serves
 * the React shell as static files, and returns a handle for graceful
 * shutdown. Caller (CLI bin or external app) controls port, host,
 * plugins, and optional DevTools frontend URL.
 *
 * Architecture summary:
 *
 *   - Tab-type plugins own their HTTP routes + WebSocket upgrades + UI
 *     rendering through a uniform interface (TabTypePlugin).
 *   - Each terminal tab gets a tab-local browser registry at /t/:tabId/*;
 *     ownership is encoded in the URL, not in any payload field.
 *   - Default plugin: terminal. Consumers extend by passing more plugins
 *     in the `plugins` array.
 */

import express from 'express';
import http from 'http';
import httpProxy from 'http-proxy';
import type { Duplex } from 'stream';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { reposRouter } from './routes/repos.js';
import { worktreesRouter } from './routes/worktrees.js';
import { settingsRouter } from './routes/settings.js';
import { fsRouter } from './routes/fs.js';
import { previewRouter } from './routes/preview.js';
import { createManifestRouter, validatePluginManifests } from './routes/manifest.js';

import {
  ensureSessionTtydReady,
  getSession,
  listSessions,
} from '../plugins/terminal/lib/sessions.js';
import {
  getRecentPerfMetrics,
  getClientTelemetryConfig,
  initTelemetry,
  trackServerStarted,
  shutdownTelemetry,
} from '../lib/telemetry.js';
import { addClient, broadcast } from '../lib/events.js';
import { confinePath } from '../lib/paths.js';
import { allowedRoots } from '../lib/allowedRoots.js';
import { listRepos } from '../lib/repos.js';
import { listWorktrees } from '../lib/worktrees.js';
import { parseEnvPassthrough, setEnvPassthrough } from '../lib/sessionEnv.js';
import { sessionsRouter } from '../plugins/terminal/routes/sessions.js';
import { createTerminalPlugin } from '../plugins/terminal/plugin.js';
import type { TabTypePlugin, HostContext } from '../plugins/types.js';
import type { Session } from '../plugins/terminal/lib/sessions.js';

export interface StartServerOptions {
  /** TCP port to bind. Default: 17717. Env: OMNITERM_PORT (overrides). */
  port?: number;
  /** Bind address. Default: 0.0.0.0. Env: OMNITERM_HOST (overrides). */
  host?: string;
  /**
   * Names of environment variables that may cross the pane env scrub, on top
   * of omniterm's own allowlist (spec 001). Values are never passed here — the
   * wrapper reads them from the environment the terminal backend was started
   * with. Default: none. Env: OMNITERM_ENV_PASSTHROUGH (comma-separated,
   * overrides).
   */
  envPassthrough?: string[];
  /**
   * Extra tab-type plugins beyond the bundled default (terminal). Order
   * matters for WS upgrade dispatch — the first plugin to claim a URL
   * wins. Most plugins use unique URL prefixes so the order doesn't
   * matter in practice.
   */
  plugins?: TabTypePlugin[];
  /**
   * When true, the default terminal plugin is NOT included. Use this if
   * you want a fully custom plugin set (e.g. testing or replacement of
   * the terminal plugin). Default: false (terminal plugin is included).
   */
  excludeDefaults?: boolean;
  /**
   * Optional path to a Chrome DevTools frontend bundle on disk. When set,
   * omniterm mounts it at `/devtools/` AND uses `http://host:port/devtools/`
   * as the embedded live-view's frontend URL. When unset, no bundle is
   * served and the registry proxy targets the registered Chromium's own
   * `/devtools/` endpoint (Chromium serves stock DevTools on the same
   * port as CDP). Override only when you ship a customized bundle (e.g.
   * testbox's locator-picker version).
   */
  devtoolsBundleDir?: string;
  /**
   * Absolute path to the installed `pdfjs-dist` package directory. When set,
   * it is served (short-cached, not immutable) at `/pdfjs/` so the PDF viewer
   * can load pdf.js — lib, worker, viewer, and CSS — at runtime instead of
   * bundling ~2 MB of vendor code into the client. Mirrors `devtoolsBundleDir`.
   * See `docs/client-bundle-policy.md`.
   */
  pdfjsDistDir?: string;
  /**
   * Absolute path to the directory containing the built React client
   * (index.html + assets/). When set, the host serves it as static
   * files. When unset, the host falls back to looking next to the
   * server's __dirname, which works for both dev (tsx-watch) and prod
   * (after the standalone build).
   */
  clientDir?: string;
  /**
   * Optional lightweight status endpoint mounted at `/status`. Intended for
   * embedding apps (like testbox) that need a readiness/version surface
   * without forking the host server bootstrap.
   */
  statusHandler?: express.RequestHandler;
  /**
   * Optional hook for embedding apps to register additional routes on the
   * host app before plugin/static mounting.
   */
  configureApp?: (app: express.Express) => void;
}

export interface StartServerHandle {
  /** Stops the HTTP server + flushes telemetry. Returns when shutdown is complete. */
  shutdown(): Promise<void>;
}

const TTYD_READY_TIMEOUT_MS = 3000;

interface TtydHttpProxyDeps {
  getSession(id: string): Session | undefined;
  ensureSessionTtydReady(session: Session): Promise<void>;
  proxyWeb(req: express.Request, res: express.Response, target: string): void;
  onReadyError?(session: Session, err: unknown): void;
}

export async function handleTtydHttpProxy(
  req: express.Request,
  res: express.Response,
  deps: TtydHttpProxyDeps,
): Promise<void> {
  const rawSessionId = req.params.sessionId;
  const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  const session = sessionId ? deps.getSession(sessionId) : undefined;
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }
  try {
    await deps.ensureSessionTtydReady(session);
  } catch (err) {
    deps.onReadyError?.(session, err);
    res.status(503).send('Terminal proxy not ready');
    return;
  }
  deps.proxyWeb(req, res, `http://127.0.0.1:${session.port}`);
}

interface TtydUpgradeDeps {
  getSession(id: string): Session | undefined;
  ensureSessionTtydReady(session: Session): Promise<void>;
  proxyWs(req: http.IncomingMessage, socket: Duplex, head: Buffer, target: string): void;
  onReadyError?(session: Session, err: unknown): void;
}

export function handleTtydUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: TtydUpgradeDeps,
): boolean {
  const url = req.url || '';
  const ttydMatch = url.match(/^\/t\/([^/]+)\//);
  if (!ttydMatch) return false;

  const session = deps.getSession(ttydMatch[1]);
  if (!session) {
    socket.destroy();
    return true;
  }

  socket.pause();
  void deps.ensureSessionTtydReady(session).then(
    () => {
      if (socket.destroyed) return;
      socket.resume();
      deps.proxyWs(req, socket, head, `http://127.0.0.1:${session.port}`);
    },
    (err) => {
      deps.onReadyError?.(session, err);
      socket.destroy();
    },
  );
  return true;
}

export function startServer(opts: StartServerOptions = {}): Promise<StartServerHandle> {
  const PORT = parseInt(process.env.OMNITERM_PORT ?? String(opts.port ?? 17717), 10);
  // Binds to all interfaces by default so the terminal is reachable from other
  // devices (the primary remote-terminal use case). SECURITY: the /api routes
  // are unauthenticated and several — POST /api/create-session (which can run an
  // arbitrary `initialCommand`) and the ttyd WebSocket proxy — allow code
  // execution in the user's shell. The threat model therefore assumes
  // network-level access control (trusted LAN, VPN, or SSH tunnel); set
  // OMNITERM_HOST=127.0.0.1 to restrict to the local machine.
  const HOST = process.env.OMNITERM_HOST ?? opts.host ?? '0.0.0.0';

  // Names the operator wants to survive the pane env scrub (spec 001). Read
  // BEFORE the strip below, since the variable itself is server-only config.
  // The values these names refer to stay in process.env and are inherited by
  // the tmux server, where the clean-env wrapper reads them at pane start.
  const rawPassthrough = process.env.OMNITERM_ENV_PASSTHROUGH;
  setEnvPassthrough(
    rawPassthrough !== undefined ? parseEnvPassthrough(rawPassthrough) : (opts.envPassthrough ?? []),
  );

  // Strip server-only env vars from process.env so they don't leak into
  // child processes (tmux, ttyd, spawned shells). Vars that MUST propagate
  // (OMNITERM_BROWSER_REGISTRY_URL etc.) are passed explicitly via tmux -e.
  for (const name of [
    'OMNITERM_PORT',
    'OMNITERM_HOST',
    'OMNITERM_TTYD_PORT_MIN',
    'OMNITERM_TTYD_PORT_MAX',
    'OMNITERM_ENV_PASSTHROUGH',
  ])
    delete process.env[name];

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  if (opts.statusHandler) {
    app.get('/status', opts.statusHandler);
  }
  opts.configureApp?.(app);

  // Host API routes (workspace/repo/worktree mgmt, settings, files,
  // legacy create-session). Plugin-owned routes are mounted further down.
  app.use('/api', reposRouter);
  app.use('/api', sessionsRouter);
  app.use('/api', worktreesRouter);
  app.use('/api', settingsRouter);
  app.use('/api', fsRouter);
  app.use('/api', previewRouter);

  // When a custom DevTools bundle is provided, serve it at /devtools/
  // and use that URL for the registry's embedded live-view. Otherwise,
  // the registry per-browser default (Chromium's own /devtools/) applies.
  let devtoolsFrontendUrl: string | undefined;
  if (opts.devtoolsBundleDir) {
    app.use('/devtools', express.static(opts.devtoolsBundleDir, { fallthrough: false }));
    devtoolsFrontendUrl = `http://127.0.0.1:${PORT}/devtools/`;
    console.error(`[devtools] Serving bundle from ${opts.devtoolsBundleDir} at /devtools/`);
  }

  // Serve the installed pdfjs-dist package so the PDF viewer loads pdf.js at
  // runtime (lib/worker/viewer/CSS) rather than bundling it. The URL is NOT
  // content-hashed (`/pdfjs/build/pdf.min.mjs` is stable across versions), so we
  // must NOT mark it immutable — otherwise a future pdfjs-dist upgrade would be
  // masked by year-long browser caches. A short max-age caches within a session
  // while ETag/Last-Modified revalidation (cheap 304s) picks up an upgrade.
  if (opts.pdfjsDistDir) {
    app.use('/pdfjs', express.static(opts.pdfjsDistDir, { maxAge: '1h' }));
  }

  // Plugin registry: default terminal plugin + consumer-provided plugins.
  const plugins: TabTypePlugin[] = [
    ...(opts.excludeDefaults ? [] : [createTerminalPlugin({ devtoolsFrontendUrl })]),
    ...(opts.plugins ?? []),
  ];

  // Fail fast if an iframe plugin can't be rendered by the data-driven client.
  validatePluginManifests(plugins);

  // Plugins get the SAME confinement allowlist the host's own /api/fs and
  // /api/preview routes use (home + tracked dirs + repos + worktrees), via the
  // shared lib/allowedRoots — so plugin path-confinement can't diverge from the
  // host's.
  const pluginHost: HostContext = {
    broadcast: (type, data) => broadcast(type as Parameters<typeof broadcast>[0], data),
    workspaceRoot: () => null,
    allowedRoots,
    confinePath: (rawPath, roots) => confinePath(rawPath, roots ?? allowedRoots()),
    repos: () => listRepos(),
    worktrees: (repoPath, repoId) => listWorktrees(repoPath, repoId),
  };

  for (const p of plugins) {
    if (p.proxyPrefix) {
      app.use(p.proxyPrefix, p.createRouter(pluginHost));
    } else {
      app.use(p.createRouter(pluginHost));
    }
  }

  // Data-only plugin manifest the client renders external plugins from.
  app.use('/api', createManifestRouter(plugins));

  app.get('/api/metrics/perf', (_req, res) => {
    res.json(getRecentPerfMetrics());
  });

  // Server-resolved telemetry gate for the browser: the client inits posthog-js
  // only when this says enabled, using the same key/host/anon distinct id.
  // Unauthenticated like the rest of the local API: the only secret returned is
  // the PostHog key, which is write-only/public by design (safe to ship in the
  // browser bundle anyway), so exposing it to a local process adds no real risk.
  app.get('/api/telemetry', (_req, res) => {
    res.json(getClientTelemetryConfig());
  });

  // Server-Sent Events endpoint for host-level real-time updates.
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    addClient(res);
  });

  // ttyd proxy (terminal HTTP). Plugin WS upgrades take precedence in the
  // upgrade handler below; this catch-all handles everything `/t/:sid/*`
  // that a plugin didn't already claim — i.e. the ttyd HTTP path.
  const proxy = httpProxy.createProxyServer({ ws: true });
  proxy.on('error', (err) => {
    console.error('[proxy] error:', err.message);
  });

  app.all('/t/:sessionId/{*rest}', async (req, res) => {
    await handleTtydHttpProxy(req, res, {
      getSession,
      ensureSessionTtydReady: (session) => ensureSessionTtydReady(session, TTYD_READY_TIMEOUT_MS),
      proxyWeb: (proxyReq, proxyRes, target) => {
        proxy.web(proxyReq, proxyRes, { target });
      },
      onReadyError: (session, err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[proxy] ttyd not ready for ${session.id}: ${message}`);
      },
    });
  });

  // Static files. Default location: the package's `dist/client/`
  // (vite-built React shell). Caller can override via `clientDir`.
  // Two layouts: running from source `server/` (tsx, electron dev) finds
  // the bundle at `<pkg>/dist/client/`; running from compiled
  // `dist/server/startServer.js` finds it as a sibling at `<pkg>/dist/client/`.
  // Prefer `dist/client/` first so we never accidentally serve the unbuilt
  // source `client/` directory in dev mode.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const distClient = path.resolve(__dirname, '..', 'dist', 'client');
  const siblingClient = path.resolve(__dirname, '..', 'client');
  const clientDir =
    opts.clientDir ??
    (existsSync(path.join(distClient, 'index.html')) ? distClient : siblingClient);
  const clientIndex = path.join(clientDir, 'index.html');
  const publicDir = path.resolve(__dirname, '..', 'public');
  if (!existsSync(clientIndex)) {
    const message = [
      `[omniterm] missing client bundle at ${clientDir}`,
      'Reinstall the published package with `npm install -g @omniterm/host@latest`.',
      'When developing from the monorepo, run `pnpm --filter @omniterm/host build` before starting the server.',
    ].join('\n');
    throw new Error(message);
  }
  const clientIndexHtml = readFileSync(clientIndex, 'utf-8');
  // Vite emits content-hashed filenames under assets/ (the hash *is* the
  // content fingerprint), so they're safe to serve with a long-lived immutable
  // cache: repeat visits — and the grammar chunks fetched lazily on demand —
  // then skip even revalidation, which matters most over a high-latency tunnel.
  // index.html and other unhashed files fall through to the default handler
  // below and keep revalidating.
  //
  // ASSUMPTION (load-bearing): everything under assets/ is content-hashed. This
  // holds for Vite's default output; if a build change ever places an unhashed
  // file there, it would be pinned in clients' caches for a year — keep assets/
  // hashed-only, or scope this mount to the hashed filename pattern.
  app.use(
    '/assets',
    express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y' }),
  );
  app.use(express.static(clientDir));
  // Source-layout fallback only. Vite copies publicDir into the client bundle,
  // so clientDir above already serves these and shadows this mount; the
  // standalone package therefore ships no public/ at all. Guarded because
  // mounting a directory that does not exist is a no-op that reads like a bug.
  if (existsSync(publicDir)) app.use(express.static(publicDir));
  app.get('/{*rest}', (_req, res) => {
    res.type('html').send(clientIndexHtml);
  });

  const server = http.createServer(app);

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    // Plugin upgrades take precedence — debugger claims /ws/debugger/*,
    // terminal plugin claims /t/:tabId/b/:browserId/* for CDP.
    for (const p of plugins) {
      if (p.handleUpgrade?.(req, socket, head)) return;
    }
    // Fallback: ttyd terminal WebSocket.
    if (
      handleTtydUpgrade(req, socket, head, {
        getSession,
        ensureSessionTtydReady: (session) => ensureSessionTtydReady(session, TTYD_READY_TIMEOUT_MS),
        proxyWs: (upgradeReq, upgradeSocket, upgradeHead, target) => {
          proxy.ws(upgradeReq, upgradeSocket, upgradeHead, { target });
        },
        onReadyError: (session, err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[proxy] ttyd websocket not ready for ${session.id}: ${message}`);
        },
      })
    ) {
      return;
    }
    socket.destroy();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[omniterm] Port ${PORT} is already in use.`);
      process.exit(1);
    }
    console.error('[omniterm] server error:', err);
  });

  // Safety net: stay up through stray async errors. Dev-box semantics.
  process.on('uncaughtException', (err) => {
    console.error('[omniterm] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[omniterm] unhandledRejection:', reason);
  });

  return new Promise<StartServerHandle>((resolve, reject) => {
    server.listen(PORT, HOST, () => {
      console.log(`[omniterm] Listening on http://${HOST}:${PORT}`);
      try {
        initTelemetry();
        trackServerStarted(listSessions().length);
      } catch {}
      resolve({
        shutdown: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          await shutdownTelemetry().catch(() => {});
        },
      });
    });
    server.once('error', reject);
  });
}
