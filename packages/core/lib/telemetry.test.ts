import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProps,
  isTelemetryEnabled,
  initTelemetry,
  trackSessionCreated,
  getRecentPerfMetrics,
  getClientTelemetryConfig,
  projectClientTelemetryConfig,
} from './telemetry.js';
import { clear } from './perfBuffer.js';

const PII_LIKE = ['hostname', 'host_name', 'username', 'user', 'home', 'cwd', 'path', 'ip'];

test('buildProps carries only approved context (no workspace or host identifiers)', () => {
  const props = buildProps({ language: 'typescript' });
  // Base context keys plus the explicit extra — nothing else.
  assert.deepEqual(
    Object.keys(props).sort(),
    ['app_version', 'language', 'node_version', 'os'].sort(),
  );
  for (const key of Object.keys(props)) {
    assert.ok(!PII_LIKE.includes(key), `unexpected PII-like key: ${key}`);
  }
  // os is a coarse platform string, not a hostname.
  assert.ok(typeof props.os === 'string' && props.os.length < 20);
});

// NOTE: initTelemetry() is a module singleton (an `initialized` flag), so only
// the first call in this file actually evaluates config — later calls no-op.
// These tests are order-independent only because every init path here ends in
// the same disabled state (opted out). A future test that needs an *enabled*
// init path would need a reset hook; none is exposed today on purpose.
function withOptOut(fn: () => void): void {
  const prev = process.env.DO_NOT_TRACK;
  process.env.DO_NOT_TRACK = '1';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prev;
  }
}

test('telemetry stays disabled when opted out, and init never throws', () => {
  // A key ships embedded (telemetry is opt-out), so we opt out explicitly to
  // assert the gate — and to guarantee no client/network in the unit test.
  withOptOut(() => {
    initTelemetry();
    assert.equal(isTelemetryEnabled(), false);
  });
});

test('projectClientTelemetryConfig: enabled exposes key/host/distinctId, disabled omits them', () => {
  const enabled = projectClientTelemetryConfig({
    enabled: true,
    hasClient: true,
    key: 'phc_x',
    host: 'https://us.i.posthog.com',
    distinctId: 'abc',
    appVersion: '1.2.3',
  });
  assert.deepEqual(enabled, {
    enabled: true,
    key: 'phc_x',
    host: 'https://us.i.posthog.com',
    distinctId: 'abc',
    appVersion: '1.2.3',
  });

  // enabled but no client (init failed) → still gated off, no key handed out.
  const noClient = projectClientTelemetryConfig({
    enabled: true,
    hasClient: false,
    key: 'phc_x',
    host: 'h',
    distinctId: 'abc',
    appVersion: '1',
  });
  assert.deepEqual(noClient, { enabled: false });
});

test('getClientTelemetryConfig omits the key when telemetry is disabled', () => {
  // The browser gate (GET /api/telemetry) must not hand out a key when off, so
  // the front-end can never initialize posthog-js.
  withOptOut(() => {
    initTelemetry();
    const cfg = getClientTelemetryConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.key, undefined);
    assert.equal(cfg.host, undefined);
    assert.equal(cfg.distinctId, undefined);
  });
});

test('perf is recorded locally even when telemetry is disabled', () => {
  withOptOut(() => {
    clear();
    initTelemetry(); // disabled (opted out)
    trackSessionCreated({ total_ms: 7, tmux_ms: 3, adopt_ms: 2 });

    const recent = getRecentPerfMetrics();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].op, 'session_created');
    assert.deepEqual(recent[0].timings, { total_ms: 7, tmux_ms: 3, adopt_ms: 2 });
  });
});
