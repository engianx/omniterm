# OmniTerm

Your agent terminals, accessible everywhere.

## Why OmniTerm?

- **Built for AI agents** — run Claude Code, Codex, or any CLI agent in a terminal
- **Always running** — 24/7, persist across browser closes, network drops, and device switches
- **Work from anywhere** — start on your desktop / cloud, continue from your iPad, smartphone
- **Easy setup** — one command to start, accessible through the browser. No SSH tunnels
- **Lightweight** — fast first load; editor grammars load on demand, so you only download the languages you open

## Quick Start

Install dependencies first:

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

> The npm package is **`@omniterm/host`**; the command it installs is **`omniterm`**.
> No install? Run it directly with `npx @omniterm/host`.

Custom port:

```bash
omniterm --port 8080
```

OmniTerm uses ports 7700-7799 internally for terminal sessions. If this range conflicts, override it:

```bash
omniterm --ttyd-ports 8800-8899
```

Run `omniterm --help` for all options.

## Plugins

omniterm is domain-agnostic — extra functionality is added at runtime via
plugins, without touching the host. Enable one with the repeatable `--plugin`
flag (by published package name or local path):

```bash
omniterm --plugin @scope/my-plugin        # by published package name
omniterm --plugin ./my-plugin/dist/index.js   # ...or by path to its built entry
```

To write your own, the entire contract is one type-only dev dependency,
[`@omniterm/plugin-types`](https://www.npmjs.com/package/@omniterm/plugin-types)
— no dependency on the host's internals.

## What You Get

### Terminals

- Multiple tabs, each containing one or more terminal panes
- Split terminals side-by-side or top/bottom within a tab
- Drag to reorder tabs, double-click to rename
- Sessions survive browser disconnects and server restarts
- Mouse wheel scrollback, native text selection

### Workspaces

- Switch between git repos, worktrees, and directories
- Clone repos or browse the server filesystem to add new workspaces
- Create and manage git worktrees with one click
- Discovers existing tmux sessions automatically — start a session from SSH, see it in the browser

### File Explorer & Editor

- Browse files, edit with syntax highlighting and Cmd+S save
- Supports TypeScript, Python, JSON, Markdown, CSS, HTML
- Auto-refreshes file tree and editor content on window focus
- Unsaved changes protection when switching files

### Mobile & Desktop

- Full terminal experience on phones and tablets
- Add to home screen for a native app feel (PWA)
- Desktop: overlay panels for workspaces and files
- Mobile: full-screen views with touch navigation

## Use Cases

### AI Agent Fleet

Run multiple AI agents in parallel, each in its own workspace. Split terminals to monitor two agents side by side. Review their output in the editor.

### Remote Development

Code on a powerful cloud server from any device. Start a build on your desktop, check results from your iPad. The terminal never stops.

### Pair Programming with AI

One pane for your agent, another for your build server, the editor on the side. The agent writes code, you review and edit — all in one browser tab.

## Remote Access

Access via SSH tunnel or VPN:

```bash
ssh -L 17717:localhost:17717 your-server
open http://localhost:17717
```

Or directly via Tailscale:

```bash
open http://your-server.tailnet:17717
```

## Telemetry

omniterm collects **pseudonymous** usage and performance telemetry to help
improve the tool. Events are correlated with a random installation id that is
not derived from an account, username, hostname, or machine identifier.

The event payload contains:

- the installation id, event timestamp, omniterm version, and event name;
- server platform and Node version;
- coarse server events and properties: server/session counts, session create or
  adoption timings, file language, and cleanup count;
- coarse browser events and properties: app/terminal timing, mobile-vs-desktop,
  workspace kind, panel kind, tab kind, viewer kind, and editor language.

Payloads do not contain names, file or terminal contents, file paths, repository
names, hostnames, session names, or third-party plugin identifiers. Browser
payloads set PostHog's `$geoip_disable` property, and the server client disables
GeoIP enrichment explicitly. PostHog still receives ordinary network transport
data when an event is delivered; consult the destination's privacy policy for
its handling and retention.

It's **opt-out** and off in automated contexts. Disable it any of these ways:

```bash
omniterm telemetry off          # persistent, saved to settings
omniterm telemetry status       # show current state
omniterm --no-telemetry         # disable for a single run

export OMNITERM_TELEMETRY=0     # env: omniterm's own opt-out
export DO_NOT_TRACK=1           # env: the standard cross-tool opt-out
```

You can also toggle it in the **Settings** panel under **Privacy → Telemetry**
(the same persistent setting `omniterm telemetry off` writes). Env signals
override the saved setting. Telemetry is also automatically disabled in CI/test
environments. Performance timings are always available locally (even when opted
out) at `GET /api/metrics/perf`, and nothing leaves your machine when telemetry
is off.

The destination key is injected when the official npm package is built, not
committed to the source tree. A build from a source checkout or a fork has no
key, so telemetry there is off with no way to turn it on by accident. To send
to your own PostHog project, set `OMNITERM_POSTHOG_KEY` in the environment when
you run omniterm — it overrides whatever the build baked in.

## License

MIT
