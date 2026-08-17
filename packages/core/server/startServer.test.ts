import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PassThrough, type Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type express from 'express';
import { handleTtydHttpProxy, handleTtydUpgrade, startServer } from './startServer.js';
import type { Session } from '../plugins/terminal/lib/sessions.js';
import { getEnvPassthrough, setEnvPassthrough } from '../lib/sessionEnv.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('failed to allocate local port'));
        }
      });
    });
    server.on('error', reject);
  });
}

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class TestSocket extends PassThrough {
  pauseCalls = 0;
  resumeCalls = 0;
  destroyCalls = 0;

  override pause(): this {
    this.pauseCalls++;
    return super.pause();
  }

  override resume(): this {
    this.resumeCalls++;
    return super.resume();
  }

  override destroy(error?: Error): this {
    this.destroyCalls++;
    return super.destroy(error);
  }
}

class TestResponse {
  statusCode: number | undefined;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  send(value: unknown): this {
    this.body = value;
    return this;
  }
}

test('serves the client index for deep SPA paths', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-start-server-test-'));
  const clientDir = path.join(root, 'client');
  const indexHtml = '<!doctype html><title>OmniTerm test shell</title>';
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(path.join(clientDir, 'index.html'), indexHtml);

  const port = await getFreePort();
  const handle = await startServer({
    clientDir,
    excludeDefaults: true,
    host: '127.0.0.1',
    port,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/workspaces/recent`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), indexHtml);
  } finally {
    await handle.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('serves content-hashed assets with a long-lived immutable cache', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-asset-cache-test-'));
  const clientDir = path.join(root, 'client');
  mkdirSync(path.join(clientDir, 'assets'), { recursive: true });
  writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(path.join(clientDir, 'assets', 'index-abc123.js'), 'console.log(1);');

  const port = await getFreePort();
  const handle = await startServer({
    clientDir,
    excludeDefaults: true,
    host: '127.0.0.1',
    port,
  });

  try {
    const asset = await fetch(`http://127.0.0.1:${port}/assets/index-abc123.js`);
    assert.equal(asset.status, 200);
    const cacheControl = asset.headers.get('cache-control') ?? '';
    assert.match(cacheControl, /immutable/, 'hashed assets should be immutable-cached');
    // Enforce a genuinely long-lived cache — max-age=0 must NOT satisfy this.
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1]);
    assert.ok(maxAge >= 86400, `hashed assets should set a long-lived max-age, got ${maxAge}`);

    // The unhashed entry HTML must keep revalidating, or clients pin a stale shell.
    const index = await fetch(`http://127.0.0.1:${port}/`);
    assert.ok(
      !/immutable/.test(index.headers.get('cache-control') ?? ''),
      'index.html must not be immutable-cached',
    );
  } finally {
    await handle.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ttyd HTTP proxy waits for readiness before proxying', async () => {
  const session: Session = {
    id: 'session-http-a',
    worktreeId: '_orphan',
    tmuxName: 'session-http-a',
    port: 7801,
    createdAt: new Date(0).toISOString(),
  };
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const calls: string[] = [];
  const res = new TestResponse();
  const req = { params: { sessionId: session.id } } as unknown as express.Request;

  const handled = handleTtydHttpProxy(req, res as unknown as express.Response, {
    getSession: (id) => {
      calls.push(`get:${id}`);
      return session;
    },
    ensureSessionTtydReady: async (readySession) => {
      calls.push(`ready:${readySession.id}`);
      await ready;
    },
    proxyWeb: (_proxyReq, _proxyRes, target) => {
      calls.push(`proxy:${target}`);
    },
  });

  assert.deepEqual(calls, ['get:session-http-a', 'ready:session-http-a']);
  await waitForTurn();
  assert.deepEqual(calls, ['get:session-http-a', 'ready:session-http-a']);

  resolveReady();
  await handled;

  assert.equal(res.statusCode, undefined);
  assert.equal(res.body, undefined);
  assert.deepEqual(calls, [
    'get:session-http-a',
    'ready:session-http-a',
    'proxy:http://127.0.0.1:7801',
  ]);
});

