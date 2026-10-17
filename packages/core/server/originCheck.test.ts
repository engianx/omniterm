import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  createRejectionLogger,
  isOriginAllowed,
  normalizeOrigin,
  originCheckMiddleware,
  parseAllowedOrigins,
  rejectUpgradeIfOriginNotAllowed,
  OriginConfigError,
} from './originCheck.js';
import { startServer } from './startServer.js';
import type { TabTypePlugin } from '../plugins/types.js';

// --- pure decision matrix ---------------------------------------------------

test('missing Origin (curl, the omniterm-browser shim, CLI tools) is allowed', () => {
  assert.equal(isOriginAllowed(undefined, 'localhost:17717', undefined, []), true);
  assert.equal(isOriginAllowed(undefined, undefined, undefined, []), true);
});

test('same host:port is allowed; a different host or port is not', () => {
  assert.equal(isOriginAllowed('http://localhost:17717', 'localhost:17717', undefined), true);
  assert.equal(isOriginAllowed('http://LOCALHOST:17717', 'localhost:17717', undefined), true);
  assert.equal(isOriginAllowed('http://localhost:17717', 'LocalHost:17717', undefined), true);
  assert.equal(isOriginAllowed('http://evil.example', 'localhost:17717', undefined), false);
  assert.equal(isOriginAllowed('http://localhost:9999', 'localhost:17717', undefined), false);
  assert.equal(isOriginAllowed('http://127.0.0.1:17717', 'localhost:17717', undefined), false);
  assert.equal(isOriginAllowed('http://localhost.evil.example:17717', 'localhost:17717', undefined), false);
  assert.equal(isOriginAllowed('http://localhost:17717', undefined, undefined), false);
});

test('IPv6 hosts compare correctly', () => {
  assert.equal(isOriginAllowed('http://[::1]:17717', '[::1]:17717', undefined), true);
  assert.equal(isOriginAllowed('http://[::1]:17717', '[::2]:17717', undefined), false);
});

test('default ports are normalized (http:80, https:443)', () => {
  assert.equal(isOriginAllowed('http://box.lan', 'box.lan', undefined), true);
  assert.equal(isOriginAllowed('http://box.lan', 'box.lan:80', undefined), true);
  assert.equal(isOriginAllowed('http://box.lan:80', 'box.lan', undefined), true);
  assert.equal(isOriginAllowed('https://box.lan', 'box.lan:443', undefined), true);
  assert.equal(isOriginAllowed('https://box.lan:443', 'box.lan', undefined), true);
  assert.equal(isOriginAllowed('http://box.lan', 'box.lan:8080', undefined), false);
  assert.equal(isOriginAllowed('http://box.lan:8080', 'box.lan', undefined), false);
});

test('scheme may differ (https at the proxy, http behind it)', () => {
  assert.equal(isOriginAllowed('https://box.lan', 'box.lan', undefined), true);
  assert.equal(isOriginAllowed('https://box.lan:8443', 'box.lan:8443', undefined), true);
  assert.equal(isOriginAllowed('http://box.lan:8443', 'box.lan:8443', undefined), true);
});

test('X-Forwarded-Host (first value) lets a reverse proxy work without config', () => {
  const xfh = 'omniterm.example.com';
  assert.equal(isOriginAllowed('https://omniterm.example.com', '127.0.0.1:17717', xfh), true);
  assert.equal(
    isOriginAllowed('https://omniterm.example.com', '127.0.0.1:17717', 'omniterm.example.com, inner.lan'),
    true,
  );
  assert.equal(
    isOriginAllowed('https://omniterm.example.com', '127.0.0.1:17717', 'inner.lan, omniterm.example.com'),
    false,
  );
  assert.equal(isOriginAllowed('https://evil.example', '127.0.0.1:17717', xfh), false);
  // Host still matches when the proxy passes it through.
  assert.equal(isOriginAllowed('http://127.0.0.1:17717', '127.0.0.1:17717', xfh), true);
});

