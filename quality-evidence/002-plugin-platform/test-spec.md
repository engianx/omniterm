<!-- RECOVERED EVIDENCE. This file records a verification run performed while
omniterm was developed inside a larger private product, before the host was
open-sourced into this repository. Measurements and dates are left as recorded —
they are historical evidence, not current claims. Vendor identifiers were
scrubbed, and any claim that no longer holds is marked inline (SUPERSEDED /
UNAVAILABLE / EXTERNAL). Proof mappings in the accompanying quality-map.yaml were
reconciled against this repository and are current. -->

# Test Spec: plugin platform (002-plugin-platform)

**Scope**: feature — runtime plugin platform for `@omniterm/host` + `@omniterm/core`
**Source material**: `specs/002-plugin-platform/{spec,plan,tasks}.md`, `docs/prd.md`
**Quality policy**: [../../quality-policy.yaml](../../quality-policy.yaml)
**Test report**: [test-report.md](./test-report.md)

## Testing What

- **Loader** (FR-001/002/007): `--plugin <spec>` loads by path or CWD-first name,
  repeatable/composing, fail-fast on unresolvable/throwing/duplicate.
- **Manifest** (FR-003/004): `GET /api/plugins` serves data-only descriptors; the
  stock client renders `[+]`/file-handlers/persisted iframes/indicators from them
  with no client rebuild.
- **HostContext** (FR-005): plugins reach host services (confinePath/allowedRoots/
  settings/repos/worktrees) through the public API only; confinement matches the
  host's own fs routes (security).
- **Clean-cut** (FR-008/SC-004): no plugin code statically imported by host/core;
  removing a plugin leaves the host building/booting.
- **Instance reconciliation** (review-hardened): optimistic create seeds, close
  tombstones, list-aware iframe readiness.
- **FR-006** (terminal run-in-terminal): a file handler runs a command in a
  terminal — **deferred (T009), not implemented.**

## Evidence Strategy

Backend contract (loader, manifest endpoint, validate, HostContext) and the pure
reconciliation logic are proven by unit tests + deterministic server smoke. The
clean-cut invariant is proven structurally (no static imports) and behaviorally
(build with the plugin removed). Browser-rendered client UX (iframe persistence,
`[+]`/file-handler interaction) needs an agent/manual browser check — deferred to
when a real out-of-tree plugin and a browser are available; a unit test
can't reach it.

## Test Cases

See `quality-map.yaml` for the expectation→evidence graph. Commands:

- `pnpm -r typecheck`
- `pnpm --filter @omniterm/core test` (89: 75 ported + 8 `manifestReconcile` + 6 `manifest`)
- `pnpm --filter @omniterm/host build`
- Loader smoke: `node standalone/server/server.js --plugin <path>` and `--plugin @omniterm/fixture-plugin`; `curl /api/plugins`, `POST /api/fixture/instances`, `GET /fixture/:id`
- Clean-cut: `mv plugins/_fixture-plugin away && pnpm -r typecheck && pnpm --filter @omniterm/host build` (then restore); `grep` for static plugin imports

## Fixtures And Environments

- `plugins/_fixture-plugin` — dev/test-only plugin exercising manifest + HostContext + iframe.
- Local macOS, Node 24, pnpm 11.1.2. Server smoke needs no tmux/ttyd; browser-UX
  checks need a Chromium + a browser session.

## Report Expectations

`test-report.md` records commands, pass/fail, the coverage matrix, the
`/code-review max` findings (all fixed), and confidence.

## Coverage Notes

Open gaps are the browser-rendered client UX and the deferred FR-006 (T009) —
both documented, neither a silent omission.
