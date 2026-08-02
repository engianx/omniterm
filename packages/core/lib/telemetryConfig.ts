/**
 * Pure telemetry gating resolution.
 *
 * Telemetry is opt-OUT (on by default for normal interactive installs) but
 * fail-closed: any single opt-out signal, a missing destination key, or a
 * CI/test context forces it OFF. No I/O here — env and the persisted opt-out
 * flag are passed in so this is fully unit-testable (spec 004 FR-006/SC-002).
 */

/** Default PostHog ingestion host (US region). EU via OMNITERM_POSTHOG_HOST. */
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * PostHog project key, baked in at release-build time — never in source.
 *
 * The release workflow passes its POSTHOG_KEY secret to the build as
 * OMNITERM_POSTHOG_KEY, and apps/omniterm/tsup.config.ts replaces the
 * expression below with a string literal in the published bundle. Non-empty ⇒
 * telemetry is active by default (opt-out) for that published build.
 *
 * In a source checkout or a fork's build nothing is injected, so this is ''
 * and telemetry stays OFF. Setting OMNITERM_POSTHOG_KEY at run time overrides
 * whatever the build baked in (see resolveTelemetryConfig below). Region is US
 * by default (see DEFAULT_POSTHOG_HOST); set OMNITERM_POSTHOG_HOST for EU.
 *
 * OMNITERM_BAKED_POSTHOG_KEY is NOT a setting — nobody ever exports it. It is
 * an internal placeholder that exists only here and in the matching tsup
 * `define`, so the build can rewrite this one expression without touching any
 * read of the real OMNITERM_POSTHOG_KEY. That keeps the runtime override
 * impossible to freeze by accident: a future `process.env.OMNITERM_POSTHOG_KEY`
 * added anywhere in bundled code still reads the live environment.
 */
export const POSTHOG_KEY: string = process.env.OMNITERM_BAKED_POSTHOG_KEY ?? '';

export interface TelemetryConfig {
  enabled: boolean;
  key: string;
  host: string;
}

type Env = Record<string, string | undefined>;

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function offValue(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'no' || s === 'off';
}

/**
 * Resolve whether telemetry should run and where it should send.
 *
 * @param env       process.env (or a stub in tests)
 * @param persistedOptOut  the user's saved opt-out choice from telemetry.json
 */
export function resolveTelemetryConfig(env: Env, persistedOptOut: boolean): TelemetryConfig {
  const key = (env.OMNITERM_POSTHOG_KEY ?? POSTHOG_KEY).trim();
  const host = (env.OMNITERM_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST).trim() || DEFAULT_POSTHOG_HOST;

  // Fail-closed: every reason telemetry must NOT run.
  // NOTE: the CLI's `telemetry status` (apps/omniterm/bin/omniterm.js,
  // envOptOutSignal) duplicates these env checks — keep both in sync.
  const disabled =
    truthy(env.DO_NOT_TRACK) || // standard cross-tool opt-out
    offValue(env.OMNITERM_TELEMETRY) || // product env opt-out
    truthy(env.OMNITERM_TELEMETRY_DISABLED) || // explicit kill switch
    persistedOptOut || // saved choice
    truthy(env.CI) || // CI context
    env.NODE_ENV === 'test' || // test/testbox context
    key === ''; // nothing configured to send to

  return { enabled: !disabled, key, host };
}
