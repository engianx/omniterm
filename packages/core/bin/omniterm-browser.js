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

const ARGV = process.argv.slice(2);
// `--close` (alias `--kill`) shuts the shim's browser down. Without it there is
// no supported way to clear a stuck instance: the shim otherwise accepts only a
// URL, so a browser that has gone bad can only be cleaned up by hand-killing the
// pid recorded in SingletonLock.
const CLOSE_REQUESTED = ARGV.some((a) => a === '--close' || a === '--kill');
const URL_ARG = ARGV.find((a) => !a.startsWith('--')) || 'about:blank';
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

/**
 * Ask a running browser to open a tab, over CDP's HTTP endpoint.
 *
 * Works headed or headless, which is the whole point — Chrome's singleton IPC
 * does not. Modern Chrome requires PUT on /json/new and answers GET with 405;
 * older builds only accept GET, so try PUT first and fall back.
 *
 * Returns true only if the browser actually accepted the tab.
 */
async function openTabViaCdp(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  for (const method of ['PUT', 'GET']) {
    try {
      const res = await fetch(endpoint, { method });
      if (res.ok) return true;
      // 405 means this Chrome wants the other verb; anything else is a real
      // refusal and retrying with GET would just repeat it.
      if (res.status !== 405) {
        console.error(`[omniterm-browser] /json/new ${method} -> ${res.status} ${res.statusText}`);
        return false;
      }
    } catch (err) {
      console.error(`[omniterm-browser] /json/new ${method} failed: ${String(err)}`);
      return false;
    }
  }
  return false;
}

/**
 * Stop the browser this shim owns and clear the singleton markers it leaves.
 *
 * Kills the pid recorded in SingletonLock, NOT the pid registered earlier:
 * Chrome re-execs on macOS and the registered pid is not the live browser, so
 * killing that one leaks the real process (see AGENTS.md).
 *
 * Also deregisters any registry entry pointing at the port we just killed —
 * otherwise the tab's panel keeps listing a browser whose CDP is dead, which is
 * indistinguishable in the UI from a live one.
 */
async function closeExistingBrowser(ownerPid) {
  let deadPort = null;
  try {
    deadPort = (await readDevToolsActivePort(1_000)).port;
  } catch {}

  // SIGTERM first so Chrome can flush its profile, then SIGKILL if it will not
  // go. A graceful headless shutdown can outlast any grace period worth waiting
  // — measured at over 20s on macOS under a minimal environment — and a `close`
  // that leaves the browser running is worse than an unclean exit, because the
  // next call takes the warm path against it.
  // Only ESRCH means the process is gone. EPERM means it EXISTS but belongs to
  // another uid — the case readSingleton() above already calls out as common in
  // containers and rootless setups. Treating any throw as death is how a close
  // reports success over a browser that is still running.
  const isGone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return Boolean(err) && err.code === 'ESRCH';
    }
  };

  const GRACE_MS = 5_000;
  let died = !Number.isFinite(ownerPid);
  if (Number.isFinite(ownerPid)) {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(ownerPid, signal);
      } catch (err) {
        // ESRCH here means it died before we signalled; anything else (EPERM)
        // means we cannot signal it, so escalating will not help either.
        if (err && err.code === 'ESRCH') died = true;
        break;
      }
      const deadline = Date.now() + GRACE_MS;
      while (Date.now() < deadline) {
        if (isGone(ownerPid)) {
          died = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (died) break;
    }
  }
  if (!died) {
    // Do NOT clear the markers: they are the only record of the owner, and a
    // caller that thinks the browser is gone will cold-start a second Chrome
    // against the same profile.
    return false;
  }
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    try {
      unlinkSync(path.join(UDD, f));
    } catch {}
  }
  if (deadPort) await deregisterPort(deadPort);
  return true;
}

/** Remove registry entries whose CDP endpoint is the port we just shut down. */
async function deregisterPort(port) {
  if (!REGISTRY_URL) return;
  const base = REGISTRY_URL.replace(/\/registry$/, '');
  try {
    const res = await fetch(`${base}/browsers`);
    if (!res.ok) return;
    const { browsers = [] } = await res.json();
    for (const b of browsers) {
      if (typeof b?.browserCdpUrl === 'string' && b.browserCdpUrl.includes(`:${port}/`)) {
        await fetch(`${REGISTRY_URL}/browsers/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
        console.error(`[omniterm-browser] deregistered stale browser id=${b.id}`);
      }
    }
  } catch {
    // Best effort: a browser we cannot deregister is cosmetic, and failing the
    // close over it would be worse than leaving the entry.
  }
}

async function main() {
  mkdirSync(UDD, { recursive: true });

  if (CLOSE_REQUESTED) {
    const owner = readSingleton();
    if (!owner) {
      console.error('[omniterm-browser] no running browser to close');
      return;
    }
    const closed = await closeExistingBrowser(owner.pid);
    if (!closed) {
      throw new Error(
        `Could not stop the browser (pid ${owner.pid}); it survived SIGTERM and SIGKILL.`,
      );
    }
    console.error(`[omniterm-browser] closed browser pid=${owner.pid}`);
    return;
  }

  const chromeBinary = findChromeBinary();
  const existing = readSingleton();

  if (existing) {
    // Warm path: ask the RUNNING browser to open the tab over CDP.
    //
    // This used to spawn a second Chrome and rely on Chrome's singleton IPC to
    // deliver the URL into the existing instance. That only works for a headed
    // Chrome. Headless Chrome does not service the singleton handoff at all, so
    // on any display-less box — which is every Linux box, and the default since
    // the headless fix — the second process delivered nothing, the shim read the
    // existing DevToolsActivePort, and reported `registered` for a browser that
    // never opened the page. Measured: a healthy headless instance sitting at one
    // page stayed at one page across repeated calls, so $BROWSER worked exactly
    // once per Chrome and every later call was a silent no-op.
    //
    // CDP is the same operation without the guesswork, and it behaves the same
    // headed or headless. If it fails, fall through to a cold start rather than
    // registering a browser we never actually reached.
    const { port, wsPath } = await readDevToolsActivePort();
    const opened = await openTabViaCdp(port, URL_ARG);
    if (opened) {
      await postRegistration(`ws://127.0.0.1:${port}${wsPath}`, existing.pid);
      return;
    }
    console.error(
      '[omniterm-browser] the running browser did not accept a new tab; starting a fresh one',
    );
    // Must not fall through when the close failed: cold-starting a second Chrome
    // against a user-data-dir the first one still holds is the exact hazard
    // closeExistingBrowser's return value exists to prevent.
    if (!(await closeExistingBrowser(existing.pid))) {
      throw new Error(
        `The running browser (pid ${existing.pid}) refused a new tab and could not be stopped; ` +
          'not starting a second browser against the same user-data-dir.',
      );
    }
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
