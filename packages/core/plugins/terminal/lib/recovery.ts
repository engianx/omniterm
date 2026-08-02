import { killOrphanedTtydProcesses } from './ttyd.js';

// Use global to survive hot reloads in dev mode
const globalAny = globalThis as Record<string, unknown>;

export function recoverAll(): void {
  if (globalAny.__omniterm_recovered) return;
  globalAny.__omniterm_recovered = true;

  // Kill all stale ttyd processes from previous runs.
  // Sessions are re-adopted on demand via /api/dir-sessions.
  killOrphanedTtydProcesses();
}
