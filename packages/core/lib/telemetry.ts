/**
 * Telemetry — pseudonymous usage + performance metrics.
 *
 * Sends a small set of pseudonymous events to PostHog (usage) and records
 * performance timings both locally (a bounded ring buffer behind
 * GET /api/metrics/perf) and to PostHog as event properties.
 *
 * Privacy is non-negotiable (spec 004):
 *   - Telemetry is fail-closed: any opt-out signal (DO_NOT_TRACK, the product
 *     opt-out, a CI/test context) or a missing destination key disables ALL
 *     outbound calls — the PostHog client is never even constructed.
 *   - The only application-level correlation key is a random installation id.
 *     Payloads contain no names, hostnames, paths, repo names, or contents.
 *   - GeoIP enrichment is explicitly disabled for the server SDK and browser
 *     capture payloads. The destination still receives network transport data.
 *   - Local perf recording is independent of phone-home: it works even when the
 *     user has opted out.
 *   - Failures never escape into callers; collection is best-effort.
 */

import os from 'node:os';
import { PostHog } from 'posthog-node';
import { recordPerf, getRecent, type PerfRecord } from './perfBuffer.js';
import { resolveTelemetryConfig, type TelemetryConfig } from './telemetryConfig.js';
import { getOrCreateInstallId, markNoticeShown, readState } from './installId.js';
import { loadSettings } from './settings.js';

let client: PostHog | null = null;
let distinctId = '';
let config: TelemetryConfig = { enabled: false, key: '', host: '' };
let initialized = false;

/** Approved application context attached to every server event. */
function baseContext(): Record<string, string> {
  return {
    app_version: process.env.OMNITERM_VERSION || 'unknown',
    os: os.platform(),
    node_version: process.version,
  };
}

/** Merge base context with a reviewed per-event property bag. */
export function buildProps(extra?: Record<string, unknown>): Record<string, unknown> {
  return { ...baseContext(), ...(extra ?? {}) };
}

/** Whether outbound telemetry is currently enabled (after initTelemetry). */
export function isTelemetryEnabled(): boolean {
  return config.enabled && client !== null;
}

/**
 * Resolved config the browser needs to send telemetry directly to PostHog.
 * Served by GET /api/telemetry — the front-end trusts this single server-side
 * gate (env overrides + opt-out + key presence) and shares the install id so
 * server and client events share one pseudonymous installation id. When disabled, the key
 * is omitted so the client can't initialize.
 */
export interface ClientTelemetryConfig {
  enabled: boolean;
  key?: string;
  host?: string;
  distinctId?: string;
  appVersion?: string;
}

/** Pure projection of the browser gate payload (testable without module state). */
export function projectClientTelemetryConfig(input: {
  enabled: boolean;
  hasClient: boolean;
  key: string;
  host: string;
  distinctId: string;
  appVersion: string;
}): ClientTelemetryConfig {
  if (!input.enabled || !input.hasClient) return { enabled: false };
  return {
    enabled: true,
    key: input.key,
    host: input.host,
    distinctId: input.distinctId,
    appVersion: input.appVersion,
  };
}

export function getClientTelemetryConfig(): ClientTelemetryConfig {
  return projectClientTelemetryConfig({
    enabled: config.enabled,
    hasClient: client !== null,
    key: config.key,
    host: config.host,
    distinctId,
    appVersion: process.env.OMNITERM_VERSION || 'unknown',
  });
}

/** Fire-and-forget capture; swallows any error so callers are never affected. */
function capture(event: string, properties?: Record<string, unknown>): void {
  if (!config.enabled || !client) return;
  try {
    client.capture({ distinctId, event, properties: buildProps(properties) });
  } catch {
    /* best-effort */
  }
}

function showFirstRunNoticeOnce(): void {
  try {
    const state = readState();
    if (!state || state.noticeShown) return;
    process.stderr.write(
      '[omniterm] Pseudonymous usage + performance telemetry is enabled. ' +
        'Event payloads exclude names, contents, paths, repo names, and plugin ids. ' +
        'Opt out anytime with `omniterm telemetry off`, the Settings panel, or ' +
        'OMNITERM_TELEMETRY=0 / DO_NOT_TRACK=1.\n',
    );
    markNoticeShown();
  } catch {
    /* best-effort */
  }
}

/** Initialize telemetry from env + persisted state. Safe to call once at boot. */
export function initTelemetry(): void {
  // Idempotent: resolve config + build the client at most once. Guards both the
  // enabled case (never replace/leak a live client) and the disabled case
  // (no repeated env reads / loadSettings disk reads on defensive re-calls).
  if (initialized) return;
  initialized = true;
  try {
    // Persisted opt-out lives in settings (telemetryEnabled), shared by the
    // Settings UI and `omniterm telemetry off`. Env signals still override.
    const persistedOptOut = loadSettings().telemetryEnabled === false;
    config = resolveTelemetryConfig(process.env, persistedOptOut);
    if (!config.enabled) return;
    distinctId = getOrCreateInstallId();
    // flushAt:1 sends each (low-volume) event promptly instead of buffering for
    // the batch interval — the standalone CLI may be killed without a graceful
    // shutdown, so we don't want events stuck in an unsent batch.
    client = new PostHog(config.key, { host: config.host, flushAt: 1, disableGeoip: true });
    // getOrCreateInstallId above guarantees the state file exists, so
    // showFirstRunNoticeOnce's markNoticeShown will persist (ordering matters).
    showFirstRunNoticeOnce();
  } catch {
    // Any failure leaves telemetry disabled rather than breaking startup.
    config = { enabled: false, key: '', host: '' };
    client = null;
  }
}

/** Flush and close the client; bounded so it never delays shutdown. */
export async function shutdownTelemetry(): Promise<void> {
  const c = client;
  client = null;
  if (!c) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 2000);
    timer.unref?.();
  });
  try {
    // Belt-and-suspenders: shutdown(2000) asks posthog-node to stop flushing at
    // 2s; the outer race guarantees our wall-clock cap even if it doesn't honor
    // that, so a graceful shutdown is never delayed beyond ~2s (FR-010).
    await Promise.race([c.shutdown(2000), timeout]);
  } catch {
    /* best-effort */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function trackServerStarted(sessionCount: number): void {
  capture('server_started', { session_count: sessionCount });
}

export function trackSessionCreated(timings?: Record<string, number>): void {
  if (timings) recordPerf('session_created', timings);
  capture('session_created', timings);
}

export function trackSessionAdopted(timings?: Record<string, number>): void {
  if (timings) recordPerf('session_adopted', timings);
  capture('session_adopted', timings);
}

export function trackSessionClosed(): void {
  capture('session_closed');
}

export function trackFileOpened(language: string): void {
  capture('file_opened', { language });
}

export function trackCleanup(count?: number): void {
  capture('cleanup', count === undefined ? undefined : { count });
}

/** Recent performance records for GET /api/metrics/perf (local, always on). */
export function getRecentPerfMetrics(): PerfRecord[] {
  return getRecent();
}
