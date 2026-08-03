<!-- RECOVERED EVIDENCE. This file records a verification run performed while
omniterm was developed inside a larger private product, before the host was
open-sourced into this repository. Measurements and dates are left as recorded —
they are historical evidence, not current claims. Vendor identifiers were
scrubbed, and any claim that no longer holds is marked inline (SUPERSEDED /
UNAVAILABLE / EXTERNAL). Proof mappings in the accompanying quality-map.yaml were
reconciled against this repository and are current. -->

# Test Spec: omniterm core (001-omniterm-core)

**Scope**: feature — the generic host + SDK port (`@omniterm/core` + `@omniterm/host`)
**Source material**: `specs/001-omniterm-core/spec.md`, `plan.md`, `tasks.md`, `docs/prd.md`
**Quality policy**: [../../quality-policy.yaml](../../quality-policy.yaml)
**Test report**: [test-report.md](./test-report.md)

## Testing What

Behaviors and invariants that must hold for the ported host to be trusted:

- **Boot/serve** (FR-008/SC-001): host starts with zero plugins and serves the SPA.
- **Terminal persistence** (FR-001/SC-002): tmux+ttyd sessions survive reconnect with scrollback.
- **Browser-view registry** (FR-002/SC-003): processes register CDP endpoints to
  `OMNITERM_BROWSER_REGISTRY_URL`; panel shows them tab-scoped; pid-liveness evicts.
- **Path confinement** (FR-006/SC-004): file access rejects paths outside tracked roots (security).
- **Workspace management** (FR-005/SC-004): repos/dirs/worktrees tracked + exposed over HTTP.
- **Settings persistence** (FR-007): settings survive restart.
- **Regression floor** (SC-005): all ported unit suites pass.
- **De-brand consistency**: `OMNITERM_BROWSER_REGISTRY_URL` + `omniterm-browser` shim applied
  consistently; no vendor-prefixed identifiers in shipped code (carve-out since dropped).
- **Build pipeline**: vite client + tsc + tsup + `package.sh` produce a bootable standalone.

## Evidence Strategy

The feature is a validated 1:1 port, so the dominant proof is the carried-over unit
suites plus a full build and a boot smoke. Live, browser-interactive flows (terminal
rendering, shim→panel browser-view, HTTP fs/repos round-trips) are deferred to
agent/manual checks (tasks T016/T017) — cheaper proofs cannot reach them.

## Test Cases

See `quality-map.yaml` for the structured expectation→evidence graph. Commands:

- `pnpm -r typecheck`
- `pnpm --filter @omniterm/core test`  (ported suites, `tsx --test`)
- `pnpm --filter @omniterm/host build`  (vite + tsc + tsup + package.sh)
- Boot smoke: `PORT=<p> node apps/omniterm/standalone/server/server.js` + `curl /`
- De-brand audit: `grep -rniE '<vendor-prefix>' packages/core apps/omniterm`

## Fixtures And Environments

- Local macOS, Node 24, pnpm 11.1.2. Boot smoke needs no tmux/ttyd to serve the SPA;
  interactive terminal/browser-view checks need tmux + ttyd + a Chromium present.

## Report Expectations

`test-report.md` records commands, pass/fail, the coverage matrix, and confidence.

## Coverage Notes

Gaps are live end-to-end flows (T016 browser-view, T017 repo-add/fs-confinement over the
wire) and a cross-repo consumer rename. These are accepted,
documented gaps for 001, not silent omissions.
