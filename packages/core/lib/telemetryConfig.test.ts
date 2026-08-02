import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTelemetryConfig,
  DEFAULT_POSTHOG_HOST,
  POSTHOG_KEY,
} from './telemetryConfig.js';

// A clean env with a key present is the only "enabled" baseline.
const withKey = { OMNITERM_POSTHOG_KEY: 'phc_test' };

test('enabled when a key is set and no opt-out signal is present', () => {
  const c = resolveTelemetryConfig({ ...withKey }, false);
  assert.equal(c.enabled, true);
  assert.equal(c.key, 'phc_test');
  assert.equal(c.host, DEFAULT_POSTHOG_HOST);
});

test('disabled when no key is configured', () => {
  // Empty string overrides the embedded default key → simulates no key.
  const c = resolveTelemetryConfig({ OMNITERM_POSTHOG_KEY: '' }, false);
  assert.equal(c.enabled, false);
});

test('disabled in a source build, where no key is baked in', () => {
  // POSTHOG_KEY is injected at release-build time only (see telemetryConfig.ts),
  // so a checkout resolves to '' and telemetry is off with a clean env.
  assert.equal(POSTHOG_KEY, '');
  const c = resolveTelemetryConfig({}, false);
  assert.equal(c.enabled, false);
});

test('each opt-out signal disables telemetry even with a key', () => {
  const signals: Array<Record<string, string>> = [
    { DO_NOT_TRACK: '1' },
    { OMNITERM_TELEMETRY: '0' },
    { OMNITERM_TELEMETRY: 'off' },
    { OMNITERM_TELEMETRY_DISABLED: 'true' },
    { CI: 'true' },
    { NODE_ENV: 'test' },
  ];
  for (const s of signals) {
    const c = resolveTelemetryConfig({ ...withKey, ...s }, false);
    assert.equal(c.enabled, false, `expected disabled for ${JSON.stringify(s)}`);
  }
});

test('persisted opt-out disables telemetry', () => {
  const c = resolveTelemetryConfig({ ...withKey }, true);
  assert.equal(c.enabled, false);
});

test('DO_NOT_TRACK=0 is not an opt-out (only truthy values opt out)', () => {
  const c = resolveTelemetryConfig({ ...withKey, DO_NOT_TRACK: '0' }, false);
  assert.equal(c.enabled, true);
});

test('region host override (EU) is honored', () => {
  const c = resolveTelemetryConfig(
    { ...withKey, OMNITERM_POSTHOG_HOST: 'https://eu.i.posthog.com' },
    false,
  );
  assert.equal(c.host, 'https://eu.i.posthog.com');
});
