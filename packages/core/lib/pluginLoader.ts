import type { TabTypePlugin } from '../plugins/types.js';

/**
 * Pure, testable pieces of the `--plugin` loader. The host (apps/omniterm) owns
 * the impure module resolution + dynamic `import()` and turns these typed errors
 * into a `[omniterm] …` message + `process.exit(1)`; keeping parse + validation
 * here (throwing, not exiting) makes them unit-testable in-process.
 */
export class PluginSpecError extends Error {
  /** The offending `--plugin` spec, or null for an argv-level parse error. */
  readonly spec: string | null;
  constructor(spec: string | null, message: string) {
    super(message);
    this.name = 'PluginSpecError';
    this.spec = spec;
  }
}

/**
 * Parse repeated `--plugin <spec>` flags out of argv, in order. Throws
 * PluginSpecError when `--plugin` is given without a value (end of argv or
 * followed by another flag).
 */
export function parsePluginSpecs(argv: string[]): string[] {
  const specs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--plugin') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new PluginSpecError(
        null,
        '--plugin requires a value (a filesystem path or package name)',
      );
    }
    specs.push(value);
    i++;
  }
  return specs;
}

/**
 * Validate an imported plugin module against the TabTypePlugin contract. The
 * entry may be a plugin object or a no-arg factory returning one, exported as
 * `default` or `plugin`. `seenType` is shared across specs to reject duplicate
 * tab types. Throws PluginSpecError (with the spec) on any violation; returns
 * the validated plugin and records its type in `seenType` on success.
 */
export function validatePluginModule(
  spec: string,
  mod: Record<string, unknown>,
  seenType: Set<string>,
): TabTypePlugin {
  const exported = (mod.default ?? (mod as { plugin?: unknown }).plugin) as unknown;
  let plugin: unknown;
  try {
    plugin = typeof exported === 'function' ? (exported as () => unknown)() : exported;
  } catch (err) {
    throw new PluginSpecError(
      spec,
      `factory threw (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const p = plugin as Partial<TabTypePlugin> | undefined;
  if (!p || typeof p.type !== 'string' || typeof p.createRouter !== 'function') {
    throw new PluginSpecError(
      spec,
      'module must export a TabTypePlugin (default export or no-arg factory)',
    );
  }
  if (seenType.has(p.type)) throw new PluginSpecError(spec, `duplicate tab type "${p.type}"`);
  seenType.add(p.type);
  return p as TabTypePlugin;
}
