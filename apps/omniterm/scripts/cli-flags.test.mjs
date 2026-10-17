import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The launcher (bin/omniterm.js) does NOT pass its argv through: it translates
// most flags into env vars and forwards only an explicit allowlist to the server
// entry. So a flag the server parses correctly can still be dead on arrival when
// the published CLI is used — which is exactly what happened to
// --env-passthrough, and which no server-level test can see.
//
// This boots the REAL CLI the way a user does and asks the running host what it
// ended up configured with. Self-skips when the standalone build or ttyd/tmux is
// missing (the launcher requires both); a skip is reported as a skip.

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const cli = path.join(appDir, 'bin', 'omniterm.js');

function toolMissing() {
  for (const cmd of ['ttyd', 'tmux']) {
    try {
      execFileSync('which', [cmd], { stdio: 'ignore' });
    } catch {
      return `${cmd} not installed`;
    }
  }
  return null;
}

const built = existsSync(path.join(appDir, 'standalone', 'server', 'server.js'));
// node:test skips on any non-`false` value, so normalise the no-reason case.
const skip = !built ? 'standalone build missing (run pnpm build)' : (toolMissing() ?? false);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHost(base, deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/session-env`);
      if (res.ok) return res;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`host did not come up at ${base}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Boot the CLI with `args`, hand the base URL to `fn`, always tear it down. */
async function withCli(args, env, fn) {
  const port = await freePort();
  const settingsDir = mkdtempSync(path.join(tmpdir(), 'omniterm-cli-flags-'));
  const child = spawn(process.execPath, [cli, '--port', String(port), ...args], {
    env: {
      ...process.env,
      SETTINGS_DIR: settingsDir,
      OMNITERM_HOST: '127.0.0.1',
      OMNITERM_TELEMETRY: '0',
      ...env,
    },
    stdio: 'ignore',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHost(base);
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    rmSync(settingsDir, { recursive: true, force: true });
  }
}

test('the CLI forwards --env-passthrough to the server it spawns', { skip }, async () => {
  await withCli(['--env-passthrough', 'MY_TOOL_TOKEN,MY_TOOL_URL'], {}, async (base) => {
    const body = await (await fetch(`${base}/api/session-env`)).json();
    assert.deepEqual(body.passthrough, ['MY_TOOL_TOKEN', 'MY_TOOL_URL']);
  });
});

test('repeated --env-passthrough flags accumulate through the CLI', { skip }, async () => {
  await withCli(['--env-passthrough', 'A_ONE', '--env-passthrough', 'B_TWO,A_ONE'], {}, async (base) => {
    const body = await (await fetch(`${base}/api/session-env`)).json();
    assert.deepEqual(body.passthrough, ['A_ONE', 'B_TWO']);
  });
});

test('with no flag the CLI configures nothing', { skip }, async () => {
  await withCli([], {}, async (base) => {
    const body = await (await fetch(`${base}/api/session-env`)).json();
    assert.deepEqual(body.passthrough, []);
  });
});

test('OMNITERM_ENV_PASSTHROUGH reaches the server through the CLI and wins', { skip }, async () => {
  await withCli(['--env-passthrough', 'FROM_FLAG'], { OMNITERM_ENV_PASSTHROUGH: 'FROM_ENV' }, async (base) => {
    const body = await (await fetch(`${base}/api/session-env`)).json();
    assert.deepEqual(body.passthrough, ['FROM_ENV']);
  });
});

/** POST with an explicit Origin (fetch forbids setting it); resolves the status. */
function postWithOrigin(base, path, origin) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, method: 'POST', path, headers: { Origin: origin } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('the CLI translates repeated --allowed-origins into the server Origin allowlist', { skip }, async () => {
  await withCli(
    ['--allowed-origins', 'https://a.example', '--allowed-origins', 'https://b.example'],
    {},
    async (base) => {
      // 403 = rejected by the Origin check; anything else got past it.
      assert.notEqual(await postWithOrigin(base, '/api/nope', 'https://a.example'), 403);
      assert.notEqual(await postWithOrigin(base, '/api/nope', 'https://b.example'), 403);
      assert.equal(await postWithOrigin(base, '/api/nope', 'https://evil.example'), 403);
    },
  );
});

test('OMNITERM_ALLOWED_ORIGINS reaches the server through the CLI and wins', { skip }, async () => {
  await withCli(
    ['--allowed-origins', 'https://flag.example'],
    { OMNITERM_ALLOWED_ORIGINS: 'https://env.example' },
    async (base) => {
      assert.notEqual(await postWithOrigin(base, '/api/nope', 'https://env.example'), 403);
      assert.equal(await postWithOrigin(base, '/api/nope', 'https://flag.example'), 403);
    },
  );
});

test('the CLI forwards --allowed-roots so the folder picker can reach outside $HOME', { skip }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-cli-root-'));
  const browse = (base) => fetch(`${base}/api/browse?path=${encodeURIComponent(root)}`);
  try {
    await withCli([], {}, async (base) => assert.equal((await browse(base)).status, 403));
    await withCli(['--allowed-roots', root], {}, async (base) => {
      const res = await browse(base);
      assert.equal(res.status, 200);
      // Going up from the extra root leaves the allowlist, so no ".." is offered.
      assert.equal((await res.json()).parent, null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
