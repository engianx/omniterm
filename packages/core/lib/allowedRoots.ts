import { homedir } from 'os';
import * as path from 'path';
import { loadSettings } from './settings.js';
import { listRepos } from './repos.js';
import { listWorktrees } from './worktrees.js';

export class AllowedRootsError extends Error {}

/**
 * Parse operator-configured extra roots (`--allowed-roots` /
 * OMNITERM_ALLOWED_ROOTS): comma-separated absolute paths. A relative entry
 * throws, since it would silently resolve against the server's cwd.
 */
export function parseAllowedRoots(values: string[]): string[] {
  const roots: string[] = [];
  for (const value of values) {
    for (const raw of value.split(',')) {
      const entry = raw.trim();
      if (!entry) continue;
      if (!path.isAbsolute(entry)) throw new AllowedRootsError(`"${entry}" is not an absolute path`);
      roots.push(path.normalize(entry));
    }
  }
  return roots;
}

let extraRoots: string[] = [];

/** Set by startServer from its config; added to every `allowedRoots()` call. */
export function setExtraAllowedRoots(roots: string[]): void {
  extraRoots = [...roots];
}

/**
 * Build the allowlist of roots that path-confined HTTP routes (`/api/fs`,
 * `/api/preview`, ...) may read from or write to. Home (shell state, app
 * settings, scratch files) plus every directory the user has explicitly
 * tracked plus every repo/worktree — in other words, every path the UI
 * would normally hand out, plus any operator-configured extra roots
 * (`setExtraAllowedRoots`). Anything outside — /etc, the SSH key dir on a
 * different user, another bind mount — is rejected.
 *
 * Lives in its own file (rather than `paths.ts`) to avoid an import cycle:
 * `settings.ts` imports `SETTINGS_PATH` from `paths.ts`, so `paths.ts`
 * cannot import from `settings.ts` at module top level.
 */
export function allowedRoots(): string[] {
  const settings = loadSettings();
  const roots = new Set<string>([homedir(), ...extraRoots]);
  for (const d of settings.trackedDirs) roots.add(d);
  for (const repo of listRepos()) {
    roots.add(repo.path);
    try {
      for (const wt of listWorktrees(repo.path, repo.id)) roots.add(wt.path);
    } catch {
      // Listing a disappearing repo shouldn't block the confined access check.
    }
  }
  return [...roots];
}
