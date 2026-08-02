import { homedir } from 'os';
import { loadSettings } from './settings.js';
import { listRepos } from './repos.js';
import { listWorktrees } from './worktrees.js';

/**
 * Build the allowlist of roots that path-confined HTTP routes (`/api/fs`,
 * `/api/preview`, ...) may read from or write to. Home (shell state, app
 * settings, scratch files) plus every directory the user has explicitly
 * tracked plus every repo/worktree — in other words, every path the UI
 * would normally hand out. Anything outside — /etc, the SSH key dir on a
 * different user, another bind mount — is rejected.
 *
 * Lives in its own file (rather than `paths.ts`) to avoid an import cycle:
 * `settings.ts` imports `SETTINGS_PATH` from `paths.ts`, so `paths.ts`
 * cannot import from `settings.ts` at module top level.
 */
export function allowedRoots(): string[] {
  const settings = loadSettings();
  const roots = new Set<string>([homedir()]);
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
