import express, { type Request, type Response, type Router } from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { HostContext, PluginInstance } from '@omniterm/plugin-types';
import { AgentSession, type AttachedFile } from './session.js';
import { SessionStore, type SessionEvent } from './sessionStore.js';

/**
 * One agent conversation = one omniterm tab (conversation-per-tab). The tab id
 * IS the conversation id: the SPA loads at `/agent/<id>/` and its relative API
 * calls (`api/record`, `api/messages`, `api/watch`, `api/cdp-version/:port`)
 * resolve under that prefix to the routes below. The live `AgentSession` and the
 * on-disk `SessionStore` record are both keyed by this id.
 */
class AgentInstance {
  readonly id: string;
  readonly projectRoot: string;
  name = 'Agent';
  private readonly store: SessionStore;
  private session: AgentSession | null = null;
  /** Set while a turn streams, so `watch` can tail an in-flight turn. */
  private turnEmitter: EventEmitter | null = null;

  constructor(id: string, projectRoot: string) {
    this.id = id;
    this.projectRoot = projectRoot;
    this.store = new SessionStore(projectRoot);
  }

  toRow(): PluginInstance {
    return { id: this.id, name: this.name, status: 'running' };
  }

  /** GET /agent/:id/api/record — replay state for the SPA on (re)mount. */
  getRecord(res: Response): void {
    const record = this.store.get(this.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ events: record?.events ?? [], cwd: record?.cwd ?? this.projectRoot });
  }

  /** POST /agent/:id/api/messages — run one agent turn, streaming SDK events as SSE. */
  async runTurn(req: Request, res: Response): Promise<void> {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    if (!prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    const files: AttachedFile[] = Array.isArray(req.body?.files)
      ? (req.body.files as AttachedFile[]).filter(
          (f) =>
            typeof f.name === 'string' && typeof f.type === 'string' && typeof f.data === 'string',
        )
      : [];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    req.socket.setNoDelay?.(true);
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    res.write(': open\n\n');
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 10000);

    if (!this.session) {
      // Resume the SDK conversation from the stored id when one exists (e.g. the
      // host process kept this instance across a browser reload); otherwise the
      // first turn boots a fresh SDK session and captures its id.
      const existing = this.store.get(this.id);
      this.session = new AgentSession({
        projectRoot: this.projectRoot,
        sidecarId: this.id,
        resumeId: existing?.sdkSessionId,
      });
    }

    const emitter = new EventEmitter();
    emitter.setMaxListeners(20);
    this.turnEmitter = emitter;

    const abortController = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) abortController.abort();
    });

    try {
      await this.session.runTurn({
        prompt,
        files: files.length ? files : undefined,
        signal: abortController.signal,
        onEvent: (event) => {
          send('message', event);
          emitter.emit('event', event);
        },
      });
      const donePayload = { sessionId: this.session.sdkSessionId ?? this.id };
      send('done', donePayload);
      emitter.emit('done', donePayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send('error', { message });
      emitter.emit('error', { message });
    } finally {
      finished = true;
      clearInterval(heartbeat);
      this.turnEmitter = null;
      res.end();
    }
  }

  /** GET /agent/:id/api/watch?from=N — tail an in-flight turn after a reconnect. */
  watch(req: Request, res: Response): void {
    const from = Math.max(0, parseInt(String(req.query.from ?? '0'), 10) || 0);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    req.socket.setNoDelay?.(true);
    res.flushHeaders?.();

    const sendFrame = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    res.write(': open\n\n');

    const emitter = this.turnEmitter;
    if (!emitter) {
      sendFrame('status', { running: false });
      res.end();
      return;
    }

    let closed = false;
    const onEvent = (event: SessionEvent) => {
      if (!closed) sendFrame('message', event);
    };
    const onDone = (data: { sessionId: string }) => {
      if (!closed) {
        sendFrame('done', data);
        res.end();
      }
      cleanup();
    };
    const onError = (data: { message: string }) => {
      if (!closed) {
        sendFrame('error', data);
        res.end();
      }
      cleanup();
    };
    const cleanup = () => {
      emitter.off('event', onEvent);
      emitter.off('done', onDone);
      emitter.off('error', onError);
    };

    emitter.on('event', onEvent);
    emitter.on('done', onDone);
    emitter.on('error', onError);

    // Status first so the client flips to streaming, THEN replay persisted
    // events from `from` (no await between subscribe and read — single-threaded).
    sendFrame('status', { running: true });
    const record = this.store.get(this.id);
    if (record) {
      for (const evt of record.events.slice(from)) {
        if (!closed) sendFrame('message', evt);
      }
    }

    const heartbeat = setInterval(() => {
      if (!closed) res.write(': heartbeat\n\n');
    }, 10000);
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      cleanup();
    });
  }

  async close(): Promise<void> {
    // The live AgentSession holds no OS resources between turns (each turn is a
    // fresh `query()`); dropping the references is enough. A turn in flight is
    // aborted by its own `res.on('close')` when the SSE socket closes.
    this.turnEmitter = null;
    this.session = null;
  }
}

