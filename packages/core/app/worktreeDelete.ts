// Pure helpers for the workspace (worktree) delete flow, extracted so the
// safety-critical force/fail-safe decisions can be unit-tested without React.

/**
 * DELETE endpoint for a worktree. Force only when the worktree is dirty — the
 * user has explicitly confirmed discarding the uncommitted work the red warning
 * called out. A clean worktree goes through git's normal (non-force) remove,
 * keeping that safeguard as a backstop against silent data loss.
 */
export function worktreeDeleteUrl(wtId: string, dirty: boolean): string {
  return `/api/worktrees/${encodeURIComponent(wtId)}${dirty ? '?force=true' : ''}`;
}

/** Dirtiness-probe endpoint for a worktree; encodes the id like the delete URL. */
export function worktreeStatusUrl(wtId: string): string {
  return `/api/worktrees/${encodeURIComponent(wtId)}/status`;
}

/**
 * Interpret the `/status` probe into a dirty flag. Fail safe: treat anything
 * that isn't an explicit `{ dirty: false }` from a 2xx response as dirty, so a
 * failed, non-OK, or garbled probe still warns the user and forces the delete
 * rather than silently discarding uncommitted work.
 */
export function probeIsDirty(ok: boolean, body: unknown): boolean {
  if (!ok) return true;
  return (body as { dirty?: unknown } | null | undefined)?.dirty !== false;
}
