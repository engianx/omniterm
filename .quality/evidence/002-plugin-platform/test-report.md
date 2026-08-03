<!-- RECOVERED EVIDENCE. This file records a verification run performed while
omniterm was developed inside a larger private product, before the host was
open-sourced into this repository. Measurements and dates are left as recorded —
they are historical evidence, not current claims. Vendor identifiers were
scrubbed, and any claim that no longer holds is marked inline (SUPERSEDED /
UNAVAILABLE / EXTERNAL). Proof mappings in the accompanying quality-map.yaml were
reconciled against this repository and are current. -->

# Test Report: plugin platform (002-plugin-platform)

**Quality map**: [quality-map.yaml](./quality-map.yaml)
**Branch / commit**: `jade` (uncommitted working tree)
**Last updated**: 2026-06-15
**Tester**: Claude (agent)

## Summary

**Overall status: PASS (platform)** · **Confidence: MEDIUM**

The plugin platform — runtime `--plugin` loader, `GET /api/plugins` manifest, the
manifest-driven client, and the widened `HostContext` — is implemented, reviewed
twice (`/code-review max` on the contract foundation and on the platform), fixed,
and verified by unit tests + end-to-end server smoke + the clean-cut gate.
Confidence is MEDIUM (not HIGH) because the browser-rendered client behavior
(iframe persistence, `[+]`/file-handler UX) is not yet agent-verified, and
**FR-006 (terminal run-in-terminal, T009) is deferred / not implemented**.

## Commands Run

| Command | Result |
| --- | --- |
| `pnpm -r typecheck` | PASS (core + host) |
| `pnpm --filter @omniterm/core test` | PASS — **89/89** (75 ported + 14 new: 8 reconcile, 6 manifest) |
| `pnpm --filter @omniterm/host build` | PASS |
| Smoke: `--plugin <path>` and `--plugin @omniterm/fixture-plugin` | PASS — manifest served, create→{id}, iframe HTML, list |
| Smoke: zero-plugin boot, `GET /api/plugins` | PASS — HTTP 200, `{"plugins":[]}` |
| Smoke: fixture XSS (`/fixture/<script>`) | PASS — escaped to `&lt;script&gt;` |
| Clean-cut: build core+host with `plugins/_fixture-plugin` removed | PASS — typecheck + build green; then restored |
| Clean-cut: `pnpm --filter @omniterm/core test` (`clean-cut-boundary.test.ts`, 2 cases) | PASS — no external-plugin import in host/core source; host has no plugin dependency |
| Loader: `pnpm --filter @omniterm/core test` (`pluginLoader.test.ts`, 11 cases) | PASS — parse + validate fail-fast (missing value, plugin/factory shapes, missing type, throwing factory, duplicate type) |
| Confinement: `pnpm --filter <plugin> test` (plugin now out-of-tree) (`adapter-confinement.test.ts`, 3 cases) | PASS — out-of-root → 403, missing → 400, in-root passes gate |

## Coverage Matrix

| Expectation | Risk | Depth | Status | Residual risk |
| --- | --- | --- | --- | --- |
| clean-cut-boundary | 5 | DIRECT (unit test + build-with-removed) | COVERED | Build-with-removed gate not yet automated in CI |
| plugin-loader | 4 | DIRECT (parse+validate units + manifest validate) + smoke | COVERED | Only module resolution + dynamic import() (host) remains smoke-only |
| manifest-driven-client | 4 | DIRECT (units + smoke) + MANUAL (browser agent via 003) | COVERED | `[+]`/file-handler/iframe render verified in a real browser (003 browser-verification.html); iframe persistence across tab switches still unverified |
| hostcontext-public-api | 4 | DIRECT (confinePath contract test) + smoke + STATIC | COVERED | Broader HostContext surface (repos/settings) still smoke-only |
| terminal-initial-command | 2 | — | NOT COVERED | **T009 deferred / not implemented** |

## Findings (from `/code-review max`, all fixed)

- Client state bugs (optimistic-seed drop, close-then-resurrect, zombie iframe) →
  reworked into `manifestReconcile.ts` (optimistic set + close tombstone +
  list-aware readiness); now unit-tested.
- `render`/`spawn` were vestigial → made optional; validate is now
  "renderable = manifest OR component render" (fixes an opaque TypeError).
- Duplicate non-empty `proxyPrefix` now fail-fast; `--plugin` missing value
  errors clearly; `OMNITERM_PORT` read for consistency.
- `HostContext` reuses `lib/allowedRoots` (fixes a `homedir()` confinement
  divergence vs the host's own fs routes).
- Fixture XSS (unescaped `req.params.id`) → HTML-escaped.

## Deferred / Residual Risk

- **T009 (FR-006 terminal run-in-terminal)** — not implemented; separable from the
  plugin platform. Retest path: implement + add a test.
- **Browser-rendered client** — `[+]`/file-handler/persisted-iframe UX needs an
  agent/manual browser check with a real plugin (closes the 001 live gaps too once
  a real out-of-tree plugin lands in 003).
- **CI** — a `quality-observations` workflow now emits JUnit + clean-cut/build manifests on PR/push (pending first run); not yet a gating check.

## Runtime Review (2026-06-15)

Runtime review is now wired (local-folder JUnit source; see `.quality-center/`,
owned by the quality-center skill). Observation-backed `quality-tools analyze`
result for this target:

- **clean-cut-boundary** → `partial` (was `unobserved`). The new
  `clean-cut-boundary.test.ts` is observed-passing; the `build-with-plugin-removed`
  script row stays unobserved until a CI gate emits an observation for it.
- **terminal-initial-command** → `unobserved`, correctly — the capability is not
  implemented (T009 deferred; tracked as issue #12), so there is nothing to prove.
- **hostcontext-public-api** → `partial`. A plugin's `host.confinePath` rejection is asserted
  over the wire (the rejection the gap asked for).
  *(Superseded: at the time this was proven by an out-of-tree plugin's confinement test. That
  plugin now lives in its own repository, so the proof was re-established in-repo as
  `packages/core/server/pluginConfinement.test.ts`, driving the fixture plugin over HTTP.)*
- **plugin-loader** → `partial`, now deeply backed: `parsePluginSpecs` + `validatePluginModule`
  were extracted to `@omniterm/core` (throwing `PluginSpecError` instead of `process.exit`) and
  unit-tested in `packages/core/lib/pluginLoader.test.ts` (11 cases). Only the host's module
  resolution + dynamic `import()` remains smoke-only.
- **CI gate wiring**: `build-with-plugin-removed` (clean-cut) now emits a manifest observation
  from the `quality-observations` workflow. It joins under the `ci-observations` evaluation set
  once the workflow runs (needs `GITHUB_TOKEN`) — **pending first CI run**; until then
  `clean-cut-boundary` stays `partial` under the unit-only set. (The shared `clean-cut-boundary.test.ts`
  was also added to 003's map to flip its deletability check.)
- **manifest-driven-client** remains `partial` pending browser/agent render evidence.

## Coverage Summary

The platform's backend contract (loader, manifest endpoint, validate, HostContext)
and the review-fixed client reconciliation logic are directly unit/smoke-tested,
and the clean-cut invariant is now proven by a runtime-observable unit test. The
open gaps are live browser rendering and the deferred FR-006. Confidence: **MEDIUM**.