/** Express 5 types route params as `string | string[]`; collapse to one string. */
function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Proxy a Chromium `/json/version` so the SPA can resolve the page WS URL. */
async function cdpVersion(req: Request, res: Response): Promise<void> {
  const port = parseInt(paramValue(req.params.port), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    res.status(400).json({ error: 'invalid port' });
    return;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!r.ok) {
      res.status(502).json({ error: 'CDP not available' });
      return;
    }
    res.json(await r.json());
  } catch {
    res.status(502).json({ error: 'CDP not available' });
  }
}

/**
 * Owns the live set of agent instances and builds the plugin's Express routes:
 * manifest lifecycle (`/demo-agent/instances`), per-instance API (`/agent/:id/api/*`),
 * and the SPA (index per instance + shared `/agent-assets`).
 */
export class AgentRegistry {
  private readonly instances = new Map<string, AgentInstance>();

  createRoutes(host: HostContext, clientDir: string): Router {
    const router = express.Router();

    const withInstance =
      (handler: (inst: AgentInstance, req: Request, res: Response) => void) =>
      (req: Request, res: Response) => {
        const inst = this.instances.get(paramValue(req.params.id));
        if (!inst) {
          res.status(404).json({ error: 'agent instance not found' });
          return;
        }
        handler(inst, req, res);
      };

    // --- manifest lifecycle ---
    router.post('/demo-agent/instances', express.json(), (req, res) => {
      const raw = typeof req.body?.workspaceRoot === 'string' ? req.body.workspaceRoot : '';
      const projectRoot =
        (raw ? host.confinePath(raw) : null) ??
        host.workspaceRoot() ??
        host.allowedRoots()[0] ??
        process.cwd();
      const id = `a-${randomUUID()}`;
      const inst = new AgentInstance(id, projectRoot);
      this.instances.set(id, inst);
      res.json(inst.toRow());
    });

    router.get('/demo-agent/instances', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: [...this.instances.values()].map((i) => i.toRow()) });
    });

    router.delete('/demo-agent/instances/:id', async (req, res) => {
      const id = paramValue(req.params.id);
      const inst = this.instances.get(id);
      if (inst) {
        await inst.close();
        this.instances.delete(id);
      }
      res.json({ removed: Boolean(inst) });
    });

    // --- per-instance API (SPA calls these relative to /agent/:id/) ---
    router.get('/agent/:id/api/record', withInstance((inst, _req, res) => inst.getRecord(res)));
    router.post(
      '/agent/:id/api/messages',
      express.json({ limit: '25mb' }),
      withInstance((inst, req, res) => void inst.runTurn(req, res)),
    );
    router.get('/agent/:id/api/watch', withInstance((inst, req, res) => inst.watch(req, res)));
    router.get(
      '/agent/:id/api/cdp-version/:port',
      withInstance((_inst, req, res) => void cdpVersion(req, res)),
    );

    // --- SPA: per-instance index.html + shared static assets ---
    router.get(
      '/agent/:id/',
      withInstance((_inst, _req, res) => res.sendFile(path.join(clientDir, 'index.html'))),
    );
    router.use('/agent-assets', express.static(clientDir));

    return router;
  }
}
