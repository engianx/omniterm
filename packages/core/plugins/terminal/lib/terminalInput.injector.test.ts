// Integration byte-check: runs the REAL injector module (terminalInput.ts)
// inside a headless Chromium page driving a live ttyd + xterm.js, and asserts
// the exact bytes xterm forwards to the PTY (via term.onData) under both normal
// and application-cursor (DECCKM) modes, plus that compose never bracket-wraps.
//
// This guards against drift the pure unit tests can't see — e.g. ttyd shipping
// an xterm version where term.input()/term.modes change shape. It SKIPS cleanly
// when ttyd or the Chromium binary isn't available (so `pnpm test` stays green
// in environments without them, e.g. CI without ttyd), and runs for real where
// they exist (local dev).
//
// NOTE on the `__name` shim inside the page.evaluate callback below: tsx (this
// file's runner) transpiles the callback with esbuild `keepNames`, which rewrites
// the named inner arrows to call a `__name` helper that lives in this module's
// scope but NOT in the browser page where the callback runs. We define an identity
// `__name` on the page's globalThis so those calls resolve. (This is about how the
// TEST is transpiled — not the esbuild `build()` of the module under test below.)

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Type-only (erased at runtime). esbuild + playwright-core are devDependencies
// of this package; they are still dynamically imported inside the test, after
// the skip guard, so a machine without them (or without the Chromium binary
// playwright-core downloads separately) skips cleanly instead of throwing at
// module load.
import type { Browser } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(__dirname, 'terminalInput.ts');
const PORT = 7793;

function ttydAvailable(): boolean {
  try {
    execFileSync('which', ['ttyd'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`ttyd never listened on ${port}`));
        else setTimeout(tick, 50);
      });
    };
    tick();
  });
}

test('injector delivers correct bytes through real ttyd + xterm.js', async (t) => {
  if (!ttydAvailable()) {
    t.skip('ttyd not installed');
    return;
  }
  // Resolve the runtime deps lazily; a missing one skips, not crashes.
  let chromium: typeof import('playwright-core').chromium;
  let build: typeof import('esbuild').build;
  try {
    ({ chromium } = await import('playwright-core'));
    ({ build } = await import('esbuild'));
  } catch {
    t.skip('playwright-core / esbuild not installed');
    return;
  }
  let chromiumPath = '';
  try {
    chromiumPath = chromium.executablePath();
  } catch {
    /* not configured */
  }
  if (!chromiumPath || !existsSync(chromiumPath)) {
    t.skip('chromium (playwright) not installed');
    return;
  }

  {
    // Bundle the real module as an IIFE exposing globalThis.TI.
    const bundled = await build({
      entryPoints: [MODULE],
      bundle: true,
      format: 'iife',
      globalName: 'TI',
      write: false,
      platform: 'browser',
    });
    const TI_SRC = bundled.outputFiles[0].text;

    let ttyd: ChildProcess | undefined;
    let browser: Browser | undefined;
    try {
      ttyd = spawn('ttyd', ['-p', String(PORT), '-i', '127.0.0.1', '--writable', 'bash'], {
        stdio: 'ignore',
      });
      await waitForPort(PORT);

      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!(window as unknown as { term?: unknown }).term, null, {
        timeout: 8000,
      });
      await page.addScriptTag({ content: TI_SRC });
      await page.waitForFunction(() => !!(window as unknown as { TI?: unknown }).TI, null, {
        timeout: 4000,
      });

      const out = await page.evaluate(async () => {
        // tsx transpiles this callback with esbuild keepNames, which rewrites the
        // named inner arrows below to call a `__name` helper that only exists in
        // the test module scope — not here in the page. Shim it so those calls
        // resolve when the function runs in the browser.
        (globalThis as any).__name ??= (f: any) => f;
        const TI = (window as any).TI;
        const t = (window as any).term;
        const cap: string[] = [];
        const disp = t.onData((d: string) => cap.push(d));
        const reset = () => {
          cap.length = 0;
        };
        const flush = () => cap.join('');
        const byId = (id: string) => TI.KEY_BAR.find((k: any) => k.id === id);
        // Poll for an actual mode flip instead of a fixed delay — term.write()
        // processes asynchronously, so a slow/loaded runner could miss a
        // hardcoded timeout. Bounded so a never-flip can't hang the test.
        const waitFor = (pred: () => boolean) =>
          new Promise<void>((res) => {
            const started = performance.now();
            const tick = () =>
              pred() || performance.now() - started > 2000 ? res() : setTimeout(tick, 5);
            tick();
          });
        const r: Record<string, unknown> = {};

        reset();
        TI.sendDescriptor(window, byId('esc'));
        r.esc = flush();
        reset();
        TI.sendDescriptor(window, byId('tab'));
        r.tab = flush();
        reset();
        TI.sendDescriptor(window, byId('ctrl-c'));
        r.ctrlC = flush();
        reset();
        TI.sendControlLetter(window, 'r');
        r.ctrlR = flush();
        reset();
        TI.sendDescriptor(window, byId('up'));
        r.upNormal = flush();

        t.write('\x1b[?1h'); // enable application cursor keys (DECCKM)
        await waitFor(() => t.modes.applicationCursorKeysMode === true);
        r.appCursorMode = t.modes.applicationCursorKeysMode;
        reset();
        TI.sendDescriptor(window, byId('up'));
        r.upApp = flush();
        t.write('\x1b[?1l');

        t.write('\x1b[?2004h'); // enable bracketed paste
        await waitFor(() => t.modes.bracketedPasteMode === true);
        r.bracketedPasteMode = t.modes.bracketedPasteMode;
        reset();
        TI.sendComposed(window, 'abc', false);
        r.composeNoRun = flush();
        reset();
        TI.sendComposed(window, 'ls -la', true);
        r.composeRun = flush();
        t.write('\x1b[?2004l');
        disp.dispose();
        return r;
      });

      assert.strictEqual(out.esc, '\x1b', 'Esc');
      assert.strictEqual(out.tab, '\x09', 'Tab');
      assert.strictEqual(out.ctrlC, '\x03', 'Ctrl-C');
      assert.strictEqual(out.ctrlR, '\x12', 'Ctrl-R (sticky letter)');
      assert.strictEqual(out.upNormal, '\x1b[A', 'arrow up, normal cursor mode');
      assert.strictEqual(out.appCursorMode, true, 'DECCKM reflected in term.modes');
      assert.strictEqual(out.upApp, '\x1bOA', 'arrow up, application cursor mode');
      assert.strictEqual(out.bracketedPasteMode, true, 'bracketed-paste reflected in term.modes');
      assert.strictEqual(out.composeNoRun, 'abc', 'compose sends raw text (no bracket wrap)');
      assert.strictEqual(out.composeRun, 'ls -la\r', 'compose with run appends CR');
    } finally {
      if (browser) await browser.close();
      if (ttyd?.pid) {
        try {
          process.kill(ttyd.pid);
        } catch {
          /* already gone */
        }
      }
    }
  }
});