test('allowlist entries match exactly (normalized); others still need a host match', () => {
  const allow = parseAllowedOrigins(['https://Omniterm.Example.com:443', 'http://other.lan:8080']);
  assert.deepEqual(allow, ['https://omniterm.example.com', 'http://other.lan:8080']);
  assert.equal(isOriginAllowed('https://omniterm.example.com', '127.0.0.1:1', undefined, allow), true);
  assert.equal(isOriginAllowed('http://other.lan:8080', '127.0.0.1:1', undefined, allow), true);
  // The allowlist is scheme-exact.
  assert.equal(isOriginAllowed('http://omniterm.example.com', '127.0.0.1:1', undefined, allow), false);
  assert.equal(isOriginAllowed('http://other.lan:8081', '127.0.0.1:1', undefined, allow), false);
});

test('Origin: null is rejected unless the allowlist contains null', () => {
  assert.equal(isOriginAllowed('null', 'localhost:17717', undefined, []), false);
  assert.equal(isOriginAllowed('null', 'null', undefined, []), false);
  assert.equal(isOriginAllowed('null', 'localhost:17717', undefined, ['null']), true);
});

test('"*" disables the check', () => {
  assert.equal(isOriginAllowed('https://evil.example', 'localhost:1', undefined, ['*']), true);
  assert.equal(isOriginAllowed('null', 'localhost:1', undefined, ['*']), true);
});

test('malformed or non-http Origins are rejected', () => {
  for (const o of ['', 'garbage', 'http://', 'http://localhost:17717/path', 'file:///etc/passwd']) {
    assert.equal(isOriginAllowed(o, 'localhost:17717', undefined), false, o);
  }
  // A non-http scheme never matches by host, only by explicit allowlist.
  assert.equal(isOriginAllowed('chrome-extension://abc', 'abc', undefined), false);
  assert.equal(isOriginAllowed('chrome-extension://abc', 'x', undefined, ['chrome-extension://abc']), true);
  // Malformed Host headers never match.
  assert.equal(isOriginAllowed('http://localhost:17717', 'localhost:17717:1', undefined), false);
  assert.equal(isOriginAllowed('http://localhost:17717', 'localhost:abc', undefined), false);
});

test('parseAllowedOrigins: comma lists, repeats, dedupe, and boot-failing typos', () => {
  assert.deepEqual(parseAllowedOrigins(['https://a.example, https://b.example', 'https://a.example', ' ']), [
    'https://a.example',
    'https://b.example',
  ]);
  assert.deepEqual(parseAllowedOrigins(['*', 'null']), ['*', 'null']);
  for (const bad of ['omniterm.example.com', 'localhost:5173', 'https://a.example/path', 'https://u:p@a.example', 'https://a.example?x']) {
    assert.throws(() => parseAllowedOrigins([bad]), OriginConfigError, bad);
  }
  assert.equal(normalizeOrigin('HTTPS://A.example:443/'), 'https://a.example');
});

test('rejection logging is deduped per origin+host per window', () => {
  const lines: string[] = [];
  let t = 0;
  const log = createRejectionLogger((l) => lines.push(l), () => t);
  const req = { headers: { origin: 'https://evil.example', host: 'h:1' }, method: 'POST', url: '/api/x?y' };
  for (let i = 0; i < 50; i++) log(req as unknown as http.IncomingMessage, 'http');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /evil\.example/);
  t = 61_000;
  log(req as unknown as http.IncomingMessage, 'ws');
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /\+49 suppressed/);
});

