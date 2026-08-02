# Tasks: Built-in Telemetry (Usage + Performance)

**Input**: `specs/004-telemetry/` (spec.md, plan.md)

**Tests**: pure-logic unit tests (gating truth table, install-id, ring buffer,
payload sanitization) via `tsx --test`; gating proven by "disabled ⇒ client
never constructed". Browser evidence is N/A (no UI surface beyond an existing
JSON endpoint).

## Phase 1: Setup

- [x] T001 Add `posthog-node` to `packages/core/package.json` `dependencies`
  (inlines into `@omniterm/host` via existing tsup `noExternal`). `pnpm install`,
  update `pnpm-lock.yaml`.

## Phase 2: Foundational (pure modules — blocking)

- [x] T002 [P] `packages/core/lib/perfBuffer.ts` — bounded ring buffer (cap 100):
  `recordPerf(op, timings)`, `getRecent()` (returns a copy), `clear()` (tests).
- [x] T003 [P] `packages/core/lib/telemetryConfig.ts` — pure
  `resolveTelemetryConfig(env, persistedOptOut)` → `{ enabled, key, host }`.
  Fail-closed: off when `DO_NOT_TRACK` truthy, `OMNITERM_TELEMETRY` ∈
  {0,false,off}, persisted opt-out, `CI` truthy / `NODE_ENV==='test'` /
  `OMNITERM_TELEMETRY_DISABLED`, or no key. Default US host; `OMNITERM_POSTHOG_HOST`
  override (EU). `POSTHOG_KEY` const (empty in source, injected at release-build
  time) + `OMNITERM_POSTHOG_KEY` runtime override.
- [x] T004 [P] `packages/core/lib/installId.ts` — `getOrCreateInstallId()` and
  `readState()/writeState()` over `~/.omniterm/telemetry.json`
  (`{ installId, optedOut?, noticeShown? }`); atomic write (temp+rename);
  concurrent-safe (re-read if file appears).

## Phase 3: US1 — Pseudonymous usage + perf to the analytics destination (P1)

- [x] T005 `packages/core/lib/telemetry.ts` — rewrite the stub, **preserving the
  exact exports**: `initTelemetry`, `shutdownTelemetry`, `trackServerStarted`,
  `trackSessionCreated`, `trackSessionAdopted`, `trackSessionClosed`,
  `trackFileOpened`, `trackCleanup`, `getRecentPerfMetrics`.
  - `initTelemetry()`: resolve config; if enabled, create one `PostHog` client +
    ensure install id; (first-run notice → T010).
  - `buildProps(extra)`: merge only non-identifying context (`app_version`,
    `os` platform, `node_version`) + reviewed `extra`. No names, paths,
    hostnames, repository/session/plugin identifiers, or contents.
  - each `track*`: if enabled, `capture({ distinctId, event, properties })`,
    wrapped so throws never escape (FR-009).
  - `trackSessionCreated`/`trackSessionAdopted`: also `recordPerf(...)`
    **regardless of enabled** (local collection independent — FR-004).
  - `getRecentPerfMetrics()`: return `perfBuffer.getRecent()`.
  - update the file header comment (no longer "no-op stubs").
- [x] T006 `shutdownTelemetry()` — `Promise.race([client.shutdown(), timeout(2000)])`,
  resolve always, never reject (FR-010). Verify `startServer.ts` shutdown path
  still awaits it (no code change expected).
- [x] T007 Map the event names/properties for all six call sites (server_started
  {session_count}, session_created {total_ms,tmux_ms,adopt_ms}, session_adopted
  {total_ms,allocate_port_ms}, session_closed, file_opened {language},
  cleanup {count}). Confirm call sites compile unchanged.

## Phase 4: US2 — Privacy controls & opt-out (P1)

- [x] T008 Wire `resolveTelemetryConfig` + persisted opt-out into `initTelemetry`
  so all opt-out signals disable outbound (FR-006); assert no client is created
  when disabled (FR-012/SC-002).
- [x] T009 Persisted opt-out: expose a tiny `setOptOut(true|false)` writing
  `telemetry.json` so the choice survives restarts (FR-007). (CLI/flag surfacing
  optional; env + file are the contract.)
