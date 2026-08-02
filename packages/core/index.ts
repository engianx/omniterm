/**
 * Public entry point for the `omniterm` package.
 *
 * Library consumers (apps in this monorepo, future external packages):
 *
 *   import { startServer } from "omniterm";
 *   startServer({ port: 17717, plugins: [myPlugin] });
 *
 * The bundled default plugin (terminal) is included automatically. Pass
 * extra plugins to extend the host. Pass `excludeDefaults: true` if you
 * really don't want the terminal plugin (rare).
 *
 * CLI entry: bin/omniterm.js wraps `startServer` for the standalone
 * experience and parses CLI flags (--port, --host, etc.).
 */

export { startServer, type StartServerOptions } from './server/startServer.js';

// Plugin API — re-exported so external plugins can `import type { TabTypePlugin } from "omniterm"`.
// `PluginInstance` is the canonical create/list row shape; plugins should return it
// (or a structural superset) rather than re-declaring it.
export type { TabTypePlugin, TabInstance, HostContext, SpawnArgs, PluginInstance } from './plugins/types.js';

// Default terminal plugin factory — exported for consumers that want to
// compose it explicitly (or replace it with a customized terminal plugin).
export { createTerminalPlugin } from './plugins/terminal/plugin.js';

// `--plugin` loader primitives — the pure parse + validation a host CLI uses to
// turn argv into validated plugins (the host owns module resolution + import()).
export { parsePluginSpecs, validatePluginModule, PluginSpecError } from './lib/pluginLoader.js';

// Browser registry primitives — for plugin authors that want their tab's
// MCP/sandbox child processes to register browsers and have them rendered
// in a TabBrowserView (terminal, agent, future plugins). The router and
// upgrade handler are mounted under each plugin's URL prefix; the
// TabBrowserView component takes a `tabBaseUrl` matching that prefix.
// Repo management — for host apps that clone repos externally (e.g. testbox
// bootstrap) and need to register them in the workspace panel.
export { addLocalPath } from './lib/repos.js';

export {
  createTabRegistryRouter,
  handleCdpUpgrade,
  cleanupTab as cleanupBrowserRegistry,
  listBrowsers,
  type BrowserEntry,
  type BrowserView,
  type RouterOptions as TabRegistryRouterOptions,
} from './browserRegistry/tabRegistry.js';
