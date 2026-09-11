import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The PATH shims (`open`, `xdg-open`) live in @omniterm/core/bin and only reach
// the published tarball because scripts/package.sh copies them into
// apps/omniterm/bin. They also cannot go in package.json `bin` — that would
// shadow the system `open`/`xdg-open` for the whole machine — so pnpm pack
// normalizes them to 0644 and the package's `postinstall` is the only thing
// that makes them executable again.
//
// A new shim that misses either step is silently dead in the published package
// and no runtime test can see it, because the repo checkout has the file with
// its source mode. Hence this guard: every non-source file in core/bin must be
// copied by package.sh, and every one not in the `bin` map must be chmod'd by
// postinstall.

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const coreBin = path.resolve(appDir, '../../packages/core/bin');

const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf-8'));
const packageSh = readFileSync(path.join(here, 'package.sh'), 'utf-8');
const gitignore = readFileSync(path.join(appDir, '.gitignore'), 'utf-8');

// bin/omniterm.js is apps/omniterm's own source, not copied from core.
const staged = readdirSync(coreBin).filter((f) => f !== 'omniterm.js');
const binMapTargets = new Set(Object.values(pkg.bin ?? {}));

test('every @omniterm/core bin shim is staged into the published bin/', () => {
  assert.ok(staged.length > 0, 'no shims found in packages/core/bin');
  for (const name of staged) {
    assert.ok(
      packageSh.includes(`"$CORE_DIR/bin/${name}"`),
      `scripts/package.sh does not copy bin/${name} — it would be missing from the tarball`,
    );
    assert.ok(
      gitignore.includes(`bin/${name}`),
      `.gitignore does not list bin/${name} — the build output would be committed`,
    );
  }
});

test('a staged shim is either in the bin map or chmod+x by postinstall', () => {
  for (const name of staged) {
    if (binMapTargets.has(`bin/${name}`)) continue; // npm makes bin-map entries 0755
    assert.ok(
      (pkg.scripts?.postinstall ?? '').includes(`bin/${name}`),
      `bin/${name} is not in package.json "bin" and postinstall does not chmod it — ` +
        'it would install as 0644 and fail to run as a PATH shim',
    );
  }
});

test('the open shim is one of the staged shims', () => {
  // Pins issue #25 at the packaging layer: on macOS `open <url>` is the only
  // interception path, so losing this file loses the feature entirely.
  assert.ok(staged.includes('open'), 'packages/core/bin/open is missing');
});
