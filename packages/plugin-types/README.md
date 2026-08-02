# @omniterm/plugin-types

The type-only contract between [omniterm](https://github.com/engianx/omniterm) and
its tab-type plugins. Every export is a TypeScript `interface` or `type` — there is
no runtime code, and every import of this package is erased at build time.

Install it as a dev dependency, keep it external in your bundler, and install
Express as a runtime dependency:

```bash
npm install --save-dev @omniterm/plugin-types
npm install express
```

```ts
import { Router } from 'express';
import type { TabTypePlugin } from '@omniterm/plugin-types';

export default function createMyPlugin(): TabTypePlugin {
  let nextId = 1;

  return {
    type: 'my-plugin',
    label: 'My Plugin',
    proxyPrefix: '',
    manifest: {
      type: 'my-plugin',
      label: 'My Plugin',
      ephemeral: true,
      tabTypeChoice: { label: 'My Plugin' },
      endpoints: { create: '/api/my-plugin/instances' },
      iframe: { urlTemplate: '/my-plugin/{id}' },
    },
    createRouter() {
      const router = Router();
      router.post('/api/my-plugin/instances', (_req, res) => {
        res.json({ id: `my-plugin-${nextId++}`, name: 'My Plugin' });
      });
      router.get('/my-plugin/:id', (_req, res) => {
        res.type('html').send('<!doctype html><h1>My Plugin</h1>');
      });
      return router;
    },
  };
}
```

Load it into a running host with `omniterm --plugin <package-or-path>`.

## What's in here

| Export | Purpose |
| --- | --- |
| `TabTypePlugin` | The plugin object itself: routes, spawn, render mode, manifest. |
| `HostContext` | Services the host hands a plugin: `confinePath`, `broadcast`, `settings`, `repos`, `worktrees`. |
| `TabInstance` | Handle to one running tab, returned by `spawn()`. |
| `PluginInstance` | The row shape the client reads from `create` / `list`. |
| `PluginManifestEntry` | Data-only descriptor served at `GET /api/plugins`. |
| `SpawnArgs` | What `spawn()` receives. |
| `Repo`, `Worktree`, `Settings` | Workspace shapes reachable through `HostContext`. |

`@omniterm/core` re-exports all of these, so host-internal code can keep importing
from its own modules. This package is the single source of truth for the shapes.

## Versioning

This package follows the plugin contract, not the host version. A breaking change
here is a major bump; a plugin pinned to a major stays compatible with every host
release in that range.

## License

MIT