// --- express middleware -----------------------------------------------------

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Raw HTTP so we control Host and Origin exactly (fetch forbids setting them). */
function rawRequest(
  hostPort: string,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const [hostname, port] = hostPort.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port: Number(port), method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('middleware: non-safe methods from a foreign origin get 403 JSON; safe methods and same-origin pass', async () => {
  const rejected: string[] = [];
  const app = express();
  app.use(originCheckMiddleware({ allowlist: [], onReject: (req, kind) => rejected.push(`${kind} ${req.method}`) }));
  app.all('/{*rest}', (req, res) => res.json({ ok: req.method }));
  const server = http.createServer(app);
  const hp = await listen(server);
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const bad = await rawRequest(hp, method, '/api/x', { Origin: 'https://evil.example' });
      assert.equal(bad.status, 403, method);
      assert.deepEqual(JSON.parse(bad.body), { error: 'origin not allowed' });
      const good = await rawRequest(hp, method, '/api/x', { Origin: `http://${hp}` });
      assert.equal(good.status, 200, method);
      const none = await rawRequest(hp, method, '/api/x', {});
      assert.equal(none.status, 200, method);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const r = await rawRequest(hp, method, '/api/x', { Origin: 'https://evil.example' });
      assert.equal(r.status, 200, method);
    }
    // Reverse proxy: Host is the backend, X-Forwarded-Host is the public name.
    const proxied = await rawRequest(hp, 'POST', '/api/x', {
      Origin: 'https://omniterm.example.com',
      'X-Forwarded-Host': 'omniterm.example.com',
    });
    assert.equal(proxied.status, 200);
    assert.deepEqual(rejected, ['http POST', 'http PUT', 'http PATCH', 'http DELETE']);
  } finally {
    server.close();
  }
});

// --- WebSocket upgrade guard against a real server --------------------------

/** Send a WS handshake over a raw socket; resolve with the status line. */
function wsHandshake(hostPort: string, path: string, headers: Record<string, string>): Promise<string> {
  const [hostname, port] = hostPort.split(':');
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), hostname!, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${headers.Host ?? hostPort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers)
          .filter(([k]) => k !== 'Host')
          .map(([k, v]) => `${k}: ${v}`),
      ];
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (c) => {
      buf += c;
      if (buf.includes('\r\n')) {
        resolve(buf.split('\r\n')[0]!);
        sock.destroy();
      }
    });
    sock.on('end', () => resolve(buf.split('\r\n')[0] ?? ''));
    sock.on('error', reject);
  });
}

test('upgrade guard: bad origin gets 403 and never reaches the handler; good origin passes through', async () => {
  const reached: string[] = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    if (rejectUpgradeIfOriginNotAllowed(req, socket, { allowlist: [] })) return;
    reached.push(String(req.headers.origin ?? '<none>'));
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const hp = await listen(server);
  try {
    assert.equal(await wsHandshake(hp, '/t/s1/ws', { Origin: 'https://evil.example' }), 'HTTP/1.1 403 Forbidden');
    assert.equal(await wsHandshake(hp, '/t/s1/ws', { Origin: 'null' }), 'HTTP/1.1 403 Forbidden');
    assert.equal(await wsHandshake(hp, '/t/s1/ws', { Origin: `http://${hp}` }), 'HTTP/1.1 101 Switching Protocols');
    assert.equal(await wsHandshake(hp, '/t/s1/ws', {}), 'HTTP/1.1 101 Switching Protocols');
    assert.deepEqual(reached, [`http://${hp}`, '<none>']);
  } finally {
    server.close();
  }
});

// --- startServer wiring -----------------------------------------------------

async function freePort(): Promise<number> {
  const s = http.createServer();
  const hp = await listen(s);
  await new Promise((r) => s.close(r));
  return Number(hp.split(':')[1]);
}

/**
 * A fake plugin that claims every upgrade and records the Origin it saw, and
 * owns a POST route — proves the host guard runs BEFORE plugins (whose CDP
 * proxy rewrites Origin) and covers plugin routers too.
 */
function probePlugin(seen: string[]): TabTypePlugin {
  return {
    type: 'probe',
    label: 'Probe',
    proxyPrefix: '',
    render: { type: 'component', componentPath: './Probe' },
    createRouter: () => {
      const r = express.Router();
      r.post('/probe/do', (_req, res) => res.json({ ok: true }));
      return r;
    },
    handleUpgrade: (req: http.IncomingMessage, socket: import('node:stream').Duplex) => {
      seen.push(String(req.headers.origin ?? '<none>'));
      req.headers.origin = 'http://127.0.0.1'; // like tabRegistry's CDP rewrite
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      return true;
    },
  } as unknown as TabTypePlugin;
}

