import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCapturePayload,
  initClientTelemetry,
  track,
  setClientTelemetryEnabled,
  __resetForTest,
} from './telemetryClient.js';

test('buildCapturePayload suppresses GeoIP and carries only approved context', () => {
  __resetForTest();
  const cfg = { key: 'phc_k', captureUrl: 'h/capture/', distinctId: 'd', appVersion: '1' };
  const p = buildCapturePayload(
    cfg,
    'workspace_switched',
    { kind: 'worktree', $geoip_disable: false },
    '2026-01-01T00:00:00Z',
  );
  assert.equal(p.api_key, 'phc_k');
  assert.equal(p.event, 'workspace_switched');
  assert.equal(p.distinct_id, 'd');
  assert.equal(p.timestamp, '2026-01-01T00:00:00Z');
  assert.deepEqual(p.properties, {
    kind: 'worktree',
    app_version: '1',
    surface: 'frontend',
    $lib: 'omniterm-web',
    $geoip_disable: true,
  });
  // No workspace- or host-identifying keys.
  const keys = Object.keys(p.properties as Record<string, unknown>);
  for (const k of ['path', 'file', 'cwd', 'repo', 'session', 'home', 'hostname']) {
    assert.ok(!keys.includes(k), `unexpected key ${k}`);
  }
});

test('init(enabled) arms the client; track POSTs to /capture/; opt-out stops it', async () => {
  __resetForTest();
  // Stub the server gate.
  const gate = (async () =>
    ({
      ok: true,
      json: async () => ({
        enabled: true,
        key: 'phc_k',
        host: 'https://us.i.posthog.com',
        distinctId: 'abc',
        appVersion: '9',
      }),
    }) as unknown as Response) as unknown as typeof fetch;
  await initClientTelemetry(gate);

  // Record capture POSTs (track() uses the global fetch).
  const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true } as Response);
  }) as unknown as typeof fetch;
  try {
    track('app_loaded', { load_ms: 5 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://us.i.posthog.com/capture/');
    assert.equal(calls[0].init?.keepalive, true);
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.event, 'app_loaded');
    assert.equal(body.distinct_id, 'abc');
    assert.equal(body.properties.load_ms, 5);
    assert.equal(body.properties.surface, 'frontend');

    // is_mobile reflects the viewport — exercise BOTH branches so a `>` vs `<`
    // inversion in the threshold would fail (no `window` in node, so mock it).
    const isMobileOf = (i: number) =>
      JSON.parse(String(calls[i].init?.body)).properties.is_mobile;
    (globalThis as { window?: { innerWidth: number } }).window = { innerWidth: 375 };
    track('app_loaded', { load_ms: 6 });
    assert.equal(isMobileOf(1), true);
    (globalThis as { window?: { innerWidth: number } }).window = { innerWidth: 1280 };
    track('app_loaded', { load_ms: 7 });
    assert.equal(isMobileOf(2), false);

    // Live opt-out → no further POSTs.
    const before = calls.length;
    setClientTelemetryEnabled(false);
    track('app_loaded', { load_ms: 9 });
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = orig;
    delete (globalThis as { window?: unknown }).window;
  }
});
