# omniterm-core

Internal workspace package powering the published [`@omniterm/host`](../../apps/omniterm) CLI.
Exports the React shell, server bootstrap, and tab-type plugin API.

> The published npm package is `@omniterm/host` (in `apps/omniterm`). For
> installation and usage, see the [repository README](../../README.md).

## Library use

```ts
import { startServer } from '@omniterm/core';

startServer({
  port: 17717,
  plugins: [
    // your TabTypePlugin instances; the default terminal plugin
    // is included automatically
  ],
});
```

## Layout

- `bin/` — helper executables bundled into `@omniterm/host`
- `server/` — Express bootstrap + host routes
- `lib/` — events, paths, repos, settings, watcher, worktrees, telemetry
- `app/` — React shell (file panel, top bar, tab UI, settings)
- `browserRegistry/` — tab-local browser registry routes/state/UI
- `plugins/` — `types.ts` plugin API + `terminal/` (default bundled plugin)
- `index.ts` — package entry exporting `startServer` + types
