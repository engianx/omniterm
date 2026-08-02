# omniterm

Your agent terminals, accessible everywhere.

A generic, standalone, browser-based development host: persistent terminals, a
live browser-view panel, and workspace/file management in one screen, extensible
at runtime through a clean plugin API.

omniterm is domain-agnostic. Domain-specific behavior (such as a YAML test
debugger) ships as separate, optional plugins that can be added or removed
without touching the host.

## Why omniterm?

- **Built for AI agents** — run Claude Code, Codex, or any CLI agent in a terminal
- **Always running** — 24/7, persist across browser closes, network drops, and device switches
- **Work from anywhere** — start on your desktop / cloud, continue from your iPad, smartphone
- **Easy setup** — one command to start, accessible through the browser. No SSH tunnels
- **Lightweight** — fast first load; editor grammars load on demand, so you only download the languages you open

## Quick Start

Install the prerequisites (`tmux` + `ttyd`):

```bash
# macOS
brew install tmux ttyd

# Ubuntu/Debian
sudo apt install tmux
sudo snap install ttyd --classic
```

Then install and run:

```bash
npm install -g @omniterm/host
omniterm
# Open http://localhost:17717
```

The npm package is **`@omniterm/host`**; the command it installs is
**`omniterm`**. No install? Run it directly with `npx @omniterm/host`.

Use a custom port, or override the internal ttyd port range (7700-7799) if it
conflicts:

```bash
omniterm --port 8080
omniterm --ttyd-ports 8800-8899
```

Run `omniterm --help` for all options.

### Plugins

`--plugin` is repeatable; plugins compose in order. Enable one by published
package name or local path:

```bash
omniterm --plugin @scope/my-plugin                    # by published package name
omniterm --plugin ./plugins/demo-agent/dist/index.js  # ...or by path (dev)
```

A path must point at the plugin's built entry file — a bare directory is not a
resolvable ES module.

Writing your own plugin takes one dev dependency —
[`@omniterm/plugin-types`](packages/plugin-types) — and no dependency on the
host's internals. `plugins/demo-agent` is a complete worked example.

A full user-facing feature tour lives on the
[`@omniterm/host` npm page](https://www.npmjs.com/package/@omniterm/host).

## Packages

| Package | Path | Published | Notes |
| --- | --- | --- | --- |
| `@omniterm/host` | `apps/omniterm` | yes | CLI; bin: `omniterm` |
| `@omniterm/core` | `packages/core` | no (bundled) | host SDK |
| `@omniterm/plugin-types` | `packages/plugin-types` | yes | type-only plugin contract |
| `@omniterm/demo-agent-plugin` | `plugins/demo-agent` | no | example plugin (coding-agent panel) |

Plugins are published from their own repositories on their own schedules. The
host has never imported one — `packages/core/clean-cut-boundary.test.ts` fails
the build if it ever does.

## Architecture

omniterm is a single Node process that serves a browser UI and brokers
everything else out to proven system tools.

- **Host process** — an Express + WebSocket server (`@omniterm/core`'s
  `startServer`). It serves the client, exposes a small REST surface for
  workspace / repo / file / settings operations, and streams host events (tab
  lifecycle, file changes) to the browser over Server-Sent Events
  (`/api/events`).
- **Terminals** — each terminal is a `tmux` session fronted by a `ttyd`
  instance on a loopback port; the host transparently reverse-proxies ttyd's
  HTTP and WebSocket traffic (`http-proxy`) under `/t/:sessionId/*`. The host
  ships no terminal emulator of its own — rendering is ttyd's xterm in the
  browser.
- **Plugins** — a tab type is a plugin that owns its HTTP routes, its
  WebSocket upgrades, and its UI (an iframe or a mounted component). Plugin
  upgrades take precedence over the terminal proxy in the upgrade dispatcher,
  so a plugin can claim its own `/ws/...` path. The built-in terminal is
  itself a plugin — proof the seam is real.
- **State** — workspace, session, file-tab, and layout state persist to a
  single JSON file under the user's home directory; tmux owns live terminal
  session state. There is no database.

## Design principles

These are deliberate trade-offs, not incidental ones. Each buys a property we
consider core.

**Server-first, browser-delivered.** The product is a server you run on the
machine where your work lives; the UI is any browser. Install it once on the
box and reach it from a laptop, tablet, or phone — nothing installed
client-side, no pairing step, no per-device version lock-step. That is the
opposite trade-off from a thick installed client, which must be deployed and
updated on every device it runs on. The one cost — you have to run a process
somewhere — is exactly what makes "work from any device" free.

**Delegate persistence to tmux; don't own it.** Because every terminal is a
real tmux session, sessions survive browser disconnects, network drops, and
host restarts for free — and they are never captive to omniterm. You can `ssh`
into the same machine and `tmux attach` the very session you were driving in
the browser; a session you started by hand over SSH is discovered and adopted
into the UI; and if the host process dies, your long-running work keeps going.
A client that bundles its own multiplexer can persist across *its own*
restarts, but those sessions live and die inside that one app. Ours don't.

**Thin, standard, inspectable.** The host is small and assembled from
components an operator already understands — Node, Express, tmux, ttyd. It
deploys on a headless cloud box with no display server, no GPU, and no native
build step; it is small enough to audit and fast to start. Footprint and a
no-surprises runtime are treated as features, not afterthoughts.

**A plugin boundary that actually holds.** Domain behavior lives in plugins
loaded at runtime by path or package name — composable, and each one deletable
without the host noticing. The host SDK (`@omniterm/core`) carries no
product-specific dependencies, so the same host can be embedded by unrelated
consumers, each enabling its own plugin set with no compile-time coupling.
Extensibility here is a designed-in boundary, not a fork point.

## Development

Product intent lives in `docs/prd.md`, the roadmap in
`docs/feature-breakdown.md`, and per-feature specs in `specs/`. Specs are the
source of truth; code is an artifact; tests are evidence. Task lists under
`specs/*/tasks.md` are archived implementation records, not current checklists.

Before touching the client bundle or adding a browser dependency, read
[docs/client-bundle-policy.md](docs/client-bundle-policy.md) — two build gates
enforce it.

- Workspace layout: `apps/*` (products), `packages/*` (libraries), `plugins/*`
  (optional, deletable host extensions).
- Node.js 24+, TypeScript 5 (strict, ESM only), pnpm.

```bash
pnpm install
pnpm run dev
# Open http://localhost:17717
```

`pnpm test` runs the unit and integration suites; `pnpm typecheck` is a hard
gate in CI. Two integration tests self-skip unless their tools are present:

```bash
brew install tmux ttyd              # terminal session + ttyd proxy tests
pnpm exec playwright install chromium   # xterm byte-level injector test
```

### Telemetry in a source build

The PostHog key is injected at release-build time and is not in this repo, so a
build from source sends nothing. See
[apps/omniterm/README.md](apps/omniterm/README.md#telemetry) for what the
published package collects and how to turn it off.

## License

MIT
