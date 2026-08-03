import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startServer } from './startServer.js';

/**
 * Contract proof for 002 / `hostcontext-public-api`: a plugin route that calls
 * `HostContext.confinePath` rejects an out-of-root path OVER THE WIRE.
 *
 * Why this exists as an in-repo test: the original proof for this check was a
 * confinement test belonging to an out-of-tree plugin. When that plugin moved to
 * its own repository the proof left with it, and a check whose only evidence
 * lives in a repo you cannot run is not evidence here. This asserts the same
 * contract using the in-repo fixture plugin, which reaches host services only
 * through the public `HostContext` — no core internals, no external plugin.
 *
 * The unit-level guarantee (`confinePath` returns null outside the roots) is
 * covered in `lib/paths.test.ts`. What this adds is that a plugin ACTS on that
 * null: returning 403 rather than degrading to a fileless success, which is the
 * difference between a traversal attempt being refused and being ignored.
 *
 * `allowedRoots()` always contains the user's home directory, so the in-root and
 * out-of-root cases below are deterministic without touching settings on disk.
 * `confinePath` is pure path arithmetic — it never stats the filesystem — so
 * neither path needs to exist.
 */

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Load the fixture plugin by runtime URL. It lives outside this package (it is a
 * deletable example, not core code), and building the specifier at runtime keeps
 * it out of the static import graph — the clean-cut boundary test would fail the
 * build if core named a plugin in a real specifier.
 */
async function loadFixturePlugin() {
  const entry = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'plugins',
    '_fixture-plugin',
    'index.js',
  );
  const mod = (await import(pathToFileURL(entry).href)) as { default: () => unknown };
  return mod.default() as Parameters<typeof startServer>[0] extends { plugins?: (infer P)[] }
    ? P
    : never;
}

async function withFixtureHost(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const plugin = await loadFixturePlugin();
  const port = await getFreePort();
  const handle = await startServer({
    excludeDefaults: true,
    host: '127.0.0.1',
    port,
    plugins: [plugin],
  });
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await handle.shutdown();
  }
}

async function createInstance(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/fixture/instances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a plugin route rejects an out-of-root path with 403 (confinePath over the wire)', async () => {
  await withFixtureHost(async (baseUrl) => {
    // Absolute, outside the home directory and outside any tracked root.
    const res = await createInstance(baseUrl, { openFile: '/etc/passwd' });
    assert.equal(res.status, 403, 'an out-of-root path must be refused, not silently ignored');
    const body = (await res.json()) as { error?: string; id?: string };
    assert.ok(body.error, 'the refusal should carry an error, not an instance');
    assert.equal(body.id, undefined, 'no instance may be created for a refused path');
  });
});

test('a traversal escape from an allowed root is rejected with 403', async () => {
  await withFixtureHost(async (baseUrl) => {
    // Starts inside home, climbs out. confinePath normalizes before comparing,
    // so this must be refused even though the prefix looks allowed.
    const escape = path.join(homedir(), '..', '..', 'etc', 'passwd');
    const res = await createInstance(baseUrl, { openFile: escape });
    assert.equal(res.status, 403, `traversal out of an allowed root must be refused: ${escape}`);
  });
});

test('an in-root path is accepted and returned confined (absolute, normalized)', async () => {
  await withFixtureHost(async (baseUrl) => {
    const inRoot = path.join(homedir(), 'omniterm-confinement-check.fixture');
    const res = await createInstance(baseUrl, { openFile: inRoot });
    assert.equal(res.status, 200, 'a path inside an allowed root must be accepted');
    const body = (await res.json()) as { file: string; id: string };
    assert.equal(body.file, inRoot, 'the confined path is returned resolved');
    assert.ok(body.id, 'an accepted request creates an instance');
  });
});

test('omitting openFile is accepted — confinement gates paths, it does not require one', async () => {
  await withFixtureHost(async (baseUrl) => {
    const res = await createInstance(baseUrl, {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as { file: string | null; id: string };
    assert.equal(body.file, null);
    assert.ok(body.id);
  });
});
