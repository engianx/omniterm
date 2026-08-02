# Feature Breakdown

## Source Material

- `docs/prd.md`
- Public requirements for a generic, pluggable host/SDK, a clean plugin
  boundary, and scoped `@omniterm/*` packaging.

## Sequencing Principles

- Specs are the feature source of truth.
- Code is an implementation artifact.
- Tests, verification reports, and reviews are evidence.
- Specs are current snapshots, not historical logs; git history records history.
- Replaced behavior is removed from active specs after the replacement is
  accepted.
- Spec/code/test drift must be reconciled or clarified with the user.
- Work on one active feature at a time.
- Use stable feature IDs; do not renumber without explicit approval.

## Roadmap

### 001 - omniterm core

Goal: A generic, standalone browser-based host providing persistent terminals, a
live browser-view panel, and workspace/file/settings management — usable on its
own with no plugins.

PRD coverage:

- FR-001 (persistent terminals), FR-002 (browser-view registry), FR-003
  (workspace/file management), FR-004 (settings), FR-009 (CLI), NFR-001/002/003.

Primary outputs:

- `@omniterm/core` SDK (`startServer`, terminal plugin as built-in, browser
  registry, workspace/repos/worktrees, settings, file routes).
- `@omniterm/host` app exposing the `omniterm` CLI.
- Repo scaffolding: pnpm workspace (`apps/* packages/* plugins/*`), tsconfig,
  eslint, vitest, tsup build.

Quality focus:

- Boot with zero plugins; terminal persistence across reconnect; browser
  registers and renders; workspace repo add/remove over HTTP. Port existing unit
  tests (paths, repos, worktrees, startServer, tabRegistry, languages,
  workspaceSelection).

Dependencies: none.

### 002 - plugin platform

Goal: Make omniterm extensible at runtime so plugins add tab types without a host
rebuild, and so plugins never depend on host internals.

PRD coverage:

- FR-005 (`--plugin` loader), FR-006 (manifest-driven iframe client), FR-007
  (widened `HostContext`), FR-008 (clean-cut guarantee), NFR-004.

Primary outputs:

- `--plugin <path|name>` CLI loader (repeatable; CWD-first resolution for bare
  names) with dynamic `import()` + plugin factory contract.
- `GET /api/plugins` manifest endpoint; generic manifest-driven client rendering
  of `[+]` entries, file handlers, indicators, and persisted iframe tabs.
- `HostContext` extended with `allowedRoots`/`confinePath`/settings/repos/
  worktrees so plugins use the public API only.
- `@omniterm/plugin-types` — the contract as a standalone, type-only published
  package (`TabTypePlugin`, `HostContext`, `PluginInstance`, `TabInstance`,
  `SpawnArgs`, `PluginManifestEntry`, plus the `Repo`/`Worktree`/`Settings`
  shapes reachable through `HostContext`). Core re-exports all of it, so a
  plugin can be built in a separate repository with no dependency on core and
  nothing to install at runtime. Added when the host was open-sourced: before
  it, an out-of-tree plugin had no typed contract to import at all.
- Terminal "open with initial command" capability for run-in-terminal file
  handlers.

Quality focus:

- A trivial fixture plugin loads by both path and name; manifest drives the UI
  with no client rebuild; multiple plugins compose; removing all plugins leaves
  the host fully working.

Dependencies: 001.

### 003 - first out-of-tree plugin

> **Spec lives in another repository.** This feature shipped as a plugin
> developed and published separately, so `specs/003-*` is not in this repo — it
> lives alongside the plugin's own source. That separation is the feature: the
> host cannot see the plugin, at build time or in its specs.

Goal: Deliver the first real plugin — a YAML test debugger — as a
self-contained, deletable package, proving the plugin boundary end to end.

PRD coverage:

- FR-006/FR-007/FR-008 exercised by a real plugin; example for plugin authors.

Primary outputs:

- A debugger plugin package (runtime deps: `express` plus the debugger engine it
  adapts; types from `@omniterm/plugin-types`) — an adapter exposing a
  third-party engine through the manifest, using only the public plugin API. It
  is developed and published from its own repository, which is the strongest
  available proof the plugin boundary holds.

Quality focus:

- Clean-cut acceptance gate (SC-003): the host builds and boots with no plugin
  present — now permanently true, since the debugger plugin lives in a separate
  repository and this one contains no copy of it. With the plugin loaded via
  `--plugin`: `*.test.yaml` → "Open in debugger" works over the
  manifest/iframe path. `packages/core/clean-cut-boundary.test.ts` keeps the
  invariant honest by failing if host or core ever names an external plugin in
  an import specifier.

