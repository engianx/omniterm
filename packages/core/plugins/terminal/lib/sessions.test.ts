import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionEnv, buildTabEnv } from './sessions.js';

// Pins the env-leak fix on the tab-env side: the PATH stamped onto a tab must
// be exactly the fixed bootstrap PATH, NEVER derived from the server's own
// process.env.PATH — that would carry the env of whatever shell launched
// omniterm into every tab. The login shell rebuilds the user's real PATH from
// profiles on top of this, and the clean-env wrapper adds the shim dir after it.
test('buildTabEnv stamps a fixed bootstrap PATH, never the server process PATH', () => {
  const env = buildTabEnv('http://127.0.0.1:1/t/x/registry');
  assert.equal(env.OMNITERM_BROWSER_REGISTRY_URL, 'http://127.0.0.1:1/t/x/registry');
  assert.deepEqual(env.PATH.split(':'), [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]);
});

// Precedence for a caller-supplied per-terminal environment (spec 001 FR-012 /
// FR-013): the caller wins over omniterm's own tab defaults. A reversed spread
// would silently ignore what the caller asked for, and every other test in this
// feature would still pass — hence pinning it here.
test('buildSessionEnv layers caller values over the tab env, caller wins', () => {
  const registryUrl = 'http://127.0.0.1:1/t/x/registry';
  const base = buildTabEnv(registryUrl);

  // No caller env → byte-identical to the tab env.
  assert.deepEqual(buildSessionEnv(registryUrl), base);
  assert.deepEqual(buildSessionEnv(registryUrl, {}), base);

  // Caller adds a name.
  const withCaller = buildSessionEnv(registryUrl, { MY_CONTEXT: 'abc' });
  assert.equal(withCaller.MY_CONTEXT, 'abc');
  assert.equal(withCaller.OMNITERM_BROWSER_REGISTRY_URL, registryUrl);

  // Caller collides with one of omniterm's own: the caller's value is the one used.
  const collided = buildSessionEnv(registryUrl, { PATH: '/caller/bin' });
  assert.equal(collided.PATH, '/caller/bin');
  assert.notEqual(base.PATH, '/caller/bin');
});

// Issue #25: a PATH prepend stamped here cannot survive the pane's login
// profiles (macOS path_helper demotes it behind /usr/bin; many Linux profiles
// drop it), so the clean-env wrapper puts the shim dir on PATH inside the login
// shell instead. It reads the dir from $OMNITERM_BIN_DIR — if buildTabEnv stops
// stamping that name the wrapper's prepend becomes a silent no-op and `open`
// falls back to /usr/bin/open, with no symptom other than the bug coming back.
test('buildTabEnv stamps OMNITERM_BIN_DIR whenever the browser shim is available', () => {
  const env = buildTabEnv('http://127.0.0.1:1/t/x/registry');
  if (!env.BROWSER) return; // shim not on disk in this layout; nothing is stamped
  assert.ok(env.OMNITERM_BIN_DIR, 'BROWSER is stamped but OMNITERM_BIN_DIR is not');
  // BROWSER lives in that same dir — one dir, one source of truth.
  assert.equal(env.BROWSER, `${env.OMNITERM_BIN_DIR}/omniterm-browser.js`);
  // The shim dir must NOT also be prepended here: the wrapper prepends it in
  // the login shell, and doing both only duplicates the entry.
  assert.ok(
    !env.PATH.startsWith(`${env.OMNITERM_BIN_DIR}:`),
    'shim dir is prepended twice (here and in the clean-env wrapper)',
  );
});
