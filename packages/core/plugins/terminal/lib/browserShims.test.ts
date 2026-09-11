import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The PATH-injected shims in @omniterm/core/bin are the only interception
// point for tools that ignore $BROWSER. `xdg-open` covers Linux; `open` covers
// macOS, where /usr/bin/open ignores $BROWSER completely and is the canonical
// way a user or agent opens a URL from a shell (issue #25).
//
// `open` is general-purpose — files, directories, `-a AppName`, `-R`, `-e` —
// so shadowing it is only safe if everything that is not a plain http/https
// URL reaches the real `open` untouched. These tests run the real shim with a
// fake omniterm-browser and a fake real `open`, both recording their argv, so
// both halves of that contract are pinned.
const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin');

interface Invocations {
  /** One entry per omniterm-browser.js call, each the argv it received. */
  browser: string[][];
  /** One entry per real-`open` call. */
  real: string[][];
  /** One entry per call to a decoy `open` the resolver should never pick. */
  decoy: string[][];
  status: number;
  stderr: string;
}

interface Harness {
  run: (args: string[]) => Invocations;
  cleanup: () => void;
}

/**
 * Stage the real shim in its own dir next to a recording omniterm-browser, with
 * a recording `open` one dir further down PATH standing in for /usr/bin/open.
 * Putting the stand-in outside /usr/bin also proves the shim resolves the next
 * `open` on PATH rather than hardcoding one location.
 */
