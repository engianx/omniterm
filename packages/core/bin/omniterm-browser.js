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
// Headless is the only thing that works without a display, and the hosted Linux
// box has none. A headed Chrome there dies at
//   ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc] Missing X server or $DISPLAY
//   ERROR:ui/aura/env.cc] The platform failed to initialize.  Exiting.
// BEFORE it writes DevToolsActivePort, so the only symptom the caller sees is
// this script's 30s poll timing out. Default to headless when X/Wayland is
// absent on Linux; `OMNITERM_BROWSER_HEADLESS=0` forces headed for anyone who
// has a display we failed to detect, and `=1` still forces headless anywhere.
function displayAvailable() {
  // macOS and Windows draw without X/Wayland, so absence means nothing there.
  if (platform() !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
const FORCE_HEADLESS = process.env.OMNITERM_BROWSER_HEADLESS === '1';
const FORCE_HEADED = process.env.OMNITERM_BROWSER_HEADLESS === '0';
// The heuristic is only a fast path. `looksLikeMissingDisplay` below is the
// actual guarantee: whatever we guess, a Chrome that dies for want of a display
// is retried headless. That covers the cases a guess cannot -- DISPLAY set but
// pointing at a dead server, an X socket that vanished, a platform we have not
// thought about -- without this script having to model anyone's environment.
const HEADLESS_GUESS = FORCE_HEADLESS || (!FORCE_HEADED && !displayAvailable());

/** Chrome's own words when it cannot reach a display, on any platform. */
function looksLikeMissingDisplay(message) {
  return (
    /Missing X server or \$DISPLAY/i.test(message) ||
    /The platform failed to initialize/i.test(message) ||
    /cannot open display/i.test(message)
  );
}

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

function chromeArgs(includeDebugFlags, headless = HEADLESS_GUESS) {
  // --no-first-run: without it, a brand-new UDD boots into Chrome's
  // "Sign in to Chrome" first-run flow (chrome://intro/) instead of a
  // normal tab. That target (and whatever it opens next, e.g. a Google
  // sign-in tab) has no backing native BrowserWindow — Browser.getWindowForTarget
  // 404s on it — so Target.closeTarget/Page.close/`/json/close` all report
  // success without ever actually closing it, leaving a permanently stuck,
  // unclosable tab in the omniterm browser panel.
  // --no-default-browser-check: same spirit — skip a promo prompt this
  // dedicated, non-interactive-by-default profile has no use for.
  const args = [
    `--user-data-dir=${UDD}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
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
  if (headless) args.push('--headless=new');
  args.push(URL_ARG);
  return args;
}

/**
 * Spawn Chrome so a launch failure is reported as Chrome's own words.
 *
 * With `stdio: 'ignore'` Chrome's stderr went to the void, so every failure to
 * start — no X server, a denied sandbox syscall, a bad flag — surfaced only as
 * `readDevToolsActivePort` timing out after 30 seconds with "file not yet
 * written". That is indistinguishable from a slow boot and says nothing about
 * the cause. Chrome's diagnostics are precise; the only reason they were not
 * actionable is that nothing read them.
 *
 * Chrome stays detached and unref'd (it must outlive this process), so stderr
 * is captured into a buffer and the pipe is unref'd too. If the child exits
 * before it writes DevToolsActivePort, the returned promise rejects
 * immediately with that output instead of waiting out the poll.
 */
function spawnChrome(chromeBinary, args) {
  const child = spawn(chromeBinary, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    // Cap it: a chatty Chrome should not grow this buffer without bound.
    if (stderr.length < 8192) stderr += String(chunk);
  });
  child.stderr?.unref();
  const exited = new Promise((_, reject) => {
    child.on('exit', (code, signal) => {
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = stderr.trim();
      reject(
        new Error(
          `Chrome exited before it was ready (${how}).` +
            (detail ? `\n--- chrome stderr ---\n${detail}` : ' Chrome printed nothing on stderr.'),
        ),
      );
    });
    child.on('error', (err) => reject(new Error(`Failed to launch ${chromeBinary}: ${err.message}`)));
  });
  child.unref();
  return { child, exited };
}


/**
 * Cold-start Chrome, retrying headless once if it died for want of a display.
 *
 * The environment heuristic above is a guess; this is what makes the guess
 * safe to be wrong. Chrome tells us precisely why it failed, so we act on that
 * rather than on a prediction about the platform -- which is the only version
 * of this that keeps working in environments nobody here has seen.
 */
async function launchColdWithDisplayFallback(chromeBinary) {
  // Only an unforced headed guess gets a second try: a forced choice is the
  // caller's, and a headless guess has no better fallback to reach for.
  const attempts = HEADLESS_GUESS || FORCE_HEADED ? [HEADLESS_GUESS] : [false, true];
  let lastErr;
  for (const headless of attempts) {
    // Chrome does not delete DevToolsActivePort on exit, so a stale file from a
    // previous run would be read instantly and register a dead port. Clear it
    // before every attempt, including the retry.
    try {
      unlinkSync(path.join(UDD, 'DevToolsActivePort'));
    } catch {}
    const attempt = spawnChrome(chromeBinary, chromeArgs(true, headless));
    try {
      const { port, wsPath } = await Promise.race([readDevToolsActivePort(), attempt.exited]);
      return { port, wsPath, pid: attempt.child.pid };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastErr = err;
      if (headless || !looksLikeMissingDisplay(message)) throw err;
      console.error(
        '[omniterm-browser] no usable display; retrying headless. Chrome said:\n' + message,
      );
    }
  }
  throw lastErr ?? new Error('Chrome could not be started');
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
    const warm = spawnChrome(chromeBinary, chromeArgs(false));
    const { port, wsPath } = await Promise.race([readDevToolsActivePort(), warm.exited]);
    await postRegistration(`ws://127.0.0.1:${port}${wsPath}`, existing.pid);
    return;
  }

  // Cold path: own the UDD, enable CDP, then register. The helper clears any
  // stale DevToolsActivePort before each attempt — see the note there.
  const { port, wsPath, pid } = await launchColdWithDisplayFallback(chromeBinary);
  await postRegistration(`ws://127.0.0.1:${port}${wsPath}`, pid);
}

main().catch((err) => {
  console.error(`[omniterm-browser] fatal: ${String(err)}`);
  process.exit(1);
});