Dependencies: 001, 002.

### 004 - telemetry

Goal: Give the maintainers pseudonymous insight into how installed hosts are
used and how they perform, with a reviewed payload and a first-class,
fail-closed opt-out.

PRD coverage:

- FR-010 (pseudonymous usage + performance telemetry, opt-out, fail-closed).

Primary outputs:

- Fail-closed gating resolution: any opt-out signal, an unconfigured
  destination, or an automated/CI context disables all outbound calls.
- A stable random installation id; payloads carry no names, hostnames, paths,
  plugin identifiers, or content, and disable GeoIP enrichment explicitly.
- Opt-out on three surfaces that share one stored value: CLI (`omniterm
  telemetry on|off|status`), the Settings panel, and environment signals
  (including the cross-tool `DO_NOT_TRACK`).
- A bounded local performance buffer served at `GET /api/metrics/perf`,
  available whether or not telemetry is on.
- The destination key is injected at release-build time, never committed, so a
  source or fork build sends nothing.

Quality focus:

- The gating truth table is unit-tested; "disabled ⇒ the client is never
  constructed" is asserted rather than inferred. Payload construction is tested
  to enforce GeoIP suppression and exclude disallowed fields.

Dependencies: 001.

### 005 - richer file viewers

Goal: Open non-text files in the file panel as themselves — images, PDFs, and
CSV/TSV — instead of rendering them as garbage text.

PRD coverage:

- FR-011 (dedicated viewers, path-confined delivery, on-demand loading).

Primary outputs:

- Extension-based dispatch to an image viewer (zoom/pan/pinch, dimensions and
  size), a PDF viewer (text layer and in-document find), and a virtualized
  CSV/TSV table.
- Content delivered through the existing path-confined raw route rather than a
  new unconfined one; the previous base64-in-JSON image path is replaced.
- Each viewer is a lazily-loaded chunk, so the eager client bundle is unchanged
  for users who never open one.

Quality focus:

- The entry-chunk size gate stays green — the guard that keeps "loaded on
  demand" honest. Unrecognized extensions must keep their existing behavior.

Dependencies: 001.

### 006 - mobile terminal input

Goal: Make the terminal genuinely usable from a phone or tablet, where the soft
keyboard has no Esc, Tab, arrows, or Ctrl.

PRD coverage:

- FR-012 (mobile input chrome and single-delivery compose path).

Primary outputs:

- A mobile-only accessory bar supplying Esc, Tab, arrows, and sticky-Ctrl
  combos, docked above the on-screen keyboard and pinned as it moves.
- A compose field that owns its own value, so dictated or typed text arrives
  once rather than as duplicated fragments.
- Delivery through the existing same-origin terminal handle, with arrow bytes
  chosen from the terminal's live cursor-key mode.

Quality focus:

- Byte-level assertions against a real terminal for both cursor modes; the
  check skips cleanly where the tooling is absent rather than failing.

Dependencies: 001.

### 007 - clean session environment

Goal: Prevent arbitrary host-process environment variables from leaking into
new terminal panes while preserving an explicit compatibility allowlist.

PRD coverage:

- FR-013 (clean terminal environment for sessions, splits, and new windows).

Primary outputs:

- An `env -i` shell bootstrap with an explicit terminal, locale, GUI, and
  SSH-agent allowlist.
- The same clean environment for initial commands, splits, and new tmux windows.
- Unit and isolated real-tmux regression coverage.

Dependencies: 001.

## MVP Boundary

The MVP is complete when:

- `omniterm` boots standalone with terminals + browser view (SC-001).
- The plugin platform loads plugins by path and name and composes them (SC-002).
- The debugger plugin works as a loaded plugin and the clean-cut gate passes
  (SC-003, SC-004).

Features 004-007 shipped after this boundary and are specified independently;
they extend the host rather than changing the MVP definition.

## Release Notes

- `@omniterm/host` and `@omniterm/plugin-types` are the published artifacts;
  `@omniterm/core` stays private and is bundled into the host. Plugins publish
  independently, on their own schedules.
- Downstream consumers launch `omniterm --plugin <name>` with whatever plugin
  set they need; the host has no knowledge of any consumer.
- The browser registry env var is `OMNITERM_BROWSER_REGISTRY_URL`, auto-set on
  every terminal in 001; the launch shim is `omniterm-browser`. Any tool that
  wants its browser to appear in the panel reads that variable and POSTs its CDP
  URL to it — the host knows nothing about which tool is registering.
