'use client';

import { MOBILE_MAX_WIDTH } from './breakpoints';

/**
 * Front-end telemetry — a tiny direct-to-PostHog capture client.
 *
 * We emit a small set of curated, pseudonymous events, so instead of the posthog-js SDK
 * (~37KB gzip even slimmed) this posts each event to PostHog's /capture/ REST
 * endpoint with a keepalive fetch (so the request survives page unload). No
 * dependency, no autocapture, no session replay, no pageviews.
 *
 * The server is the single source of truth for whether telemetry runs: this
 * fetches GET /api/telemetry (server-resolved enabled + key + host + the shared
 * pseudonymous install id) and only arms itself when enabled. Events carry only
 * the explicit props passed to track() — no paths, repo/session names, or
 * contents — and every payload disables GeoIP enrichment.
 */

interface ClientTelemetryConfig {
  enabled: boolean;
  key?: string;
  host?: string;
  distinctId?: string;
  appVersion?: string;
}

interface ArmedConfig {
  key: string;
  captureUrl: string;
  distinctId: string;
  appVersion: string;
}

let armed: ArmedConfig | null = null;
let enabled = false;
let started = false;

/**
 * Whether the current viewport is "mobile", added to every frontend event so
 * perf (and usage) can be segmented mobile vs desktop. Shares MOBILE_MAX_WIDTH
 * with the layout's `isMobile` so the two can't drift.
 */
function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < MOBILE_MAX_WIDTH;
}

/** Build the capture payload PostHog's /capture/ endpoint expects. */
export function buildCapturePayload(
  cfg: ArmedConfig,
  event: string,
  props?: Record<string, unknown>,
  timestamp?: string,
): Record<string, unknown> {
  return {
    api_key: cfg.key,
    event,
    distinct_id: cfg.distinctId,
    properties: {
      ...(props ?? {}),
      app_version: cfg.appVersion,
      surface: 'frontend',
      $lib: 'omniterm-web',
      // This is spread last so a caller cannot accidentally re-enable GeoIP.
      $geoip_disable: true,
    },
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

/** Initialize from the server gate. Safe to call once on app mount. */
export async function initClientTelemetry(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (started) return;
  started = true;
  try {
    const res = await fetchImpl('/api/telemetry');
    if (!res.ok) return;
    const cfg = (await res.json()) as ClientTelemetryConfig;
    if (!cfg.enabled || !cfg.key || !cfg.host || !cfg.distinctId) return;
    armed = {
      key: cfg.key,
      captureUrl: `${cfg.host.replace(/\/+$/, '')}/capture/`,
      distinctId: cfg.distinctId,
      appVersion: cfg.appVersion ?? 'unknown',
    };
    enabled = true;
  } catch {
    /* best-effort — telemetry must never break the app */
  }
}

/** Emit a curated event (no-op when telemetry is disabled). */
export function track(event: string, props?: Record<string, unknown>): void {
  if (!enabled || !armed) return;
  try {
    // One POST per event — intentional (these are ~9 coarse user actions, not a
    // hot path; batching would add complexity for no real gain). keepalive lets
    // the POST complete even if the page is unloading.
    void fetch(armed.captureUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        // is_mobile is spread last on purpose — it always reflects the actual
        // viewport and overrides any caller-supplied value.
        buildCapturePayload(armed, event, { ...props, is_mobile: isMobileViewport() }),
      ),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}

/**
 * Apply a telemetry choice from Settings to the running client.
 *
 * Opting OUT takes effect live (the spec's live-opt-out guarantee). Opting IN
 * only re-arms if the client was armed at boot (telemetry was on then); if it
 * was off at boot there's no key, so enabling takes effect on the next app/
 * server start (both the client and the server gate resolve at boot).
 */
export function setClientTelemetryEnabled(on: boolean): void {
  if (!on) {
    enabled = false;
    return;
  }
  if (armed) enabled = true;
}

/** Test-only: reset module state so tests don't depend on ordering. */
export function __resetForTest(): void {
  armed = null;
  enabled = false;
  started = false;
}
