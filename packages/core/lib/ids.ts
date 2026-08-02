import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import path from 'path';

/**
 * Stable, collision-free ids for repos and worktrees, derived from the
 * filesystem path.
 *
 * These used to be the bare directory basename. Two checkouts that happened to
 * share a basename — say ~/work/omniterm and ~/personal/omniterm — collapsed
 * onto the single id "omniterm", and every repo-scoped route
 * (`/api/repos/:repoId/...`) resolved it to whichever repo was tracked first.
 * The second repo was unreachable, and "new worktree" / "remove repo" on its
 * row silently acted on the first one instead. Worktree ids had the same flaw
 * (`wt-<basename>`), so `/api/worktrees/:wtId` could delete or rename the wrong
 * repo's worktree.
 *
 * An id is `<sanitized name>-<8 hex of sha256(path)>`, e.g. `omniterm-4f3a9c21`.
 * The name keeps it legible in logs, tmux session names, and URLs; the digest
 * makes it unique. Ids are path-derived by design, so moving a directory mints a
 * new id — the only per-repo state keyed by it is `namingSchemes` (see the
 * migration in settings.ts).
 *
 * Repos and worktrees normalize differently, and the difference matters:
 *
 *   - Repo ids are LEXICAL (path.resolve only). A repo id addresses one entry in
 *     `trackedRepos`, and addLocalPath stores what the user gave it, so a
 *     directory and a symlink pointing at it are two separate tracked entries
 *     with two rows in the panel. Resolving symlinks here would give them one
 *     id, and getRepo returns the first tracked match — so removing one row
 *     would untrack the other repo and delete its worktrees.
 *
 *   - Worktree ids RESOLVE symlinks. Their paths arrive from two sources that
 *     disagree on spelling: `git worktree list` prints the fully resolved path
 *     (/private/var/... on macOS) while createWorktree builds its path from the
 *     tracked repo path as the user entered it (/var/...). Without realpath the
 *     same worktree gets two ids depending on which produced it, and a freshly
 *     created worktree never matches the next listing.
 */

// Ids flow into URL path segments, tmux session names (nextId in
// plugins/terminal/lib/sessions.ts appends `-term-N` and uses the result as the
// tmux target), and browser-registry keys, so restrict them to characters safe
// in all three: tmux treats '.' and ':' as target delimiters and '/' would
// break the route.
const UNSAFE = /[^A-Za-z0-9_-]/g;

const DIGEST_LEN = 8;

// path → id is a pure function of a stable string, and listRepos plus every
// worktree route recompute it per request. Memoize so the hash — and, for
// worktrees, the realpath syscall — never shows up on the workspace-switch hot
// path (the same reason repos.ts caches remote URLs).
const idCache = new Map<string, string>();

/**
 * The readable name for a directory: its own basename, minus a bare repo's
 * `.git`. Lexical on purpose — the panel must name the directory the user
 * tracked, not whatever a symlink points at, or a row silently renames itself.
 */
export function displayNameForPath(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  const stripped = path.basename(resolved).replace(/\.git$/, '');
  // `<proj>/.git` is a valid thing to track (isGitRepo passes on its HEAD), and
  // stripping leaves nothing — name it after the repo it belongs to rather than
  // rendering a blank row. 'repo' covers the filesystem root, whose basename is
  // empty as well.
  if (stripped) return stripped;
  return path.basename(path.dirname(resolved)) || 'repo';
}

function buildId(prefix: string, name: string, digestSource: string): string {
  const slug = name.replace(UNSAFE, '-');
  const digest = createHash('sha256').update(digestSource).digest('hex').slice(0, DIGEST_LEN);
  return `${prefix}${slug}-${digest}`;
}

/** Identifies one `trackedRepos` entry. Lexical — see the module doc. */
export function repoIdForPath(repoPath: string): string {
  const cacheKey = `repo ${repoPath}`;
  const cached = idCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const resolved = path.resolve(repoPath);
  const id = buildId('', displayNameForPath(resolved), resolved);
  idCache.set(cacheKey, id);
  return id;
}

/** Identifies one worktree directory. Resolves symlinks — see the module doc. */
export function worktreeIdForPath(worktreePath: string): string {
  const cacheKey = `wt ${worktreePath}`;
  const cached = idCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lexical = path.resolve(worktreePath);
  let resolved: string;
  let onDisk: boolean;
  try {
    resolved = realpathSync(lexical);
    onDisk = true;
  } catch {
    resolved = lexical;
    onDisk = false;
  }

  const id = buildId('wt-', displayNameForPath(resolved), resolved);
  // Only memoize once the path resolves. Caching the lexical fallback would pin
  // a pre-creation id that realpath later disagrees with — exactly the
  // two-ids-for-one-worktree split this resolution exists to prevent.
  if (onDisk) idCache.set(cacheKey, id);
  return id;
}
