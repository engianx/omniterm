# Implementation Plan: Built-in Telemetry (Usage + Performance)

**Branch**: `004-telemetry` | **Date**: 2026-06-14 | **Spec**: `specs/004-telemetry/spec.md`

## Summary

Replace the no-op telemetry stubs in `@omniterm/core` (`packages/core/lib/telemetry.ts`)
with a real, privacy-gated implementation backed by PostHog Cloud. The event
taxonomy and call sites already exist (session create/adopt/close, file opened,
cleanup, server started) — this feature implements the backend behind those
exact function signatures, so **no call sites change**. Performance timings are
recorded into a bounded in-memory ring buffer (always, surfaced via the existing
`GET /api/metrics/perf`) and also captured to PostHog as event properties (only
when telemetry is enabled). Telemetry is **fail-closed**: any opt-out signal,
missing key, or CI/test context disables all outbound calls.

## Technical Context

**Language/Version**: Node 24, TypeScript 5 (strict, ESM)

**Primary Dependencies**: `posthog-node` (analytics client; restored as a
`@omniterm/core` runtime dependency — it gets inlined into `@omniterm/host` via
tsup `noExternal`). `node:crypto` (`randomUUID`), `node:fs`, `node:os`
(`homedir` only) from the platform.

**Storage**: a per-user JSON file `~/.omniterm/telemetry.json` holding the
pseudonymous install id and first-run-notice flag. The shared settings file
holds the opt-out choice. An in-process bounded ring buffer holds perf records.

**Testing**: `tsx --test` unit tests for the pure, deterministic pieces —
config/gating resolution, install-id read/create, ring buffer bounding, and the
event-property builder (asserting no disallowed fields and enforced GeoIP
suppression). The PostHog network call itself
is not unit-tested against the live service; gating is proven by asserting the
client is never constructed when disabled.

**Target Platform**: the omniterm host process (Node server in
`@omniterm/host`); `@omniterm/core` is the SDK where the code lives.

**Project Type**: library/SDK code in `packages/core`, consumed by the host.

**Performance Goals**: telemetry adds no perceptible latency; capture is
fire-and-forget; shutdown flush is bounded (≤2s) and never blocks exit beyond it.

**Constraints**: zero outbound network calls when disabled; no names, hostnames,
paths, repo/session/plugin identifiers, or contents in any payload; disable
GeoIP enrichment; never throw into call sites.

**Scale/Scope**: low-volume product+perf events (single-digit per session); one
new dependency; one rewritten file plus a small config/identity helper.

## Constitution Check

*GATE: re-checked after design below.*

- **I. Specification Authority** — spec.md is the source of truth; this plan and
  the code implement it. The no-op `telemetry.ts` header comment (which says
  telemetry was stripped) will be updated to reflect the new behavior. PASS.
- **II. Generic Host (No Product Coupling)** — telemetry is **generic host
  functionality**, not downstream-domain behavior, so it belongs in
  `@omniterm/core`. `posthog-node` is a general analytics library, not a
  product-specific dependency. The only maintainer-specific element is the
  destination **project key + region**, which is *configuration/data* (injected
  at build time, overridable by env), not code coupling. The code contains no
  domain logic — and since the key is no longer in source, the repository
  contains nothing tied to any particular destination. PASS (noted below).
- **III. Clean Plugin Boundary** — telemetry lives in core/host, touches no
  plugin; plugins are unaffected. N/A → PASS.
- **IV. Runtime Extensibility** — unaffected. N/A.
- **V. Test & Evidence Discipline** — new pure-logic contracts (gating, identity,
  ring buffer, payload sanitization) get explicit unit tests; a quality map +
  test report are produced. PASS.

