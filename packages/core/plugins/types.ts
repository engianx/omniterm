/**
 * Tab-Type Plugin API — re-exported from `@omniterm/plugin-types`.
 *
 * The contract itself lives in a standalone, types-only package so a plugin
 * can be built in its own repository without depending on core. Nothing is
 * declared here; this module exists so in-repo imports of
 * `plugins/types.js` keep resolving. Edit the contract in
 * `packages/plugin-types/index.ts`.
 *
 * The design notes that used to sit here (why terminal is a built-in plugin,
 * why the render contract supports both iframe and component modes, the
 * flow walkthroughs) moved with the types — see that file.
 */

export type {
  TabTypePlugin,
  TabInstance,
  PluginInstance,
  PluginManifestEntry,
  SpawnArgs,
  HostContext,
} from '@omniterm/plugin-types';
