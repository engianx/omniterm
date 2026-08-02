#!/usr/bin/env node
/**
 * omniterm-browser — system browser shim for omniterm tabs.
 *
 * When an agent inside an omniterm tab opens a URL (gcloud auth login,
 * `gh auth login --web`, npm OAuth flows, anything that respects $BROWSER
 * or xdg-open), this script:
 *
 *   1. Launches Chrome against a DEDICATED user-data-dir (NOT the user's
 *      personal profile) with --remote-debugging-port=0 the first time.
 *   2. Reads `<UDD>/DevToolsActivePort` to discover the CDP WebSocket URL.
 *   3. POSTs that URL to the tab's registry (OMNITERM_BROWSER_REGISTRY_URL),
 *      where the omniterm UI picks it up and offers a remote DevTools view.
 *
 * Subsequent invocations (same UDD, Chrome still alive) defer the URL into
 * the existing instance via Chrome's singleton-IPC handoff — no second
 * process is spawned, but we still POST the existing CDP URL so the calling
 * tab's panel surfaces it. The registry de-dupes by cdpUrl, so re-POSTing
 * is harmless within a tab and gives each cross-tab caller its own entry.
 *
 * Why a dedicated UDD: keeps real-account cookies / passwords out of any
 * profile that has CDP exposed. Personal Chrome on the laptop is never
 * touched by this wrapper.
 *
 * No OMNITERM_BROWSER_REGISTRY_URL? We still launch Chrome (so the agent's flow
 * doesn't hang), but warn — the user won't see the browser remotely.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'about:blank';
const REGISTRY_URL = (process.env.OMNITERM_BROWSER_REGISTRY_URL || '').replace(/\/$/, '');
const UDD =
  process.env.OMNITERM_BROWSER_UDD || path.join(homedir(), '.omniterm', 'browser-profile');
const HEADLESS = process.env.OMNITERM_BROWSER_HEADLESS === '1';

function findChromeBinary() {
  if (process.env.OMNITERM_CHROME_PATH) return process.env.OMNITERM_CHROME_PATH;
  const candidates =
    platform() === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];
  for (const p of candidates) if (existsSync(p)) return p;
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
      if (found) return found;
    } catch {}
  }
  throw new Error('No Chrome/Chromium binary found. Set OMNITERM_CHROME_PATH=/path/to/chrome.');
}

// Chrome writes a SingletonLock symlink in the UDD when it owns the profile.
// The symlink TARGET is a marker (`<hostname>-<pid>`), not a real file path —
// so `existsSync` follows the symlink, fails to find the marker, and returns
// false even when the lock exists. We must lstat the symlink itself.
//
// We ALSO verify the encoded pid is actually alive: if Chrome was SIGKILL'd
// (or otherwise crashed), the lock survives but is stale. Trusting a stale
// lock makes the warm path spawn Chrome without `--remote-debugging-port`
// and the spawned Chrome silently becomes the new owner with no CDP — so
// every subsequent registration points at a port nothing is listening on.
// When the lock is stale, we remove it and signal the caller to cold-start.
function readSingleton() {
  const lockPath = path.join(UDD, 'SingletonLock');
  let isSymlink = false;
  try {
    isSymlink = lstatSync(lockPath).isSymbolicLink();
  } catch {
    return null;
  }
  if (!isSymlink) return null;
  let pid;
  try {
    const target = readlinkSync(lockPath);
    const m = target.match(/-(\d+)$/);
    if (m) pid = parseInt(m[1], 10);
  } catch {
    return null;
  }
  if (pid === undefined) return null;
  // Liveness check — if Chrome's gone, the lock is a corpse. Distinguish
  // ESRCH (pid truly doesn't exist) from EPERM (exists but owned by another
  // uid — common in containers / rootless setups). Treat EPERM as alive,
  // since something is holding the pid; only unlink on ESRCH.
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err && err.code !== 'ESRCH') return { pid };
    try {
      unlinkSync(lockPath);
    } catch {}
    return null;
  }
  return { pid };
}

async function readDevToolsActivePort(timeoutMs = 30_000) {
  const filePath = path.join(UDD, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      const [portLine, wsPath] = raw.split('\n');
      const port = parseInt(portLine, 10);
      if (
        Number.isFinite(port) &&
        port > 0 &&
        typeof wsPath === 'string' &&
        wsPath.startsWith('/')
      ) {
        return { port, wsPath };
      }
      lastErr = `unexpected contents: ${JSON.stringify(raw)}`;
    } catch (err) {
      lastErr = err && err.code === 'ENOENT' ? 'file not yet written' : String(err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${filePath} (${lastErr})`);
}

async function postRegistration(cdpUrl, pid) {
  if (!REGISTRY_URL) {
    console.error(
      '[omniterm-browser] OMNITERM_BROWSER_REGISTRY_URL not set — browser launched but not registered. ' +
        'Run inside an omniterm tab to get remote access.',
    );
    return;
  }
  try {
    const res = await fetch(`${REGISTRY_URL}/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cdpUrl, label: 'omniterm-browser', pid }),
    });
    if (!res.ok) {
      console.error(`[omniterm-browser] registry POST failed: ${res.status} ${res.statusText}`);
      return;
    }
    const data = await res.json();
    console.error(
      `[omniterm-browser] registered ${data.deduped ? '(deduped) ' : ''}id=${data.id} cdp=${cdpUrl}`,
    );
  } catch (err) {
    console.error(`[omniterm-browser] registry POST error: ${String(err)}`);
  }
}

function chromeArgs(includeDebugFlags) {
  const args = [`--user-data-dir=${UDD}`];
  if (includeDebugFlags) {
    args.push(
      '--remote-debugging-port=0',
      // Restrict to a single explicit loopback Origin instead of `*`. The
      // omniterm WS proxy SETS this Origin on every forwarded handshake
      // (see handleCdpUpgrade in tabRegistry.ts), so legitimate traffic
      // matches. A malicious page in the user's real browser trying to
      // drive-by ws://127.0.0.1:<cdp-port> would carry its own Origin
      // (e.g. https://evil.com) and be rejected.
      '--remote-allow-origins=http://127.0.0.1',
    );
  }
  if (HEADLESS) args.push('--headless=new');
  args.push(URL_ARG);
  return args;
}

async function main() {
  mkdirSync(UDD, { recursive: true });
  const chromeBinary = findChromeBinary();
  const existing = readSingleton();

  if (existing) {
    // Warm path: hand the URL off via Chrome's singleton IPC. The first
    // process Chrome sees with this UDD owns the lock; subsequent launches
    // (us, right now) just deliver the URL as a new tab in the existing
    // instance. CDP stays on whatever the cold-start invocation enabled.
    spawn(chromeBinary, chromeArgs(false), {
      detached: true,
      stdio: 'ignore',
    }).unref();
    const { port, wsPath } = await readDevToolsActivePort();
    await postRegistration(`ws://127.0.0.1:${port}${wsPath}`, existing.pid);
    return;
  }

  // Cold path: own the UDD, enable CDP, then register. Chrome doesn't
  // delete DevToolsActivePort on exit, so a stale file from a previous
  // Chrome would otherwise be read instantaneously by readDevToolsActivePort
  // before the new Chrome rewrites it — registering the stale port and
  // making the DevTools view fail to connect. Delete first so the poll
  // is forced to wait for the new contents.
  try {
    unlinkSync(path.join(UDD, 'DevToolsActivePort'));
  } catch {}
  const child = spawn(chromeBinary, chromeArgs(true), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const { port, wsPath } = await readDevToolsActivePort();
  await postRegistration(`ws://127.0.0.1:${port}${wsPath}`, child.pid);
}

main().catch((err) => {
  console.error(`[omniterm-browser] fatal: ${String(err)}`);
  process.exit(1);
});