No violations requiring Complexity Tracking. One judgment call recorded: a
first-party telemetry endpoint (the maintainers' PostHog project) is acceptable
in the generic host because it measures the host product itself and is injected
as config, not domain code.

## Architecture decisions

1. **Single module owns telemetry state** (`packages/core/lib/telemetry.ts`).
   Keep every existing export name and signature so call sites are untouched:
   `initTelemetry`, `shutdownTelemetry`, `trackServerStarted`,
   `trackSessionCreated`, `trackSessionAdopted`, `trackSessionClosed`,
   `trackFileOpened`, `trackCleanup`, `getRecentPerfMetrics`. (Verify the exact
   set + signatures against current call sites before editing — e.g. the close
   call site name.)

2. **Config / gating resolution** — a pure `resolveTelemetryConfig(env, persisted)`
   returns `{ enabled, key, host }`. `enabled` is `true` by default but forced
   `false` (fail-closed, opt-out wins) when ANY of:
   - `DO_NOT_TRACK` is set to a truthy value (`1`/`true`),
   - `OMNITERM_TELEMETRY` is an off value (`0`/`false`/`off`),
   - the persisted opt-out flag is set,
   - `CI` is truthy or a test/testbox context is detected (`NODE_ENV==='test'`,
     `OMNITERM_TELEMETRY_DISABLED`),
   - no PostHog key is configured (empty embedded constant and no env override).
   This function is unit-tested across the truth table (SC-002).

3. **Build-time-injected key, env-overridable** — a `POSTHOG_KEY` constant plus
   `OMNITERM_POSTHOG_KEY` / `OMNITERM_POSTHOG_HOST` env overrides. Region US
   (`https://us.i.posthog.com`); EU via host override (FR-011). With a key
   present, telemetry is **active by default (opt-out)**. `posthog-node` is kept
   **external** (a host runtime dependency installed by npm, like express) —
   not bundled.

   **Superseded (open-sourcing).** The constant was originally the write-only
   key written directly into source. It now reads an expression that
   `apps/omniterm/tsup.config.ts` replaces with a string literal at build time,
   fed by `OMNITERM_POSTHOG_KEY` from the release workflow's `POSTHOG_KEY`
   secret. A source checkout resolves it to `''`, so telemetry is off there with
   no way to enable it by accident; a runtime `OMNITERM_POSTHOG_KEY` still
   overrides whatever a build baked in. Rationale: the repository is public, and
   a committed key means every fork reports to our project by default.

4. **Pseudonymous identity** (`getOrCreateInstallId()`) — read
   `~/.omniterm/telemetry.json`; if absent, generate `crypto.randomUUID()` and
   write atomically (write temp + rename) to converge concurrent instances.
   The UUID is not derived from machine or user attributes, but it correlates
   events from the same installation (FR-003).

5. **Perf ring buffer** — a bounded array (cap 100). `recordPerf(op, timings)` is
   called by the perf-bearing tracks **regardless of enabled state** (local
   collection is independent — FR-004/US3). `getRecentPerfMetrics()` returns a
   copy. Only the PostHog `capture` is gated by `enabled`.

6. **Capture path** — when enabled, lazily construct one `PostHog` client in
   `initTelemetry()`. Each `track*` builds a sanitized property bag
   (`buildProps()` adds only `app_version`, `os` platform, `node_version` +
   the event's reviewed fields) and calls `capture`. The SDK is configured with
   `disableGeoip: true`. All capture is
   wrapped so a throw never escapes into a call site (FR-009).

7. **First-run disclosure** — on the first enabled init where the notice flag is
   unset, print a one-line stderr notice (what's collected + how to opt out) and
   persist `noticeShown:true` (FR-008). README/docs updated.

8. **Shutdown** — `shutdownTelemetry()` does `Promise.race([client.shutdown(),
   timeout(2000)])` then resolves; never rejects (FR-010).

9. **Front-end telemetry (FR-015–FR-017)** — a **tiny custom fetch client**
   (`app/telemetryClient.ts`, no SDK dependency). One server gate
   `GET /api/telemetry` → `{ enabled, key, host, distinctId }` from
   `getClientTelemetryConfig()` (reuses the server-resolved `config` + install
   id). The client fetches it and **arms only when enabled**, then `track()`
   POSTs each curated event to PostHog's `/capture/` REST endpoint with a
   `keepalive` fetch (survives page unload) — shared `distinctId`, props limited
   to counts/types/timings, plugin identifiers omitted, and
   `$geoip_disable: true` enforced. The Settings toggle disables it live.
   Rationale: posthog-js (even slimmed, ~37KB gzip) is far too heavy for ~9
   fire-and-forget events; the custom client adds ≈0 to the tarball (-0.04%) and
   is unit-testable in node (no browser globals).

## Project Structure

### Documentation (this feature)

```text
specs/004-telemetry/
├── spec.md                 # done
├── plan.md                 # this file
├── tasks.md                # /speckit-tasks output
└── checklists/requirements.md
```

### Source Code (repository root)

```text
packages/core/
├── lib/
│   ├── telemetry.ts                 # rewritten: real impl (same exports)
│   ├── telemetryConfig.ts           # NEW: pure resolveTelemetryConfig()
│   ├── telemetryConfig.test.ts      # NEW: gating truth table
│   ├── installId.ts                 # NEW: getOrCreateInstallId() + config file IO
│   ├── installId.test.ts            # NEW
│   ├── perfBuffer.ts                # NEW: bounded ring buffer
│   ├── perfBuffer.test.ts           # NEW
│   └── telemetry.test.ts            # NEW: props sanitization + disabled => no client
├── server/startServer.ts            # unchanged (already calls init/shutdown + /api/metrics/perf)
└── package.json                     # + posthog-node dependency

apps/omniterm/
└── README.md                        # + telemetry & opt-out disclosure
```

**Structure Decision**: all telemetry logic lives in `packages/core/lib`
(the host SDK), split into small pure modules (`telemetryConfig`, `installId`,
`perfBuffer`) that are unit-testable without network or disk-global state, with
`telemetry.ts` as the stateful façade preserving the existing public surface.
`posthog-node` is a dependency of **both** `@omniterm/core` and `@omniterm/host`
and is kept **external** (installed at runtime, like `express`/`http-proxy`) —
NOT bundled. Only `@omniterm/core` is inlined (`noExternal`), because it is
private/unpublished; posthog-node is published on npm, so inlining it would just
bloat the tarball and block semver patch updates.

## Complexity Tracking

No constitution violations to justify.
