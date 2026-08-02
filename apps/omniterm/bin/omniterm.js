#!/usr/bin/env node
/**
 * omniterm CLI launcher.
 *
 * Parses CLI flags, verifies ttyd + tmux are installed, and spawns the
 * bundled server entry (standalone/server/server.js). Mirrors the
 * predecessor pattern from the original omniterm app — bin is a thin
 * launcher; standalone/ holds the compiled artifact.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// Read our own version once; passed to the server via OMNITERM_VERSION so
// telemetry can attribute events to a release (best-effort; 'unknown' on failure).
function readVersion() {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version;
  } catch {
    return 'unknown';
  }
}
const APP_VERSION = readVersion();

if (args.includes('--version') || args.includes('-v')) {
  console.log(APP_VERSION);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: omniterm [options]

Options:
  --port <port>        Bind port (default: 17717, env: OMNITERM_PORT)
  --host <host>        Bind address (default: 0.0.0.0, env: OMNITERM_HOST)
  --ttyd-ports <range> Internal port range for terminals (default: 7700-7799)
  --plugin <path|name> Load a plugin by path or package name (repeatable)
  --no-telemetry       Disable telemetry for this run only
  --version, -v        Print version and exit
  --help, -h           Show this help

Commands:
  telemetry status     Show whether anonymous telemetry is on or off
  telemetry off        Disable telemetry persistently (saved in settings)
  telemetry on         Enable telemetry persistently

Environment:
  OMNITERM_DEVTOOLS_DIR  Serve a custom Chrome DevTools frontend build for the
                         browser-view panel. Unset (default): each inspected
                         browser's own DevTools frontend is used.
`);
  process.exit(0);
}

// --- Telemetry opt-out (shared with the Settings UI via settings.json) -----

function settingsFile() {
  const dir = process.env.SETTINGS_DIR || path.join(homedir(), '.omniterm');
  return path.join(dir, 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf-8'));
  } catch {
    return {};
  }
}

function setTelemetryEnabled(enabled) {
  const file = settingsFile();
  const settings = readSettings();
  settings.telemetryEnabled = enabled;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
}

// Env opt-out signal that overrides the saved setting. KEEP IN SYNC with the
// env checks in packages/core/lib/telemetryConfig.ts resolveTelemetryConfig
// (the launcher can't import core, so this list is duplicated by necessity —
// a new opt-out env added there must be mirrored here or `telemetry status`
// will misreport it).
function envOptOutSignal() {
  const env = process.env;
  if (/^(1|true|yes|on)$/i.test(env.DO_NOT_TRACK || '')) return 'DO_NOT_TRACK';
  if (/^(0|false|no|off)$/i.test(env.OMNITERM_TELEMETRY || '')) return 'OMNITERM_TELEMETRY';
  if (/^(1|true|yes|on)$/i.test(env.OMNITERM_TELEMETRY_DISABLED || '')) return 'OMNITERM_TELEMETRY_DISABLED';
  if (/^(1|true|yes|on)$/i.test(env.CI || '')) return 'CI';
  if (env.NODE_ENV === 'test') return 'NODE_ENV=test';
  return null;
}

if (args[0] === 'telemetry') {
  const sub = args[1] || 'status';
  if (sub === 'off' || sub === 'on') {
    setTelemetryEnabled(sub === 'on');
    console.log(`[omniterm] Telemetry ${sub === 'on' ? 'enabled' : 'disabled'} (saved to settings).`);
    process.exit(0);
  }
  if (sub === 'status') {
    const settingOn = readSettings().telemetryEnabled !== false;
    const envSignal = envOptOutSignal();
    if (envSignal) {
      console.log(`Telemetry: OFF (forced by ${envSignal}; saved setting is ${settingOn ? 'on' : 'off'}).`);
    } else {
      const hint = settingOn ? 'Disable with: omniterm telemetry off' : 'Enable with: omniterm telemetry on';
      console.log(`Telemetry: ${settingOn ? 'ON' : 'OFF'} (saved setting). ${hint}`);
    }
    process.exit(0);
  }
  console.error(`[omniterm] Unknown telemetry command "${sub}". Use: status | on | off`);
  process.exit(1);
}

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

// Collect every `--name <value>` pair (repeatable flags), preserving order.
// Forwarded verbatim to the server entry, which parses them.
function collectFlag(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) out.push(name, args[++i]);
  }
  return out;
}

function parsePort(raw, label) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[omniterm] Invalid ${label}: ${JSON.stringify(raw)} (expected 1-65535)`);
    process.exit(1);
  }
  return n;
}

function parseTtydRange(raw) {
  const m = raw.match(/^(\d+)-(\d+)$/);
  if (!m) {
    console.error(
      `[omniterm] Invalid --ttyd-ports: ${JSON.stringify(raw)} (expected MIN-MAX, e.g. 7700-7799)`,
    );
    process.exit(1);
  }
  const min = parsePort(m[1], 'ttyd-ports MIN');
  const max = parsePort(m[2], 'ttyd-ports MAX');
  if (max < min) {
    console.error(`[omniterm] Invalid --ttyd-ports: MIN (${min}) > MAX (${max})`);
    process.exit(1);
  }
  return [String(min), String(max)];
}

const PORT = parsePort(flag('--port') ?? process.env.OMNITERM_PORT ?? '17717', '--port');
const HOST = flag('--host') ?? process.env.OMNITERM_HOST ?? '0.0.0.0';
const ttydRangeRaw = flag('--ttyd-ports');
const [TTYD_MIN, TTYD_MAX] = ttydRangeRaw
  ? parseTtydRange(ttydRangeRaw)
  : [process.env.OMNITERM_TTYD_PORT_MIN ?? '7700', process.env.OMNITERM_TTYD_PORT_MAX ?? '7799'];

const serverEntry = path.join(__dirname, '..', 'standalone', 'server', 'server.js');
const clientEntry = path.join(__dirname, '..', 'standalone', 'client', 'index.html');

if (!existsSync(serverEntry) || !existsSync(clientEntry)) {
  console.error(
    [
      '[omniterm] This installation is missing the bundled standalone app.',
      `  server: ${serverEntry}`,
      `  client: ${clientEntry}`,
      'Reinstall the published package with `npm install -g @omniterm/host@latest`.',
      'When developing from the monorepo, run `pnpm --filter @omniterm/host build` before starting the CLI.',
    ].join('\n'),
  );
  process.exit(1);
}

for (const cmd of ['ttyd', 'tmux']) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
  } catch {
    console.error(
      `[omniterm] Error: ${cmd} is not installed. Install it (e.g., 'brew install ${cmd}') and retry.`,
    );
    process.exit(1);
  }
}

console.log(`[omniterm] Starting on http://${HOST}:${PORT}`);

const pluginArgs = collectFlag('--plugin');

const child = spawn(process.execPath, [serverEntry, ...pluginArgs], {
  env: {
    ...process.env,
    OMNITERM_PORT: String(PORT),
    OMNITERM_HOST: HOST,
    OMNITERM_TTYD_PORT_MIN: TTYD_MIN,
    OMNITERM_TTYD_PORT_MAX: TTYD_MAX,
    OMNITERM_VERSION: process.env.OMNITERM_VERSION ?? APP_VERSION,
    // --no-telemetry: disable for this run only (persistent opt-out is the
    // `omniterm telemetry off` command / the Settings toggle).
    ...(args.includes('--no-telemetry') ? { OMNITERM_TELEMETRY: '0' } : {}),
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  },
  stdio: 'inherit',
});

// On Ctrl-C / SIGTERM, forward to the child and WAIT for it to exit before
// we exit ourselves — otherwise the child's own cleanup (killing ttyd/tmux
// subprocesses) gets cut short and orphans pile up. Belt: a 5s force-kill
// timer in case the child hangs.
let exiting = false;
const cleanup = (signal) => {
  if (exiting) return;
  exiting = true;
  child.kill(signal);
  const force = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, 5000);
  child.once('exit', () => {
    clearTimeout(force);
    process.exit(0);
  });
};
process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));

child.on('exit', (code) => {
  if (exiting) return; // already handled by cleanup() above
  if (code !== 0) console.error(`[omniterm] Server exited with code ${code}`);
  process.exit(code ?? 1);
});
