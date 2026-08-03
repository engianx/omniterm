<!-- RECOVERED EVIDENCE. This file records a verification run performed while
omniterm was developed inside a larger private product, before the host was
open-sourced into this repository. Measurements and dates are left as recorded —
they are historical evidence, not current claims. Vendor identifiers were
scrubbed, and any claim that no longer holds is marked inline (SUPERSEDED /
UNAVAILABLE / EXTERNAL). Proof mappings in the accompanying quality-map.yaml were
reconciled against this repository and are current. -->

# Test Report: omniterm core (001-omniterm-core)

**Test spec**: [test-spec.md](./test-spec.md)
**Quality map**: [quality-map.yaml](./quality-map.yaml)
**Branch / commit**: `jade` (uncommitted working tree)
**Last updated**: 2026-06-15
**Tester**: Claude (agent)

## Summary

**Overall status: PASS (structural/port gates)** · **Confidence: MEDIUM**

The 1:1 port of shipyard's `packages/omniterm` + `apps/omniterm` into `@omniterm/core` +
`@omniterm/host` is validated at the unit, build, and boot-smoke layers, with the
de-brand (`OMNITERM_BROWSER_REGISTRY_URL`, `omniterm-browser` shim) applied and audited.
Confidence is MEDIUM rather than HIGH because the live, browser-interactive flows
(terminal rendering, browser-view shim→panel, HTTP fs/repos round-trips) are not yet
covered by auditable agent/manual runs, and the cross-repo consumer rename is
deferred to the integration phase.

## Source Material

`specs/001-omniterm-core/{spec,plan,tasks}.md`, `docs/prd.md`, `quality-policy.yaml`.

## Commands Run

| Command | Result |
| --- | --- |
| `pnpm -C omniterm-emerald install` (CI=true) | PASS — 3 workspace projects; esbuild built (`allowBuilds`) |
| `pnpm -r typecheck` | PASS — `@omniterm/core` + `@omniterm/host` clean |
| `pnpm --filter @omniterm/core test` | PASS — **75/75** tests, 6 suites, 0 fail |
| `pnpm --filter @omniterm/host build` | PASS — vite (86 modules) + tsc + tsup (`dist/server.js` 89.95 KB) + standalone assembled; bin shims staged |
| Boot smoke (`node standalone/server/server.js` + `curl /`) | PASS — HTTP 200, SPA index served, devtools bundle mounted at `/devtools/` |
| `grep -rniE '<vendor-prefix>' packages/core apps/omniterm` | PASS — none in source (the vendored-DevTools carve-out has since been dropped) |
| `esbuild --version` | PASS — `0.27.7` (build toolchain functional) |

## Tests Added Or Updated

None authored this pass — the ported suites were carried over unchanged (the port goal).
One source bug fixed via the code-review pass (see Findings): `bin/xdg-open` shim.

## Coverage Matrix

| Expectation | Risk | Depth | Status | Residual risk |
| --- | --- | --- | --- | --- |
| host-boots-standalone | 5 | DIRECT (smoke + integration) + MANUAL (browser agent) | COVERED | Interactive UI verified in a real browser (003 browser-verification.html): client renders, terminals attach to live tmux, workspace/file panels work |
| terminal-session-persistence | 4 | INDIRECT (unit) | PARTIAL | Live "survives reload + scrollback" unverified |
| browser-view-registry | 4 | DIRECT (unit) | PARTIAL | Live shim→registry→panel chain unverified (T016) |
| workspace-path-confinement | 5 | DIRECT (unit) | PARTIAL | Out-of-root reject not exercised over HTTP |
| workspace-repo-management | 3 | DIRECT (unit) | PARTIAL | Live POST /repos + file panel render (T017) |
| ported-suites-regression-floor | 3 | DIRECT (unit) | COVERED | No CI wiring yet (local only) |
| debrand-registry-consistency | 4 | STATIC (grep) + build/boot | COVERED | the downstream consumer still reads old name (cross-repo, deferred) |
| build-standalone-pipeline | 4 | DIRECT (script + smoke) | COVERED | CI artifact smoke wired (quality-observations workflow); no dry-run publish / size-delta yet |
| settings-persistence | 2 | DIRECT (unit) | COVERED | Round-trip + per-path deep-merge + tabLayouts→terminalTabs migration unit-tested |

## Findings

- **FIXED (code-review max):** `packages/core/bin/xdg-open` still `exec`'d the renamed
  the vendor-prefixed browser shim (extensionless file missed by the sed) → would ENOENT for
  `xdg-open <url>` inside tabs. Corrected to `omniterm-browser.js`; verified staged +
  executable after build. Also fixed stale `.gitignore` shim name and the `AGENTS.md`
  release runbook package names/filters.
- **Refuted (empirically):** `allowBuilds` is the correct pnpm 11.1.2 key (esbuild builds);
  React does not leak into the host server bundle (tsup build clean).

## Deferred / Residual Risk

- **T016 — browser-view end-to-end** (live): shim → `OMNITERM_BROWSER_REGISTRY_URL` → SSE →
  panel render → CDP proxy. Retest path: agent/manual browser check once a Chromium is available.
- **T017 — workspace over the wire** (live): POST /repos round-trip + file-panel render +
  out-of-root fs rejection. Retest path: agent/contract check.
- **Cross-repo `the downstream consumer` rename**: update + release its own repository to read
  `OMNITERM_BROWSER_REGISTRY_URL` before 003/testbox consume it; then the live browser-view
  chain can be verified end-to-end.
- **CI**: no workflow yet; suites run locally only.

## Cleanup

Boot-smoke server process terminated. Build artifacts (`dist/`, `standalone/`,
staged `bin/omniterm-browser.js` + `bin/xdg-open`) left in the working tree; they are
gitignored.

## Runtime Review (2026-06-15)

Runtime review is wired (local-folder JUnit + a CI `quality-observations` workflow;
see `.quality-center/`). Changes this pass:

- **settings-persistence** → observed PASS. New `packages/core/lib/settings.test.ts`
  round-trips `saveSettings`/`loadSettings` against a temp `SETTINGS_DIR` and covers the
  `tabLayouts→terminalTabs` migration — also a regression guard for that migration.
- **build-standalone-pipeline** → a CI **build-artifacts smoke** is wired (the
  quality-observations workflow builds the host and asserts the standalone artifacts +
  bin shims). It produces an observation under the `ci-observations` evaluation set once
  the workflow runs (needs `GITHUB_TOKEN` + a completed run) — **pending first CI run**.
- The live/browser gaps (browser-view chain, over-the-wire fs/repos) remain unobserved
  under the unit-only set — they need agent/browser evidence, as documented below.

## Coverage Summary

Port integrity, build, and the de-brand are well-evidenced (unit + build + boot + static
audit), and settings persistence is now directly unit-tested. The open gaps are all
**live, interactive** flows and the cross-repo rename — known, documented, and appropriate
to close with agent/manual checks in the integration phase rather than with brittle unit
stand-ins. Confidence: **MEDIUM**.
