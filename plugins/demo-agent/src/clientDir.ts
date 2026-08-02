import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Resolve the built SPA bundle (`dist/client`). tsup bundles this file into
 * `dist/index.js`, which sits next to vite's `dist/client/` output, so the
 * client dir is always `./client` relative to the running bundle.
 */
export function resolveClientDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, 'client');
  if (!existsSync(path.join(dir, 'index.html'))) {
    throw new Error(
      `[demo-agent] client bundle not found at ${dir}/index.html — ` +
        'run `pnpm --filter @omniterm/demo-agent-plugin build` (vite build:client).',
    );
  }
  return dir;
}