test('ttyd HTTP proxy returns 503 when readiness fails', async () => {
  const session: Session = {
    id: 'session-http-b',
    worktreeId: '_orphan',
    tmuxName: 'session-http-b',
    port: 7802,
    createdAt: new Date(0).toISOString(),
  };
  const res = new TestResponse();
  const req = { params: { sessionId: session.id } } as unknown as express.Request;
  const errors: string[] = [];
  let proxyCalls = 0;

  await handleTtydHttpProxy(req, res as unknown as express.Response, {
    getSession: () => session,
    ensureSessionTtydReady: async () => {
      throw new Error('ttyd not ready');
    },
    proxyWeb: () => {
      proxyCalls++;
    },
    onReadyError: (_session, err) => {
      errors.push(err instanceof Error ? err.message : String(err));
    },
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.body, 'Terminal proxy not ready');
  assert.equal(proxyCalls, 0);
  assert.deepEqual(errors, ['ttyd not ready']);
});

test('ttyd HTTP proxy returns 404 when the session is missing', async () => {
  const res = new TestResponse();
  const req = { params: { sessionId: 'missing-session' } } as unknown as express.Request;
  let readinessCalls = 0;
  let proxyCalls = 0;

  await handleTtydHttpProxy(req, res as unknown as express.Response, {
    getSession: () => undefined,
    ensureSessionTtydReady: async () => {
      readinessCalls++;
    },
    proxyWeb: () => {
      proxyCalls++;
    },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body, 'Session not found');
  assert.equal(readinessCalls, 0);
  assert.equal(proxyCalls, 0);
});

test('ttyd WebSocket upgrades wait for ttyd readiness before proxying', async () => {
  const session: Session = {
    id: 'session-a',
    worktreeId: '_orphan',
    tmuxName: 'session-a',
    port: 7799,
    createdAt: new Date(0).toISOString(),
  };
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const calls: string[] = [];
  const socket = new TestSocket();

  const handled = handleTtydUpgrade(
    { url: '/t/session-a/ws' } as IncomingMessage,
    socket as Duplex,
    Buffer.alloc(0),
    {
      getSession: (id) => {
        calls.push(`get:${id}`);
        return session;
      },
      ensureSessionTtydReady: async (readySession) => {
        calls.push(`ready:${readySession.id}`);
        await ready;
      },
      proxyWs: (_req, _socket, _head, target) => {
        calls.push(`proxy:${target}`);
      },
    },
  );

  assert.equal(handled, true);
  assert.equal(socket.pauseCalls, 1);
  assert.equal(socket.resumeCalls, 0);
  assert.deepEqual(calls, ['get:session-a', 'ready:session-a']);

  await waitForTurn();
  assert.deepEqual(calls, ['get:session-a', 'ready:session-a']);

  resolveReady();
  await waitForTurn();

  assert.equal(socket.resumeCalls, 1);
  assert.equal(socket.destroyCalls, 0);
  assert.deepEqual(calls, ['get:session-a', 'ready:session-a', 'proxy:http://127.0.0.1:7799']);
});

test('ttyd WebSocket upgrades destroy the socket when readiness fails', async () => {
  const session: Session = {
    id: 'session-b',
    worktreeId: '_orphan',
    tmuxName: 'session-b',
    port: 7800,
    createdAt: new Date(0).toISOString(),
  };
  const socket = new TestSocket();
  const errors: string[] = [];
  let proxyCalls = 0;

  const handled = handleTtydUpgrade(
    { url: '/t/session-b/ws' } as IncomingMessage,
    socket as Duplex,
    Buffer.alloc(0),
    {
      getSession: () => session,
      ensureSessionTtydReady: async () => {
        throw new Error('ttyd not ready');
      },
      proxyWs: () => {
        proxyCalls++;
      },
      onReadyError: (_session, err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    },
  );

  assert.equal(handled, true);
  await waitForTurn();

  assert.equal(socket.pauseCalls, 1);
  assert.equal(socket.resumeCalls, 0);
  assert.equal(socket.destroyCalls, 1);
  assert.equal(proxyCalls, 0);
  assert.deepEqual(errors, ['ttyd not ready']);
});

// --- session-env passthrough wiring (spec 001 FR-011) ---------------------

/** Boot a bare host on a free port and hand the handle to `fn`, always shutting down. */
async function withHost(
  opts: Parameters<typeof startServer>[0],
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const port = await getFreePort();
  const handle = await startServer({ excludeDefaults: false, host: '127.0.0.1', port, ...opts });
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await handle.shutdown();
  }
}

test('startServer installs the passthrough list from its options', async () => {
  setEnvPassthrough([]);
  delete process.env.OMNITERM_ENV_PASSTHROUGH;
  await withHost({ envPassthrough: ['MY_TOOL_TOKEN', 'MY_TOOL_URL'] }, async (base) => {
    assert.deepEqual(getEnvPassthrough(), ['MY_TOOL_TOKEN', 'MY_TOOL_URL']);
    const body = (await (await fetch(`${base}/api/session-env`)).json()) as {
      passthrough: string[];
    };
    assert.deepEqual(body.passthrough, ['MY_TOOL_TOKEN', 'MY_TOOL_URL']);
  });
  setEnvPassthrough([]);
});

test('OMNITERM_ENV_PASSTHROUGH overrides the option, like OMNITERM_PORT/HOST do', async () => {
  setEnvPassthrough([]);
  process.env.OMNITERM_ENV_PASSTHROUGH = ' FROM_ENV , OTHER ,FROM_ENV';
  try {
    await withHost({ envPassthrough: ['FROM_OPTION'] }, async () => {
      // Trimmed, de-duplicated, and the option is not merged in.
      assert.deepEqual(getEnvPassthrough(), ['FROM_ENV', 'OTHER']);
    });
  } finally {
    delete process.env.OMNITERM_ENV_PASSTHROUGH;
    setEnvPassthrough([]);
  }
});

// The variable is server-only config: it must not itself survive into panes.
// It is not in the pane allowlist either, so this is defence in depth — and it
// mirrors how OMNITERM_PORT/OMNITERM_HOST are handled.
test('startServer strips OMNITERM_ENV_PASSTHROUGH from process.env', async () => {
  setEnvPassthrough([]);
  process.env.OMNITERM_ENV_PASSTHROUGH = 'FROM_ENV';
  try {
    await withHost({}, async () => {
      assert.equal(process.env.OMNITERM_ENV_PASSTHROUGH, undefined);
      assert.deepEqual(getEnvPassthrough(), ['FROM_ENV']);
    });
  } finally {
    delete process.env.OMNITERM_ENV_PASSTHROUGH;
    setEnvPassthrough([]);
  }
});

test('a malformed OMNITERM_ENV_PASSTHROUGH fails the boot rather than dropping names', async () => {
  setEnvPassthrough([]);
  process.env.OMNITERM_ENV_PASSTHROUGH = 'GOOD,bad name';
  try {
    await assert.rejects(
      () => withHost({}, async () => {}),
      (e: Error) => e.name === 'EnvNameError' && /bad name/.test(e.message),
    );
    assert.deepEqual(getEnvPassthrough(), [], 'nothing should be installed on a bad list');
  } finally {
    delete process.env.OMNITERM_ENV_PASSTHROUGH;
    setEnvPassthrough([]);
  }
});
