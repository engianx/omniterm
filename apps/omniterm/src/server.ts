// Standalone omniterm host. Boots with the built-in terminal plugin and any
// plugins passed via `--plugin <path|name>` (repeatable).

import {
  startServer,
  parsePluginSpecs,
  validatePluginModule,
  PluginSpecError,
  type TabTypePlugin,
} from '@omniterm/core';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const requireFromHere = createRequire(import.meta.url);

// --- DevTools frontend for the browser-view panel --------------------------
// By default the panel's inspector is served by the inspected browser itself:
// Chromium exposes its own DevTools frontend on the same port as CDP, and
// core's registry falls back to that per browser when no bundle dir is given
// (see defaultDevtoolsFrontendUrl in packages/core/browserRegistry/tabRegistry.ts).
// So the host ships no DevTools bundle — that would be ~120 MB of vendored
// Chrome DevTools for a frontend the browser already has.
//
// Set OMNITERM_DEVTOOLS_DIR to a DevTools frontend build to override, e.g. a
// customized frontend with extra panels. It is served at /devtools/ and used
// for every registered browser.
let devtoolsBundleDir: string | undefined;
const devtoolsDirOverride = process.env.OMNITERM_DEVTOOLS_DIR?.trim();
if (devtoolsDirOverride) {
  devtoolsBundleDir = path.resolve(devtoolsDirOverride);
  if (!existsSync(path.join(devtoolsBundleDir, 'inspector.html'))) {
    console.error(
      `[omniterm] OMNITERM_DEVTOOLS_DIR=${devtoolsBundleDir} has no inspector.html; ` +
        'falling back to each browser\'s own DevTools frontend.',
    );
    devtoolsBundleDir = undefined;
  }
}

// --- pdf.js (served, not bundled) ------------------------------------------
// The PDF viewer loads pdf.js (lib/worker/viewer/CSS) from `/pdfjs/*` at runtime
// rather than bundling ~2 MB of vendor code into the client. Serve the installed
// package dir. Optional — if pdfjs-dist is absent the PDF viewer degrades to an
// error message rather than taking down boot.
let pdfjsDistDir: string | undefined;
try {
  pdfjsDistDir = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
} catch {
  console.error('[omniterm] pdfjs-dist not found; the in-app PDF viewer will be unavailable.');
}

// --- Plugin loader (--plugin <path|name>, repeatable) ----------------------
// parse + validation live in @omniterm/core (pure + unit-tested); the host owns
// the impure module resolution + dynamic import below, and turns the typed
// PluginSpecError into a `[omniterm] …` message + exit.

/**
 * Resolve a plugin spec to a module URL and import it. Filesystem paths
 * (relative/absolute/`file:`) resolve against the CWD; bare package names
 * resolve CWD-first (the user's project `node_modules`) then host-local — the
 * standard CLI-plugin resolution order.
 */
async function importPluginModule(spec: string): Promise<Record<string, unknown>> {
  const isPath = spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:');
  let url: string;
  if (isPath) {
    const p = spec.startsWith('file:') ? fileURLToPath(spec) : path.resolve(process.cwd(), spec);
    url = pathToFileURL(p).href;
  } else {
    let resolved: string;
    try {
      resolved = createRequire(path.join(process.cwd(), 'noop.js')).resolve(spec);
    } catch {
      resolved = requireFromHere.resolve(spec); // throws → caller reports
    }
    url = pathToFileURL(resolved).href;
  }
  return import(url) as Promise<Record<string, unknown>>;
}

function fail(spec: string | null, reason: string): never {
  console.error(spec ? `[omniterm] --plugin ${spec}: ${reason}` : `[omniterm] ${reason}`);
  process.exit(1);
}

async function loadPlugins(specs: string[]): Promise<TabTypePlugin[]> {
  const plugins: TabTypePlugin[] = [];
  const seenType = new Set<string>();
  for (const spec of specs) {
    let mod: Record<string, unknown>;
    try {
      mod = await importPluginModule(spec);
    } catch (err) {
      fail(spec, `could not resolve/import (${err instanceof Error ? err.message : String(err)})`);
    }
    try {
      plugins.push(validatePluginModule(spec, mod, seenType));
    } catch (err) {
      if (err instanceof PluginSpecError) fail(err.spec ?? spec, err.message);
      throw err;
    }
  }
  return plugins;
}

// --- Boot ------------------------------------------------------------------

const port = Number(process.env.OMNITERM_PORT ?? process.env.PORT) || 17717;
let specs: string[];
try {
  specs = parsePluginSpecs(process.argv.slice(2));
} catch (err) {
  if (err instanceof PluginSpecError) fail(err.spec, err.message);
  throw err;
}
const plugins = await loadPlugins(specs);
await startServer({ port, devtoolsBundleDir, pdfjsDistDir, plugins });
