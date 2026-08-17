import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// Isolate settings before importing the router (the terminal lib captures
// module globals and runs orphan recovery at load; SETTINGS_DIR keeps this off
// the user's real settings). These tests exercise only the input-validation and
// not-found paths, which return before any tmux/ttyd call — so they need no real
// tmux server or ttyd binary. The create-or-adopt / status-semantics paths do
// require both and are covered by buildNewSessionArgs unit tests plus manual
// verification rather than a flaky env-dependent integration test.
const settingsDir = mkdtempSync(path.join(tmpdir(), 'omniterm-sessions-route-'));
process.env.SETTINGS_DIR = settingsDir;
process.on('exit', () => rmSync(settingsDir, { recursive: true, force: true }));

const {
  sessionsRouter,
  MAX_SESSION_NAME_LEN,
  MAX_INITIAL_COMMAND_LEN,
  MAX_ENV_VARS,
  MAX_ENV_VALUE_LEN,
  bucketDiscoveredSessions,
} = await import('./sessions.js');
const { setEnvPassthrough } = await import('../../../lib/sessionEnv.js');

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use(sessionsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const createSession = (base: string, body: unknown) =>
  fetch(`${base}/create-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('POST /create-session requires cwd', async () => {
  await withServer(async (base) => {
    const res = await createSession(base, {});
    assert.equal(res.status, 400);
  });
});

test('POST /create-session rejects a name with tmux/URL-unsafe characters', async () => {
  await withServer(async (base) => {
    for (const name of ['bad.name', 'has space', 'a/b', 'a:b']) {
      const res = await createSession(base, { cwd: '/tmp', name });
      assert.equal(res.status, 400, `expected 400 for name ${JSON.stringify(name)}`);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /name must be/);
    }
  });
});

test('POST /create-session rejects an over-long name', async () => {
  await withServer(async (base) => {
    const res = await createSession(base, { cwd: '/tmp', name: 'a'.repeat(MAX_SESSION_NAME_LEN + 1) });
    assert.equal(res.status, 400);
  });
});

test('POST /create-session rejects an over-long initialCommand', async () => {
  await withServer(async (base) => {
    const res = await createSession(base, {
      cwd: '/tmp',
      initialCommand: 'x'.repeat(MAX_INITIAL_COMMAND_LEN + 1),
    });
    assert.equal(res.status, 400);
  });
});

const HOME = '/Users/tester';

test('bucketDiscoveredSessions: a MANAGED session in a tracked non-git dir marks it active', () => {
  // Regression: the "active sessions" filter dropped a non-git workspace whose
  // only session was created through the app, because managed sessions were
  // excluded from the discovered set and non-git dirs carry no session count.
  const byDir = bucketDiscoveredSessions({
    tmuxSessions: [{ name: 'mysession', cwd: '/work/scripts', created: '1' }],
    managedNames: new Set(['mysession']), // app-managed
    repoWorktreePaths: new Set(),
    trackedDirs: ['/work/scripts'],
    home: HOME,
  });
  assert.equal(byDir['/work/scripts'].length, 1, 'tracked non-git dir should read as active');
});

test('bucketDiscoveredSessions: an orphan session surfaces even in an untracked dir', () => {
  const byDir = bucketDiscoveredSessions({
    tmuxSessions: [{ name: 'stray', cwd: '/tmp/adhoc', created: '1' }],
    managedNames: new Set(),
    repoWorktreePaths: new Set(),
    trackedDirs: [],
    home: HOME,
  });
  assert.equal(byDir['/tmp/adhoc'].length, 1, 'orphan gets its own workspace entry');
});

test('bucketDiscoveredSessions: a worktree session never leaks into the OTHERS map', () => {
  const byDir = bucketDiscoveredSessions({
    tmuxSessions: [{ name: 'wt', cwd: '/repo/feature', created: '1' }],
    managedNames: new Set(), // not managed, but lives in a worktree
    repoWorktreePaths: new Set(['/repo/feature']),
    trackedDirs: [],
    home: HOME,
  });
  assert.deepEqual(Object.keys(byDir), [HOME], 'worktree path must not become an OTHERS key');
});

test('bucketDiscoveredSessions: a MANAGED session in an UNTRACKED dir is ignored', () => {
  // Guards the `else if (byDir[s.cwd])` branch: a managed session only counts
  // toward a pre-seeded dir, so one in a dir the user never tracked must not
  // conjure a workspace entry.
  const byDir = bucketDiscoveredSessions({
    tmuxSessions: [{ name: 'app', cwd: '/some/untracked', created: '1' }],
    managedNames: new Set(['app']),
    repoWorktreePaths: new Set(),
    trackedDirs: [],
    home: HOME,
  });
  assert.deepEqual(Object.keys(byDir), [HOME], 'untracked dir must not become an entry');
});

test('bucketDiscoveredSessions: a MANAGED session at HOME counts toward home activity', () => {
  // HOME is always seeded, so a managed session there should register.
  const byDir = bucketDiscoveredSessions({
    tmuxSessions: [{ name: 'homeapp', cwd: HOME, created: '1' }],
    managedNames: new Set(['homeapp']),
    repoWorktreePaths: new Set(),
    trackedDirs: [],
    home: HOME,
  });
  assert.equal(byDir[HOME].length, 1, 'managed session at HOME should count');
});

test('bucketDiscoveredSessions: a tracked dir with no sessions stays seeded but empty', () => {
  const byDir = bucketDiscoveredSessions({
    tmuxSessions: [],
    managedNames: new Set(),
    repoWorktreePaths: new Set(),
    trackedDirs: ['/work/notes'],
    home: HOME,
  });
  assert.deepEqual(byDir['/work/notes'], [], 'tracked dir present so it renders, but inactive');
});

test('GET /sessions/:id returns 404 for an unknown session', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/sessions/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

test('DELETE /sessions/:id returns 404 for an unknown session', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/sessions/does-not-exist`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

// --- spec 001: per-session env --------------------------------------------
//
// These assert the rejection paths, which return before any tmux call. The
// accepted path needs a real tmux server and is covered in
// lib/tmux.integration.test.ts.

test('POST /create-session rejects env names that could break out of the wrapper', async () => {
  await withServer(async (base) => {
    for (const key of ['1BAD', 'has space', "quo'te", 'semi;colon', 'dash-ed', '$(id)']) {
      const res = await createSession(base, { cwd: '/tmp', env: { [key]: 'v' } });
      assert.equal(res.status, 400, `expected 400 for env name ${JSON.stringify(key)}`);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /not a valid environment variable name/);
    }
  });
});

test('POST /create-session rejects env names omniterm reserves', async () => {
  await withServer(async (base) => {
    for (const key of ['TMUX', 'TMUX_PANE']) {
      const res = await createSession(base, { cwd: '/tmp', env: { [key]: 'v' } });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /reserved/);
    }
  });
});

