import { Router } from 'express';
import type { TabTypePlugin, PluginManifestEntry } from '../../plugins/types.js';

/**
 * Collect the client-facing manifest entries from the plugin list. Built once
 * at startup — the plugin set is fixed for the lifetime of the server.
 */
export function buildManifest(plugins: TabTypePlugin[]): PluginManifestEntry[] {
  return plugins.flatMap((p) => (p.manifest ? [p.manifest] : []));
}

/**
 * Fail-fast validation: every plugin must be renderable by the host client —
 * either a `manifest` (a data-driven iframe plugin the stock client renders) or
 * a built-in `component` render (e.g. the terminal). A plugin with neither can't
 * appear in the UI, so we stop startup loudly with the offending plugin named
 * rather than half-loading a `--plugin` the user can't see.
 */
export function validatePluginManifests(plugins: TabTypePlugin[]): void {
  const seenPrefix = new Set<string>();
  for (const p of plugins) {
    const renderable = !!p.manifest || p.render?.type === 'component';
    if (!renderable) {
      throw new Error(
        `[omniterm] plugin "${p.type}" provides neither a \`manifest\` (iframe) nor a ` +
          `\`component\` render; the host client cannot render it. Add a manifest ` +
          `(PluginManifestEntry) to make it a runtime-loadable iframe plugin.`,
      );
    }
    // Two plugins on the same non-empty Express mount point would silently
    // shadow each other's routes (first-registered wins). Empty-prefix plugins
    // self-namespace their own paths, so only non-empty prefixes collide.
    if (p.proxyPrefix) {
      if (seenPrefix.has(p.proxyPrefix)) {
        throw new Error(
          `[omniterm] plugin "${p.type}" shares proxyPrefix "${p.proxyPrefix}" with an ` +
            `earlier plugin; their routes would silently shadow. Use distinct prefixes.`,
        );
      }
      seenPrefix.add(p.proxyPrefix);
    }
  }
}

/**
 * `GET /api/plugins` — returns the data-only manifest the client renders plugins
 * from (tab types, file handlers, iframes), with no plugin code in the bundle.
 */
export function createManifestRouter(plugins: TabTypePlugin[]): Router {
  const router = Router();
  const manifest = buildManifest(plugins);
  router.get('/plugins', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ plugins: manifest });
  });
  return router;
}
