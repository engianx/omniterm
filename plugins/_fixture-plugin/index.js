// Dev/test-only fixture plugin for the omniterm plugin platform.
//
// Plain ESM JS so the bundled node host can `import()` it directly (no build
// step). It exercises the whole runtime contract:
//   - a `manifest` so the data-driven client renders it with no rebuild
//   - `endpoints` create/list/close (the client drives these over HTTP)
//   - an iframe page served under the plugin's own prefix
//   - `HostContext.confinePath` + `HostContext.repos` (proving plugins reach
//     host services through the public API, not core internals)
//
// Entry is a no-arg factory (default export). HostContext is delivered via
// createRouter(host), matching the TabTypePlugin contract.

import { Router } from 'express';

/** Escape interpolated values before placing them in HTML (avoid injection). */
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export default function createFixturePlugin() {
  /** @type {Map<string, { id: string, name: string, status: 'running', file: string | null }>} */
  const instances = new Map();
  let nextId = 1;

  function create(openFile, host) {
    let file = null;
    if (openFile && host) {
      file = host.confinePath(openFile); // null if outside every allowed root
      // Reject rather than silently degrade to a fileless instance: a path the
      // host refused is a caller error, and answering 200 would let a traversal
      // attempt look like success. This is the over-the-wire half of the
      // confinement contract — `confinePath` returning null is only useful if
      // the plugin acts on it.
      if (file === null) return { error: 'path is outside the allowed workspace roots' };
    }
    const id = `fx-${nextId++}`;
    const name = file ? file.split('/').pop() : 'Fixture';
    const inst = { id, name, status: 'running', file };
    instances.set(id, inst);
    return inst;
  }

  return {
    type: 'fixture',
    label: 'Fixture',
    proxyPrefix: '', // router carries its own /api/fixture/* + /fixture/* paths

    manifest: {
      type: 'fixture',
      label: 'Fixture',
      ephemeral: true,
      tabTypeChoice: { label: 'Fixture' },
      fileHandlers: [{ pattern: '*.fixture', label: 'Open in Fixture' }],
      endpoints: {
        create: '/api/fixture/instances',
        list: '/api/fixture/instances',
        closeTemplate: '/api/fixture/instances/{id}',
      },
      iframe: { urlTemplate: '/fixture/{id}' },
    },

    createRouter(host) {
      const router = Router();

      router.post('/api/fixture/instances', (req, res) => {
        const openFile = typeof req.body?.openFile === 'string' ? req.body.openFile : undefined;
        const result = create(openFile, host);
        if (result.error) {
          res.status(403).json(result);
          return;
        }
        res.json(result);
      });

      router.get('/api/fixture/instances', (_req, res) => {
        res.json({ items: [...instances.values()] });
      });

      router.delete('/api/fixture/instances/:id', (req, res) => {
        const removed = instances.delete(req.params.id);
        res.status(removed ? 200 : 404).json({ removed });
      });

      router.get('/fixture/:id', (req, res) => {
        const inst = instances.get(req.params.id);
        const repoCount = host.repos().length; // proves HostContext.repos()
        res
          .type('html')
          .send(
            `<!doctype html><meta charset="utf-8"><title>Fixture ${esc(req.params.id)}</title>` +
              `<body style="font-family:sans-serif;padding:1rem">` +
              `<h1>omniterm fixture plugin</h1>` +
              `<p>instance: ${esc(req.params.id)}</p>` +
              `<p>file: ${esc(inst ? (inst.file ?? '(none)') : '(unknown instance)')}</p>` +
              `<p>workspace repos: ${repoCount}</p>` +
              `</body>`,
          );
      });

      return router;
    },

    // No `render` or `spawn`: the data-driven client renders this plugin from
    // `manifest` and drives lifecycle via the HTTP endpoints above. Both fields
    // are optional on TabTypePlugin and only needed by compiled-in component
    // plugins (e.g. the built-in terminal).
  };
}
