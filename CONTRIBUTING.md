# Contributing to omniterm

This guide explains how to run omniterm from source and how the repository is
organized.

## Requirements

- Node.js 24 or newer
- pnpm 11.1.2
- TypeScript 5
- `tmux` and `ttyd` for terminal integration tests
- Chromium through Playwright for the browser terminal input test

The codebase uses strict TypeScript and ECMAScript modules (ESM).

## Set up the project

Install the dependencies:

```bash
pnpm install
```

Start the development server:

```bash
pnpm run dev
```

Then open <http://localhost:17717>.

## Run the checks

Run the unit and integration tests:

```bash
pnpm test
```

Check the TypeScript types:

```bash
pnpm typecheck
```

Some integration tests skip themselves when their extra tools are not
installed. On macOS, install the terminal tools with:

```bash
brew install tmux ttyd
```

Install Chromium for the browser terminal input test with:

```bash
pnpm exec playwright install chromium
```

## Repository layout

| Folder | Purpose |
| --- | --- |
| `apps/omniterm` | The published `@omniterm/host` app and `omniterm` command |
| `packages/core` | The web interface, server, built-in terminal, and shared host code |
| `packages/plugin-types` | The public TypeScript contract for plugin authors |
| `plugins` | Optional plugins and plugin fixtures |
| `docs` | Product requirements, roadmap, and project policies |
| `specs` | Detailed feature specifications and implementation records |
| `tests/agent` | Manual verification suites that can be run by an agent or human |

`@omniterm/core` is bundled into the host and is not published separately.
External plugins should depend only on `@omniterm/plugin-types`, not on core.

## How the code is organized

omniterm runs as one Node.js host process and delegates terminal work to `tmux`
and `ttyd`.

- The Express server provides the browser app and APIs for repositories,
  worktrees, files, settings, and plugins.
- Server-Sent Events notify the browser when tabs or files change.
- Each terminal is a `tmux` session displayed by a separate `ttyd` process.
- The host proxies terminal HTTP and WebSocket traffic under
  `/t/:sessionId/*`.
- Plugins own their user interface, HTTP routes, and WebSocket upgrades. The
  built-in terminal is also a plugin.
- omniterm saves interface state in one JSON file. `tmux` owns live terminal
  state, so no database is needed.

The host must remain independent of optional plugins. The
`packages/core/clean-cut-boundary.test.ts` test fails if host code imports one.

## Specifications and project documents

Read these files before making a related change:

- `docs/prd.md` describes the product requirements.
- `docs/feature-breakdown.md` contains the roadmap.
- `specs/*/spec.md` contains detailed feature requirements.
- `docs/client-bundle-policy.md` explains the browser bundle limits and the
  build checks that enforce them.

Specifications are the source of truth for a feature. The task lists under
`specs/*/tasks.md` are archived implementation records, not current to-do
lists.

## Keep the READMEs synchronized

The repository root `README.md` is the source of truth for user documentation.
The npm package is published from `apps/omniterm`, so the same README is copied
there for the npm package page.

After changing the root README, run:

```bash
pnpm readme:sync
```

The test suite detects a stale package copy, and the package build synchronizes
it again before creating a release.

## Telemetry in source builds

The official release receives its PostHog key during the release build. The key
is not stored in this repository, so a normal source build does not send
telemetry.

To send telemetry from a source build to your own PostHog project, set
`OMNITERM_POSTHOG_KEY` when you run omniterm. Do not commit the key.