- [x] T010 First-run disclosure (FR-008): on first enabled init with `noticeShown`
  unset, print a one-line stderr notice (what's collected + how to opt out), then
  persist `noticeShown:true`.

## Phase 4b: US2 — Opt-out surfaces (CLI + Settings UI)

- [x] T020 Add `telemetryEnabled: boolean` (default true) to the `Settings`
  interface + `DEFAULT_SETTINGS` (`packages/core/lib/settings.ts`); persisted via
  the existing `GET/PUT /api/settings`. `initTelemetry` derives `persistedOptOut`
  from `loadSettings().telemetryEnabled === false` (replaces the telemetry.json
  `optedOut`, which is removed from `installId.ts`). Single source of truth.
- [x] T021 CLI (`apps/omniterm/bin/omniterm.js`): `omniterm telemetry status|on|off`
  reads/writes `settings.json` directly (no core import — launcher stays thin),
  and `--no-telemetry` injects `OMNITERM_TELEMETRY=0` into the server env for one
  run. `status` reflects env overrides. Update `--help`.
- [x] T022 Settings UI (`packages/core/app/components/SettingsPanel.tsx`):
  a Privacy → Telemetry on/off control bound to `telemetryEnabled`, saved through
  the existing PUT flow; hint notes the env overrides.

## Phase 4c: Front-end telemetry (FR-015–FR-017)

- [x] T023 Front-end telemetry needs no SDK dependency — a tiny custom fetch
  client (no posthog-js). (Evolved from posthog-js → slim → custom: ~37KB → ≈0.)
- [x] T024 Server gate: `getClientTelemetryConfig()` in telemetry.ts +
  `GET /api/telemetry` in startServer.ts → `{ enabled, key, host, distinctId }`
  (omit key when disabled).
- [x] T025 `app/telemetryClient.ts` — fetch the gate, arm only when enabled, then
  `track()` POSTs each event to PostHog `/capture/` via keepalive fetch (shared
  distinctId, no names/paths/content, GeoIP disabled); `setClientTelemetryEnabled()` live opt-out;
  `buildCapturePayload()` pure + unit-tested.
- [x] T026 Instrument curated events (reviewed properties only): `app_loaded {load_ms}` +
  `workspace_switched` + `panel_toggled` + `tab_closed {type}` (page.tsx),
  `terminal_rendered {render_ms}` (TerminalView.tsx — the 10s),
  `terminal_tab_opened {create_ms}` (terminal integration), `file_opened_editor
  {language}` (FilePanel), `plugin_tab_opened` with no plugin identifier (manifestPlugins),
  `settings_changed` + live opt-out (SettingsPanel).
- [x] T027 Verify: client bundle has posthog-js, server bundle does not; gate
  returns key/host/distinctId when enabled and nothing when disabled; unit test
  for the disabled gate shape.

## Phase 5: US3 — Local perf visibility (P3)

- [x] T011 Confirm `GET /api/metrics/perf` (`startServer.ts`) returns the ring
  buffer via `getRecentPerfMetrics()` even when telemetry is opted out
  (local recording independent — FR-004/SC-006). No endpoint change expected.

## Phase 6: Tests (evidence)

- [x] T012 [P] `perfBuffer.test.ts` — bounding/eviction + copy semantics.
- [x] T013 [P] `telemetryConfig.test.ts` — gating truth table (each opt-out
  signal ⇒ disabled; happy path with key ⇒ enabled; no key ⇒ disabled).
- [x] T014 [P] `installId.test.ts` — create-once, persist, re-read idempotent
  (use a temp HOME/config dir).
- [x] T015 [P] `telemetry.test.ts` — `buildProps` has no disallowed keys and
  browser payloads force `$geoip_disable: true` (SC-004);
  disabled config ⇒ `track*` make no capture / client never constructed;
  perf tracks still populate the ring buffer when disabled.

## Phase 7: Docs & disclosure

- [x] T016 `apps/omniterm/README.md` — add a "Telemetry" section: what's
  collected (pseudonymous), that it's opt-out, and every off-switch (`DO_NOT_TRACK`,
  `OMNITERM_TELEMETRY=0`, persisted opt-out, auto-off in CI). Matches the
  first-run notice wording.

## Phase 8: Evidence & review

- [x] T017 Run `pnpm -r typecheck` + `pnpm -r test`; build `@omniterm/host`
  (telemetry must inline), and record the results in the public verification summary.
- [x] T018 `code-review` on the diff; address findings.
- [x] T019 Add feature 004 to the public roadmap and set its spec status to implemented.

## Dependencies

- T001 → T002–T004 (need the dep installed) — though pure modules don't import
  posthog except telemetry.ts (T005).
- T002–T004 (foundational) → T005 (façade) → T006/T007.
- T005 → T008–T011.
- All code → T012–T015 (tests) → T016–T019.

## Notes

- **Activation**: `POSTHOG_KEY` is empty in source, so telemetry is inert in a
  source build — proving the gating end-to-end without sending data. Going live
  is a published release: `.github/workflows/publish-host.yml` passes the
  `POSTHOG_KEY` secret to the build, `apps/omniterm/tsup.config.ts` inlines it,
  and the workflow greps the bundle to fail the release if it didn't land.
  (Originally this was a one-line constant edit + republish; changed when the
  repository was open-sourced — see `plan.md` decision 3.)