test('startServer guards host routes, plugin routes and plugin upgrades', async () => {
  delete process.env.OMNITERM_ALLOWED_ORIGINS;
  const seen: string[] = [];
  const port = await freePort();
  const handle = await startServer({
    excludeDefaults: true,
    host: '127.0.0.1',
    port,
    plugins: [probePlugin(seen)],
    allowedOrigins: ['https://omniterm.example.com'],
  });
  const hp = `127.0.0.1:${port}`;
  try {
    const evil = { Origin: 'https://evil.example' };
    assert.equal((await rawRequest(hp, 'POST', '/api/settings', evil)).status, 403);
    assert.equal((await rawRequest(hp, 'POST', '/probe/do', evil)).status, 403);
    assert.equal((await rawRequest(hp, 'POST', '/probe/do', {})).status, 200);
    assert.equal(
      (await rawRequest(hp, 'POST', '/probe/do', { Origin: 'https://omniterm.example.com' })).status,
      200,
    );
    assert.equal(await wsHandshake(hp, '/t/tab/b/x/browser', evil), 'HTTP/1.1 403 Forbidden');
    assert.equal(
      await wsHandshake(hp, '/t/tab/b/x/browser', { Origin: `http://${hp}` }),
      'HTTP/1.1 101 Switching Protocols',
    );
    assert.deepEqual(seen, [`http://${hp}`]);
    // No permissive CORS headers anywhere.
    const res = await fetch(`http://${hp}/api/session-env`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await handle.shutdown();
  }
});

test('OMNITERM_ALLOWED_ORIGINS overrides the option and is stripped from process.env', async () => {
  process.env.OMNITERM_ALLOWED_ORIGINS = 'https://from-env.example';
  const port = await freePort();
  const handle = await startServer({
    excludeDefaults: true,
    host: '127.0.0.1',
    port,
    plugins: [probePlugin([])],
    allowedOrigins: ['https://from-option.example'],
  });
  const hp = `127.0.0.1:${port}`;
  try {
    assert.equal(process.env.OMNITERM_ALLOWED_ORIGINS, undefined);
    assert.equal((await rawRequest(hp, 'POST', '/probe/do', { Origin: 'https://from-env.example' })).status, 200);
    assert.equal((await rawRequest(hp, 'POST', '/probe/do', { Origin: 'https://from-option.example' })).status, 403);
  } finally {
    delete process.env.OMNITERM_ALLOWED_ORIGINS;
    await handle.shutdown();
  }
});

test('a malformed allowed origin fails the boot', () => {
  delete process.env.OMNITERM_ALLOWED_ORIGINS;
  assert.throws(
    () => startServer({ excludeDefaults: true, host: '127.0.0.1', port: 1, allowedOrigins: ['omniterm.example.com'] }),
    (e: Error) => e instanceof OriginConfigError && /omniterm\.example\.com/.test(e.message),
  );
});

// --- the omniterm-browser shim (Node fetch / undici) sends no Origin ---------

test('Node fetch (what bin/omniterm-browser.js uses) sends no Origin, so the shim passes', async () => {
  const origins: Array<string | undefined> = [];
  const app = express();
  app.use((req, _res, next) => {
    origins.push(req.headers.origin);
    next();
  });
  app.use(originCheckMiddleware({ allowlist: [] }));
  app.all('/{*rest}', (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  const hp = await listen(server);
  try {
    const post = await fetch(`http://${hp}/t/tab/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(post.status, 200);
    const del = await fetch(`http://${hp}/t/tab/browsers/x`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(origins, [undefined, undefined]);
  } finally {
    server.close();
  }
});
