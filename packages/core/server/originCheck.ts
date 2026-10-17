/**
 * Origin check — cross-site request / WebSocket hijacking protection.
 *
 * omniterm has no auth of its own, so any page open in the user's browser
 * could otherwise drive it cross-site: CORS stops cross-origin READS, but not
 * a form POST and not a WebSocket handshake (live shells, Chrome CDP). This
 * module decides, from the ORIGINAL request headers, whether a browser-issued
 * request comes from omniterm's own origin.
 *
 * Policy (applied to every non-safe HTTP method and every WS upgrade):
 *   - no `Origin` header      → allowed (curl, the omniterm-browser shim, CLI tools)
 *   - `Origin` in allowlist   → allowed (`*` disables the check — unsafe)
 *   - `Origin` host[:port] == `Host`, or == first `X-Forwarded-Host` → allowed
 *     (scheme may differ, so an https reverse proxy in front of http works)
 *   - `Origin: null` / anything else → rejected
 *
 * Residual risk this cannot close without real auth: DNS rebinding, where the
 * attacker's hostname resolves to omniterm, so Origin == Host == attacker host.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RequestHandler } from 'express';

export class OriginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginConfigError';
  }
}

/** Methods that pass without a check (no state change; CORS guards reads). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Canonical `scheme://host[:port]` (lowercase, default port dropped), or null
 * when `raw` is not a bare origin (path, query, credentials, no host...).
 */
export function normalizeOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!u.host || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '' && u.pathname !== '/') return null;
  // URL.host already omits the scheme's default port for http/https.
  return `${u.protocol}//${u.host}`.toLowerCase();
}

/**
 * Parse allowlist entries (each may itself be a comma-separated list). Accepts
 * full origins, `null` and `*`. Throws OriginConfigError on a malformed entry
 * so a typo fails the boot instead of silently locking the operator out.
 */
export function parseAllowedOrigins(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    for (const part of entry.split(',')) {
      const item = part.trim();
      if (!item) continue;
      let norm: string | null;
      if (item === '*' || item === 'null') norm = item;
      else norm = normalizeOrigin(item);
      if (!norm) {
        throw new OriginConfigError(
          `invalid allowed origin ${JSON.stringify(item)} (expected a full origin like https://omniterm.example.com, "null", or "*")`,
        );
      }
      if (!out.includes(norm)) out.push(norm);
    }
  }
  return out;
}

interface HostPort {
  hostname: string;
  port: string | null;
}

/** Split a `Host`-style `host[:port]` (IPv6 brackets supported). */
function parseHostHeader(raw: string): HostPort | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  let hostname: string;
  let rest: string;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 0) return null;
    hostname = v.slice(0, end + 1);
    rest = v.slice(end + 1);
  } else {
    const i = v.indexOf(':');
    hostname = i < 0 ? v : v.slice(0, i);
    rest = i < 0 ? '' : v.slice(i);
  }
  if (!hostname) return null;
  if (rest === '') return { hostname, port: null };
  if (!/^:\d{1,5}$/.test(rest)) return null;
  return { hostname, port: String(Number(rest.slice(1))) };
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Does the Origin's host[:port] name the same endpoint as a Host value? */
function sameHost(origin: URL, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const h = parseHostHeader(hostHeader);
  if (!h || h.hostname !== origin.hostname.toLowerCase()) return false;
  const originPort = origin.port || DEFAULT_PORTS[origin.protocol];
  if (!originPort) return false;
  // A port-less Host means "the default port" of whatever scheme the client
  // used — which may differ from the Origin's (https proxy → http backend).
  if (h.port === null) return originPort === '80' || originPort === '443';
  return h.port === originPort;
}

/**
 * The pure decision. `origin` / `host` / `forwardedHost` are raw header values
 * (undefined when absent); `allowlist` holds entries as produced by
 * parseAllowedOrigins (unnormalized entries are tolerated).
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  forwardedHost: string | undefined,
  allowlist: readonly string[] = [],
): boolean {
  if (origin === undefined) return true;
  if (allowlist.includes('*')) return true;
  const trimmed = origin.trim();
  if (trimmed.toLowerCase() === 'null') return allowlist.includes('null');
  const norm = normalizeOrigin(trimmed);
  if (!norm) return false;
  if (allowlist.some((e) => e !== 'null' && (normalizeOrigin(e) ?? e) === norm)) return true;
  const u = new URL(trimmed);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (forwardedHost !== undefined) {
    const first = forwardedHost.split(',')[0];
    if (sameHost(u, first)) return true;
  }
  return sameHost(u, host);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** isOriginAllowed applied to a Node request's headers. */
export function isRequestOriginAllowed(req: IncomingMessage, allowlist: readonly string[]): boolean {
  return isOriginAllowed(
    headerValue(req.headers.origin),
    headerValue(req.headers.host),
    headerValue(req.headers['x-forwarded-host']),
    allowlist,
  );
}

// --- Rejection logging (deduped) -------------------------------------------

const LOG_WINDOW_MS = 60_000;
const LOG_MAX_KEYS = 256;

/**
 * One line per (origin, host) per minute, so a hostile page retrying in a loop
 * cannot flood the log. Suppressed repeats are counted into the next line.
 */
export function createRejectionLogger(
  log: (line: string) => void = (l) => console.warn(l),
  now: () => number = Date.now,
) {
  const seen = new Map<string, { at: number; suppressed: number }>();
  return (req: IncomingMessage, kind: 'http' | 'ws') => {
    const origin = String(headerValue(req.headers.origin) ?? '').slice(0, 200);
    const host = String(headerValue(req.headers.host) ?? '').slice(0, 200);
    const key = `${origin}\n${host}`;
    const t = now();
    const prev = seen.get(key);
    if (prev && t - prev.at < LOG_WINDOW_MS) {
      prev.suppressed++;
      return;
    }
    if (!prev && seen.size >= LOG_MAX_KEYS) seen.clear();
    const extra = prev?.suppressed ? ` (+${prev.suppressed} suppressed)` : '';
    seen.set(key, { at: t, suppressed: 0 });
    const path = (req.url ?? '').split('?')[0].slice(0, 120);
    log(
      `[omniterm] rejected cross-origin ${kind === 'ws' ? 'WebSocket' : req.method} ${path}: ` +
        `Origin ${JSON.stringify(origin)} does not match Host ${JSON.stringify(host)}${extra} ` +
        `— add it with --allowed-origins if it is legitimate`,
    );
  };
}

// --- Express middleware + upgrade guard -------------------------------------

export interface OriginGuardOptions {
  allowlist: readonly string[];
  onReject?: (req: IncomingMessage, kind: 'http' | 'ws') => void;
}

/** 403s non-safe methods whose Origin is not allowed; everything else passes. */
export function originCheckMiddleware(opts: OriginGuardOptions): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || isRequestOriginAllowed(req, opts.allowlist)) return next();
    opts.onReject?.(req, 'http');
    res.status(403).json({ error: 'origin not allowed' });
  };
}

/**
 * Call first in `server.on('upgrade')`. Returns true when the handshake was
 * rejected (403 written, socket closed) — the caller must then stop.
 */
export function rejectUpgradeIfOriginNotAllowed(
  req: IncomingMessage,
  socket: Duplex,
  opts: OriginGuardOptions,
): boolean {
  if (isRequestOriginAllowed(req, opts.allowlist)) return false;
  opts.onReject?.(req, 'ws');
  const body = JSON.stringify({ error: 'origin not allowed' });
  socket.on('error', () => {});
  socket.end(
    'HTTP/1.1 403 Forbidden\r\n' +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
    () => socket.destroy(),
  );
  return true;
}
