import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

export const SETTINGS_DIR = process.env.SETTINGS_DIR || path.join(homedir(), '.omniterm');
export const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

// Find the directory that hosts our `bin/` (where omniterm-browser.js
// lives). Two contexts to handle:
//
//   1. Dev / source-layout — `lib/paths.ts` lives at
//      `<repo>/packages/omniterm/lib/paths.ts`. The walk-up should find
//      `packages/omniterm/package.json` (`name: "@omniterm/core"`) and use
//      its `bin/` directory.
//
//   2. Bundled — consumers like `apps/omniterm` and `apps/testbox` bundle
//      @omniterm/core's source into their own `dist/server.js` via tsup's
//      `noExternal`. At runtime `import.meta.url` points at the bundled
//      file inside the consumer; @omniterm/core's package.json isn't on
//      disk anywhere. The walk-up finds the consumer's package.json and
//      we treat the consumer's `bin/` as the canonical location — the
//      consumer is expected to stage `omniterm-browser.js` there at
//      build time (apps/omniterm does this in scripts/package.sh).
//
// Returns null if no package.json can be found between `startDir` and the
// filesystem root. Callers must handle null gracefully (e.g., skip BROWSER
// env injection so the system default applies). Don't throw — that crashes
// the entire process at module load just because the deployment layout
// doesn't include surrounding package.jsons.
//
// `startDir` is exposed for tests. Production callers leave it unset, in
// which case we walk up from this module's own location.
export function findOmnitermPackageRoot(startDir?: string): string | null {
  const start = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  const root = path.parse(start).root;

  // First pass: prefer a package.json explicitly named "@omniterm/core".
  // Works in dev / unbundled contexts where @omniterm/core's own
  // package.json is on disk above us.
  let dir = start;
  while (dir !== root) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === '@omniterm/core') return dir;
      } catch {
        // unreadable package.json; keep walking
      }
    }
    dir = path.dirname(dir);
  }

  // Second pass: accept any package.json (bundled-consumer context). The
  // consumer is responsible for staging bin/omniterm-browser.js there.
  dir = start;
  while (dir !== root) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }

  return null;
}

export const OMNITERM_PACKAGE_ROOT: string | null = findOmnitermPackageRoot();
export const OMNITERM_BIN_DIR: string | null = OMNITERM_PACKAGE_ROOT
  ? path.join(OMNITERM_PACKAGE_ROOT, 'bin')
  : null;

export function resolveWorktreePath(worktreePath: string, relativePath: string): string {
  const resolved = path.resolve(worktreePath, relativePath);
  const normalized = path.normalize(resolved);

  if (!normalized.startsWith(worktreePath)) {
    throw new Error('Path traversal detected');
  }

  return normalized;
}

/**
 * Resolve a user-supplied path and refuse to return one that escapes every
 * allowed root. The `/api/fs` routes expose file reads and writes over HTTP —
 * without this guard, any caller on the testbox port can target `~/.ssh/*`,
 * `/etc/passwd`, etc. With it, the reachable surface narrows to the roots
 * the user has explicitly tracked plus their home directory (where app
 * state, shell history and their own projects live — acceptable scope for
 * a single-user dev box).
 *
 * Expands a leading `~` to `$HOME` and normalizes to absolute. Returns null
 * if the final path isn't inside any allowed root.
 */
export function confinePath(rawPath: string, allowedRoots: string[]): string | null {
  if (!rawPath) return null;
  const expanded = rawPath.startsWith('~') ? rawPath.replace('~', homedir()) : rawPath;
  const resolved = path.normalize(path.resolve(expanded));
  for (const raw of allowedRoots) {
    if (!raw) continue;
    const rootAbs = path.normalize(path.resolve(raw));
    // Match `root` exactly or any `root/...` subpath (not `root-sibling/`).
    if (resolved === rootAbs || resolved.startsWith(rootAbs + path.sep)) {
      return resolved;
    }
  }
  return null;
}