function makeHarness(shimName: string, withRealOpen = true, decoy?: 'symlink' | 'glob'): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'omnitest-shim-'));
  const shimDir = path.join(root, 'shim');
  const sysDir = path.join(root, 'usr-bin');
  const logDir = path.join(root, 'log');
  for (const d of [shimDir, sysDir, logDir]) mkdirSync(d, { recursive: true });
  const shim = path.join(shimDir, shimName);
  writeFileSync(shim, readFileSync(path.join(BIN_DIR, shimName)));
  chmodSync(shim, 0o755);

  // Recorder: one argument per line, a blank line per invocation.
  const recorder = (logFile: string) =>
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${logFile}; done\nprintf '\\n' >> ${logFile}\n`;
  const browserLog = path.join(logDir, 'browser.log');
  const realLog = path.join(logDir, 'real.log');
  const decoyLog = path.join(logDir, 'decoy.log');
  const recorders: (readonly [string, string])[] = [
    [path.join(shimDir, 'omniterm-browser.js'), browserLog],
  ];
  if (withRealOpen) recorders.push([path.join(sysDir, 'open'), realLog]);
  for (const [file, log] of recorders) {
    writeFileSync(file, recorder(log));
    chmodSync(file, 0o755);
  }

  // Extra PATH entries placed AHEAD of the stand-in real `open`, to exercise
  // the two ways the resolver could pick the wrong candidate.
  const decoyDirs: string[] = [];
  if (decoy === 'symlink') {
    // The shim itself, reachable under a second name/directory. If the
    // resolver does not recognise it as itself it execs itself forever.
    const d = path.join(root, 'decoy');
    mkdirSync(d, { recursive: true });
    symlinkSync(path.join(shimDir, shimName), path.join(d, 'open'));
    decoyDirs.push(d);
  }
  if (decoy === 'glob') {
    // A PATH entry containing a bracket expression, plus a directory that the
    // expression MATCHES holding a different `open`. `[Tools]` matches exactly
    // one of T/o/l/s, so `My [Tools]` expands to `My T` — and only if the
    // resolver globs. The literal entry is empty, so:
    //   globbing disabled -> literal dir has no `open`, scan reaches the real one
    //   globbing enabled  -> field expands to `My T/bin`, decoy wins
    // An unmatched glob would be left unchanged by POSIX, which is why the
    // matching decoy has to exist for this test to discriminate at all.
    mkdirSync(path.join(root, 'My [Tools]', 'bin'), { recursive: true });
    const hit = path.join(root, 'My T', 'bin');
    mkdirSync(hit, { recursive: true });
    writeFileSync(path.join(hit, 'open'), recorder(decoyLog));
    chmodSync(path.join(hit, 'open'), 0o755);
    decoyDirs.push(path.join(root, 'My [Tools]', 'bin'));
  }
  // With no stand-in, PATH must not reach the HOST's /usr/bin/open either, or
  // the Linux "no system open" case would pass for the wrong reason on macOS.
  const extraPath = withRealOpen ? '/usr/bin:/bin' : path.join(root, 'empty');

  function readLog(file: string): string[][] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
      .split('\n\n')
      .filter((block) => block !== '')
      .map((block) => block.split('\n').filter((l) => l !== ''));
  }

  return {
    run(args) {
      rmSync(browserLog, { force: true });
      rmSync(realLog, { force: true });
      rmSync(decoyLog, { force: true });
      let status = 0;
      let stderr = '';
      try {
        stderr = execFileSync(shim, args, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          // A resolver that picks itself execs in a loop forever. Cap it so the
          // regression surfaces as a fast failure rather than a hung CI job.
          timeout: 15_000,
          env: {
            PATH: [shimDir, ...decoyDirs, sysDir, extraPath].filter(Boolean).join(':'),
            HOME: root,
          },
        });
      } catch (err) {
        const e = err as { status?: number; stderr?: Buffer | string };
        status = e.status ?? 1;
        stderr = String(e.stderr ?? '');
      }
      return {
        browser: readLog(browserLog),
        real: readLog(realLog),
        decoy: readLog(decoyLog),
        status,
        stderr,
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('bin/open exists and is executable — macOS has no other interception path', () => {
  const shim = path.join(BIN_DIR, 'open');
  assert.ok(existsSync(shim), 'bin/open is missing: `open <url>` on macOS reaches nothing');
  assert.ok(
    readFileSync(shim, 'utf-8').startsWith('#!'),
    'bin/open needs a shebang to run as a PATH shim',
  );
});

test('open shim: a single http/https URL goes to omniterm-browser, never to the real open', () => {
  const h = makeHarness('open');
  try {
    for (const url of ['https://google.com', 'http://127.0.0.1:3000/x?a=b#c']) {
      const r = h.run([url]);
      assert.deepEqual(r.browser, [[url]], `URL not forwarded to omniterm-browser: ${url}`);
      assert.deepEqual(r.real, [], `URL leaked to the real open: ${url}`);
      assert.equal(r.status, 0);
    }
  } finally {
    h.cleanup();
  }
});

test('open shim: several URLs each reach omniterm-browser', () => {
  const h = makeHarness('open');
  try {
    const r = h.run(['https://a.test/', 'https://b.test/']);
    assert.deepEqual(r.browser, [['https://a.test/'], ['https://b.test/']]);
    assert.deepEqual(r.real, []);
  } finally {
    h.cleanup();
  }
});

test('open shim: anything that is not an http/https URL passes through untouched', () => {
  const h = makeHarness('open');
  try {
    // Files, directories, app launches, reveal-in-Finder, editor, a non-web
    // scheme, and a URL *behind* a flag: all of these are the real `open`'s
    // job and must not be swallowed.
    const cases: string[][] = [
      ['README.md'],
      ['.'],
      ['/tmp'],
      ['-a', 'Safari', 'https://google.com'],
      ['-R', 'README.md'],
      ['-e', 'notes.txt'],
      ['mailto:someone@example.com'],
      ['file:///etc/hosts'],
      ['-n', '-a', 'Google Chrome'],
    ];
    for (const args of cases) {
      const r = h.run(args);
      assert.deepEqual(r.real, [args], `not passed through: open ${args.join(' ')}`);
      assert.deepEqual(r.browser, [], `wrongly intercepted: open ${args.join(' ')}`);
    }
  } finally {
    h.cleanup();
  }
});

test('open shim: a bare `open` with no arguments reaches the real open', () => {
  const h = makeHarness('open');
  try {
    const r = h.run([]);
    assert.deepEqual(r.real, [[]]);
    assert.deepEqual(r.browser, []);
  } finally {
    h.cleanup();
  }
});

test('xdg-open shim: still forwards every argument to omniterm-browser', () => {
  const h = makeHarness('xdg-open');
  try {
    const r = h.run(['https://google.com']);
    assert.deepEqual(r.browser, [['https://google.com']]);
  } finally {
    h.cleanup();
  }
});

test('open shim: with no system open at all, a pass-through fails like the shell would', () => {
  // The normal Linux case: Debian 12, Ubuntu 22.04/24.04 and Fedora 41 ship no
  // `open` (kbd provides only `openvt`), so inside a tab this shim ADDS the
  // command rather than shadowing one. A non-URL argument has nothing to
  // delegate to and must report that the way a shell does — not with a
  // confusing "/usr/bin/open: not found" from an exec of a path that was never
  // going to exist.
  const h = makeHarness('open', false);
  try {
    const r = h.run(['somefile.txt']);
    assert.equal(r.status, 127, 'a missing command must exit 127');
    assert.match(r.stderr, /open: command not found/);
    assert.deepEqual(r.browser, [], 'a file must never be sent to the browser');
  } finally {
    h.cleanup();
  }
});

test('open shim: URLs still work on a system with no `open` of its own', () => {
  // The payoff of the case above: interception must not depend on a system
  // `open` existing, or the shim would be useless on exactly the Linux hosts
  // omniterm most often runs on.
  const h = makeHarness('open', false);
  try {
    const r = h.run(['https://example.com']);
    assert.deepEqual(r.browser, [['https://example.com']]);
    assert.equal(r.status, 0);
  } finally {
    h.cleanup();
  }
});

// --- review round 1 hardening: the pass-through resolver ---------------------

test('open shim: a copy of itself earlier on PATH cannot cause an exec loop', () => {
  // The resolver walks PATH for the "real" open. A symlink to this shim sitting
  // in another PATH directory is the pathological input: matching only on the
  // raw PATH string would miss it and the shim would exec itself forever,
  // hanging the caller. It must skip itself and reach the genuine one.
  const h = makeHarness('open', true, 'symlink');
  try {
    const r = h.run(['README.md']);
    assert.deepEqual(r.real, [['README.md']], 'did not reach the real open');
    assert.deepEqual(r.browser, []);
  } finally {
    h.cleanup();
  }
});

test('open shim: a PATH entry with glob characters is treated literally', () => {
  // `for d in $PATH` splits on IFS and then, without `set -f`, glob-expands each
  // field. The harness plants a directory the expression matches, holding a
  // different `open`; picking it up means the resolver globbed and inspected a
  // directory that was never on PATH.
  const h = makeHarness('open', true, 'glob');
  try {
    const r = h.run(['README.md']);
    assert.deepEqual(r.decoy, [], 'a glob-expanded PATH entry was searched');
    assert.deepEqual(r.real, [['README.md']], 'glob-bearing PATH entry broke the scan');
  } finally {
    h.cleanup();
  }
});
