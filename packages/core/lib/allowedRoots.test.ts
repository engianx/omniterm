import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// allowedRoots() reads settings; point SETTINGS_DIR at a throwaway dir before
// the module loads so the real ~/.omniterm is never read or written.
const SETTINGS_DIR = mkdtempSync(path.join(tmpdir(), 'omniterm-roots-'));
process.env.SETTINGS_DIR = SETTINGS_DIR;
after(() => rmSync(SETTINGS_DIR, { recursive: true, force: true }));

test('parseAllowedRoots splits on commas, trims, normalizes and skips blanks', async () => {
  const { parseAllowedRoots } = await import('./allowedRoots.js');
  assert.deepEqual(parseAllowedRoots(['/home, /srv/data/ ,', '/mnt//x']), ['/home', '/srv/data/', '/mnt/x']);
  assert.deepEqual(parseAllowedRoots([]), []);
});

test('parseAllowedRoots rejects a relative path', async () => {
  const { parseAllowedRoots, AllowedRootsError } = await import('./allowedRoots.js');
  assert.throws(() => parseAllowedRoots(['/home,work']), AllowedRootsError);
});

test('extra roots widen allowedRoots and therefore confinePath', async () => {
  const { allowedRoots, setExtraAllowedRoots } = await import('./allowedRoots.js');
  const { confinePath } = await import('./paths.js');
  const outside = '/omniterm-test-extra-root/sub';
  try {
    assert.equal(confinePath(outside, allowedRoots()), null);
    setExtraAllowedRoots(['/omniterm-test-extra-root']);
    assert.equal(confinePath(outside, allowedRoots()), outside);
    assert.equal(confinePath('/omniterm-test-extra-root-sibling', allowedRoots()), null);
  } finally {
    setExtraAllowedRoots([]);
  }
});