test('POST /create-session rejects malformed env shapes and oversized values', async () => {
  await withServer(async (base) => {
    const cases: unknown[] = [
      'A=B',
      ['A'],
      { OK: 1 },
      { OK: null },
      { OK: 'x'.repeat(MAX_ENV_VALUE_LEN + 1) },
      { OK: 'has\0nul' },
      Object.fromEntries(Array.from({ length: MAX_ENV_VARS + 1 }, (_, i) => [`V${i}`, 'x'])),
    ];
    for (const env of cases) {
      const res = await createSession(base, { cwd: '/tmp', env });
      assert.equal(res.status, 400, `expected 400 for env ${JSON.stringify(env).slice(0, 40)}`);
    }
  });
});

test('GET /session-env reports the configured names and never a value', async () => {
  await withServer(async (base) => {
    const empty = await (await fetch(`${base}/session-env`)).json();
    assert.deepEqual(empty, { passthrough: [] });

    try {
      setEnvPassthrough(['MY_TOKEN', 'MY_BASE_URL']);
      const res = await fetch(`${base}/session-env`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { passthrough: string[] };
      assert.deepEqual(body.passthrough, ['MY_TOKEN', 'MY_BASE_URL']);
      assert.deepEqual(Object.keys(body), ['passthrough']);
    } finally {
      setEnvPassthrough([]);
    }
  });
});
