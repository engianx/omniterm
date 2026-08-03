<!-- RECOVERED EVIDENCE. This file records a verification run performed while
omniterm was developed inside a larger private product, before the host was
open-sourced into this repository. Measurements and dates are left as recorded —
they are historical evidence, not current claims. Vendor identifiers were
scrubbed, and any claim that no longer holds is marked inline (SUPERSEDED /
UNAVAILABLE / EXTERNAL). Proof mappings in the accompanying quality-map.yaml were
reconciled against this repository and are current. -->

# Test Report: built-in telemetry (004-telemetry)

**Quality map**: [quality-map.yaml](./quality-map.yaml)
**Branch / commit**: `004-telemetry` (uncommitted working tree)
**Last updated**: 2026-06-14
**Tester**: Claude (agent)

## Summary

**Overall status: PASS** · **Confidence: HIGH** (telemetry **active by default**; live delivery to PostHog US confirmed via manual E2E)

The no-op telemetry stubs in `@omniterm/core` are replaced with a real,
privacy-gated implementation backed by PostHog. The event taxonomy and the six
call sites are unchanged — the rewrite preserves every exported signature, so
`pnpm -r typecheck` is green with no call-site edits. Gating is **fail-closed**
and unit-proven across the full opt-out truth table; the only correlation key is
a random anonymous install id; performance timings flow into a bounded local
ring buffer (behind the existing `GET /api/metrics/perf`) **independently** of
phone-home.

`POSTHOG_KEY` carried the maintainers' PostHog write-only key at the time of this run, so the
published build is **active by default (opt-out)**. `posthog-node` is kept
**external** (a host runtime dependency, like express), so the host tarball grows
only +0.67% and posthog patches flow via semver. All unit tests run with
telemetry forced off (`NODE_ENV=test` + explicit opt-out), so the suite sends no
data.

## Commands Run

| Command | Result |
| --- | --- |
| `pnpm -r typecheck` | PASS — call sites compile unchanged against the new module |
| `pnpm --filter @omniterm/core test` | PASS — 115/115 (was 93; +22 telemetry, incl. 2 front-end client tests) |
| `pnpm --filter <plugin> test` (plugin now out-of-tree) | PASS — 4/4 |
| `pnpm --filter @omniterm/host build` | PASS — posthog-node external (not inlined); bundle minified, no maps; client (Settings UI) builds |
| `omniterm telemetry status/off/on` (isolated SETTINGS_DIR) | PASS — writes/reads settings.json `telemetryEnabled`; DO_NOT_TRACK shows as override |
| `resolveTelemetryConfig({}, false)` (tsx) | PASS — enabled=true, host `us.i.posthog.com`, key set |
| **Manual E2E** (real `telemetry.ts` path + `captureImmediate`) | PASS — init enables; real `server_started`+`session_created` flushed; `captureImmediate` ACCEPTED by `us.i.posthog.com`; `DO_NOT_TRACK=1` disables (no client). Events landed in the analytics project (`omniterm_e2e_verify`, `distinct_id` `e2e-verify-*`). |
| Tarball size delta vs `@omniterm/host@0.2.11` | +2,980 B gzip (**+0.67%**) — posthog-node external; under the +1% gate |

## New tests (15)

- `telemetryConfig.test.ts` — gating truth table: every opt-out signal +
  empty-key ⇒ disabled; enabled-by-default with the embedded key + clean env;
  `DO_NOT_TRACK=0` is not opt-out; EU host override honored.
- `telemetry.test.ts` — `buildProps` allowlist (no PII keys); disabled when
  opted out + no throw on init; perf recorded locally while disabled.
- `installId.test.ts` — anon UUID create-once/persist/idempotent; corrupt/missing
  ⇒ null; `markNoticeShown` preserves the id (temp-dir isolated).
- `perfBuffer.test.ts` — bounding/eviction at cap 100; defensive copy.

## Coverage vs spec

