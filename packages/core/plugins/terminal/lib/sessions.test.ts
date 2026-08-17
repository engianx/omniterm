import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionEnv, buildTabEnv } from './sessions.js';

// Pins the env-leak fix on the tab-env side: the PATH stamped onto a tab
// must be the fixed bootstrap PATH (plus at most the omniterm shim dir),
// NEVER derived from the server's own process.env.PATH — that would carry
// the env of whatever shell launched omniterm into every tab. The login
// shell rebuilds the user's real PATH from profiles on top of this.
test('buildTabEnv stamps a fixed bootstrap PATH, never the server process PATH', () => {
  const env = buildTabEnv('http://127.0.0.1:1/t/x/registry');
  assert.equal(env.OMNITERM_BROWSER_REGISTRY_URL, 'http://127.0.0.1:1/t/x/registry');
  const entries = env.PATH.split(':');
  assert.deepEqual(entries.slice(-6), [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]);
  // At most one extra entry, prepended: the omniterm shim bin dir (present
  // only when the browser shim resolved on disk).
  assert.ok(entries.length <= 7, `unexpected PATH entries: ${env.PATH}`);
  if (entries.length === 7) {
    assert.ok(env.BROWSER, 'a shim-dir PATH prepend implies BROWSER is set');
  }
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