| Expectation | Status |
| --- | --- |
| Fail-closed gating, zero outbound when disabled (FR-006/FR-012/SC-002) | PASS (unit) |
| Anonymous, no PII/paths/hostnames/repo/contents (FR-003/SC-004) | PASS (unit + call-site review) |
| Local perf independent of opt-out (FR-004/SC-006) | PASS (unit + static endpoint) |
| Six events + unchanged signatures (FR-001/FR-002) | PASS (typecheck) |
| Best-effort, bounded shutdown (FR-009/FR-010/SC-003) | PASS (code + no-throw init) |
| First-run disclosure + README (FR-008) | PASS (code + README "Telemetry") |
| Inert until key; region configurable (FR-011) | PASS (config + bundle) |
| CLI opt-out `omniterm telemetry on/off/status` + `--no-telemetry` (FR-013) | PASS (smoke) |
| Settings UI Privacy toggle, shared persisted setting (FR-007/FR-014) | PASS (typecheck + shared-field wiring) |
| Front-end curated events + perf, no PII (FR-015) | PASS — 9 events incl. `terminal_rendered`; `buildCapturePayload` unit-tested (no PII keys) |
| Front-end gated by same opt-out via `/api/telemetry` (FR-016) | PASS — gate returns key/host/distinctId enabled, nothing disabled (unit); client arms only when enabled |
| Shared anon id; custom client, no SDK (FR-017) | PASS — events POST to `/capture/` with the shared distinctId; live opt-out unit-tested |
| Footprint: custom fetch client (no posthog-js) | PASS — no posthog chunk; **host tarball delta -0.04% vs 0.2.12** (was +14% full / +8.1% slim). Publish passes at the default +1% gate. |
| Client bundle minified, no source maps | PASS — 0 `.map` files; all chunks minified (vite production) |

## Residual risks / proof gaps

1. **Live delivery confirmed via manual E2E** (`captureImmediate` accepted by
   `us.i.posthog.com`; real-path events flushed to the analytics project), satisfying
   SC-001. SC-002 is proven at the construction level — `DO_NOT_TRACK=1` makes
   `isTelemetryEnabled()` false so no client is created and nothing is sent; a
   packet-level sniff is optional belt-and-suspenders. (E2E ran from a dev
   machine, not the published tarball — re-confirm once post-publish if desired.)
2. **Shutdown-timeout race** verified by reading + the no-throw init test, not a
   fault-injection test (hanging `client.shutdown()`).
3. **PII absence** enforced on the context builder + call-site review, not a
   runtime payload scanner.

## Code review (high-effort, 7 finder angles + verify)

Fixed in this change:

- **Event delivery**: PostHog client now uses `flushAt: 1` so each low-volume
  event is sent promptly rather than buffered for the batch interval — the
  standalone CLI may be killed without a graceful `handle.shutdown()`, so we
  don't rely on a shutdown flush to drain a batch.
- **`shutdownTelemetry` timer leak**: the 2s race timer is now `unref()`'d and
  `clearTimeout`'d in a `finally`, and `client.shutdown(2000)` is itself bounded
  — no lingering timer delaying a graceful (non-`process.exit`) shutdown.
- **Reuse**: `installId.ts` now imports `SETTINGS_DIR` from `paths.ts` instead of
  recomputing `process.env.SETTINGS_DIR || ~/.omniterm` (kept config-dir
  resolution in one place).
- **Single id-creation path**: `setOptOut` delegates to `getOrCreateInstallId`
  rather than minting its own UUID.

Considered and intentionally **not** changed:

- **CLI shutdown-flush hook**: `src/server.ts` discards the `startServer` handle
  and registers no signal handler, so `handle.shutdown()` (which flushes) runs
  only for embedders/tests, not the CLI. Adding it would make `handle.shutdown()`
  → `server.close()` block on draining the browser's open SSE connections,
  turning instant Ctrl-C into an up-to-5s wait (launcher force-kill belt). With
  `flushAt: 1`, events are already sent promptly, so prompt flush — not a
  shutdown hook — is the chosen delivery guarantee. FR-010's flush-on-graceful-
  shutdown is satisfied via the `handle.shutdown()` path for embedders.

Deferred (best-effort anon-id, low impact — recorded as residual risk):

- Two simultaneous *first-run* processes can mint divergent install ids (per-pid
  temp files mean both renames succeed; the re-read converges only if it follows
  all renames). Rare; worst case two anon ids for one machine.
- A read-only/full config dir makes `getOrCreateInstallId` return an unpersisted
  UUID, yielding a new id each boot. By-design best-effort; no correctness break.

## Activation status

- ✅ `POSTHOG_KEY` set to the maintainers' write-only key (since changed: injected at release-build time, absent from source);
  region US (`https://us.i.posthog.com`), EU overridable via `OMNITERM_POSTHOG_HOST`.
- ✅ `posthog-node` external (host dependency) — republish needs no special
  size threshold (+0.67%, under the +1% gate).
- ✅ Manual E2E: real-path events + `captureImmediate` delivered to project
  the analytics project (SC-001); `DO_NOT_TRACK=1` disables the client (SC-002, construction-level).
- ☐ Optional: re-confirm from the published tarball after release; remove the
  `omniterm_e2e_verify` / `e2e-verify-*` test rows from the project.
