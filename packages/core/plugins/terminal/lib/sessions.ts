import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { allocatePort, freePort } from './ports.js';
import {
  createTmuxSession,
  killTmuxSession,
  tmuxSessionExists,
  ensureTmuxBindings,
} from './tmux.js';
import { trackSilenceSession, untrackSilenceSession } from './silenceMonitor.js';
import {
  spawnTtyd,
  stopTtyd,
  isTtydAlive,
  killOrphanedTtydProcesses,
  waitForTtydReady,
  onTtydStopped,
} from './ttyd.js';
import {
  clearSessionTtydReadiness,
  createSessionTtydReadinessState,
  ensureSessionTtydReadyWithState,
  type SessionTtydReadinessRuntime,
  type SessionTtydReadinessState,
} from './ttydReadiness.js';
import { recoverAll } from './recovery.js';
import {
  trackSessionAdopted,
  trackSessionClosed as trackClosed,
  trackCleanup,
} from '../../../lib/telemetry.js';
import { broadcast } from '../../../lib/events.js';
import { OMNITERM_BIN_DIR } from '../../../lib/paths.js';

// Absolute path to the system-browser shim. Anything inside an omniterm
// tmux session that respects $BROWSER (gcloud, gh, Python webbrowser, ...)
// routes URL launches through this script, which registers Chrome with
// the tab's registry so the user can interact with it remotely. Tools
// that bypass $BROWSER and call `xdg-open` directly are caught by the
// PATH prepend in buildTabEnv (an `xdg-open` shim sits next to this script).
//
// Resolved at module load to either a real on-disk path or null. Null
// happens when the package.json walk-up couldn't find anything (e.g.,
// bundled deployments with no surrounding fs hierarchy) OR when the
// resolved bin/ doesn't actually contain omniterm-browser.js (e.g.,
// testbox bundles @omniterm/core but doesn't stage the shim into its
// own bin/). In null cases buildTabEnv simply omits BROWSER+PATH —
// tools fall back to system defaults; tab creation still works.
const OMNITERM_BROWSER_PATH: string | null = OMNITERM_BIN_DIR
  ? path.join(OMNITERM_BIN_DIR, 'omniterm-browser.js')
  : null;
const OMNITERM_BROWSER_AVAILABLE =
  OMNITERM_BROWSER_PATH !== null && existsSync(OMNITERM_BROWSER_PATH);

/**
 * Bootstrap PATH stamped onto every tab. Deliberately NOT derived from
 * the server's process.env.PATH — that would leak the env of whatever
 * shell launched omniterm into every tab (the exact trap the clean-env
 * wrapper exists to close; see CLEAN_ENV_VARS in tmux.ts). It only needs
 * to cover standard shell locations + homebrew so the configured
 * defaultShell resolves; the login-shell profile pass then rebuilds the
 * user's real PATH on top.
 */
const CLEAN_PATH_BASE = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * Single source of truth for the env vars stamped onto every omniterm
 * tab's tmux session. Both code paths that create tabs (worktree-bound
 * via createSession, free-form cwd via /api/create-session) call this
 * so a future addition only changes one file. Anything added here must
 * also be in CLEAN_ENV_VARS (tmux.ts) or the clean-env wrapper drops it
 * before the shell starts.
 *
 * The shim-dir PATH prepend is best-effort: login-shell profiles that
 * rewrite PATH from scratch (e.g. Debian's /etc/profile) can push the
 * shim dir back or out; BROWSER is the primary xdg-open interception
 * mechanism, the PATH shim only catches tools that ignore $BROWSER.
 */
export function buildTabEnv(registryUrl: string): Record<string, string> {
  const env: Record<string, string> = { OMNITERM_BROWSER_REGISTRY_URL: registryUrl };
  if (OMNITERM_BROWSER_AVAILABLE && OMNITERM_BROWSER_PATH && OMNITERM_BIN_DIR) {
    env.BROWSER = OMNITERM_BROWSER_PATH;
    env.PATH = `${OMNITERM_BIN_DIR}:${CLEAN_PATH_BASE}`;
  } else {
    env.PATH = CLEAN_PATH_BASE;
  }
  return env;
}

/**
 * The full environment stamped on a new session: omniterm's own per-tab vars,
 * then the values the creating caller supplied for this terminal (spec 001
 * FR-012), which win on a collision. The user's login profile runs after all of
 * this and has the last word on any name it sets.
 *
 * Kept as a named function rather than an inline spread at the call site so the
 * precedence is pinned by a test — a reversed spread would silently let
 * omniterm's own defaults override what the caller asked for.
 */
export function buildSessionEnv(
  registryUrl: string,
  callerEnv?: Record<string, string>,
): Record<string, string> {
  return { ...buildTabEnv(registryUrl), ...callerEnv };
}

export interface Session {
  id: string;
  worktreeId: string;
  tmuxName: string;
  port: number;
  createdAt: string;
}

// Persist across hot reloads in dev mode
const g = globalThis as Record<string, unknown>;
const sessions: Map<string, Session> = (g.__omniterm_sessions as Map<string, Session>) || new Map();
const counters: Map<string, number> = (g.__omniterm_counters as Map<string, number>) || new Map();
const ttydReadinessState: SessionTtydReadinessState =
  (g.__omniterm_ttyd_readiness as SessionTtydReadinessState) || createSessionTtydReadinessState();
g.__omniterm_sessions = sessions;
g.__omniterm_counters = counters;
g.__omniterm_ttyd_readiness = ttydReadinessState;

const defaultTtydReadinessRuntime: SessionTtydReadinessRuntime = {
  isTtydAlive,
  spawnTtyd,
  waitForTtydReady,
};

if (!g.__omniterm_session_ttyd_listener_registered) {
  // This listener owns process-lifetime readiness state, so it is
  // intentionally registered once and not unsubscribed.
  onTtydStopped((sessionName) => clearSessionTtydReadiness(sessionName, ttydReadinessState));
  g.__omniterm_session_ttyd_listener_registered = true;
}

function nextId(worktreeId: string): string {
  let count = (counters.get(worktreeId) || 0) + 1;
  // Skip past any existing tmux sessions with this name
  while (tmuxSessionExists(`${worktreeId}-term-${count}`)) {
    count++;
  }
  counters.set(worktreeId, count);
  return `${worktreeId}-term-${count}`;
}

// Run recovery immediately on module load (server startup)
recoverAll();

export function createSession(
  worktreeId: string,
  worktreePath: string,
  opts: { registryUrlFor: (tabId: string) => string },
): Session {
  const t0 = Date.now();
  const id = nextId(worktreeId);
  const port = allocatePort();

  const t1 = Date.now();
  // Stamp tab-scoped env on the tmux session: registry URL (so child
  // processes' registerBrowser calls land in this tab's registry), plus
  // BROWSER + PATH so xdg-open / gcloud / gh / etc. route URL launches
  // through omniterm-browser. See buildTabEnv for the full list. Must
  // go via tmux `-e` because tmux captures env at server start and won't
  // update. The pane's shell itself starts from a clean allowlisted env
  // (see CLEAN_ENV_SCRIPT in tmux.ts).
  createTmuxSession(id, worktreePath, buildTabEnv(opts.registryUrlFor(id)));
  const t2 = Date.now();
  const session: Session = {
    id,
    worktreeId,
    tmuxName: id,
    port,
    createdAt: new Date().toISOString(),
  };
  clearSessionTtydReadiness(session.tmuxName, ttydReadinessState);
  spawnTtyd(session.tmuxName, session.port);
  const t3 = Date.now();

  sessions.set(id, session);
  trackSilenceSession(session.tmuxName);

  const t4 = Date.now();

  console.log(`[session] ${id}: tmux=${t2 - t1}ms ttyd=${t3 - t2}ms total=${t4 - t0}ms`);
  broadcast('session-created', { sessionId: id, worktreeId, path: worktreePath });

  return session;
}

export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;

  if (!tmuxSessionExists(session.tmuxName)) {
    clearSessionTtydReadiness(session.tmuxName, ttydReadinessState);
    stopTtyd(session.tmuxName);
    freePort(session.port);
    sessions.delete(id);
    untrackSilenceSession(session.tmuxName);

    return undefined;
  }

  if (!isTtydAlive(session.tmuxName)) {
    clearSessionTtydReadiness(session.tmuxName, ttydReadinessState);
    spawnTtyd(session.tmuxName, session.port);
  }

  return session;
}

export async function ensureSessionTtydReady(session: Session, timeoutMs = 3000): Promise<void> {
  await ensureSessionTtydReadyWithState(
    session,
    timeoutMs,
    defaultTtydReadinessRuntime,
    ttydReadinessState,
  );
}

export function unregisterSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  clearSessionTtydReadiness(session.tmuxName, ttydReadinessState);
  stopTtyd(session.tmuxName);
  freePort(session.port);
  sessions.delete(id);
  untrackSilenceSession(session.tmuxName);
  return true;
}

export function listSessions(worktreeId?: string): Session[] {
  const all = Array.from(sessions.values());
  if (worktreeId) {
    return all.filter((s) => s.worktreeId === worktreeId);
  }
  return all;
}

export function deleteSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;

  clearSessionTtydReadiness(session.tmuxName, ttydReadinessState);
  stopTtyd(session.tmuxName);
  killTmuxSession(session.tmuxName);
  freePort(session.port);
  sessions.delete(id);
  untrackSilenceSession(session.tmuxName);

  trackClosed();
  broadcast('session-closed', { sessionId: id, worktreeId: session.worktreeId });
  return true;
}

export function deleteSessionsForWorktree(worktreeId: string): number {
  const toDelete = listSessions(worktreeId);
  for (const session of toDelete) {
    clearSessionTtydReadiness(session.tmuxName, ttydReadinessState);
    stopTtyd(session.tmuxName);
    killTmuxSession(session.tmuxName);
    freePort(session.port);
    sessions.delete(session.id);
    untrackSilenceSession(session.tmuxName);
  }
  if (toDelete.length > 0) {
    broadcast('session-closed', { worktreeId, sessionCount: toDelete.length });
  }
  return toDelete.length;
}

export interface AdoptSessionOptions {
  /**
   * When the caller has just run `createTmuxSession` for this name, the
   * mouse/bindings setup is already done. Setting this true skips
   * redundant tmux execs on the create-session path.
   */
  skipTmuxSetup?: boolean;
  /**
   * Skip the `tmux display-message` round-trip for `pane_current_path`
   * and use this cwd in the session-adopted broadcast instead.
   */
  knownCwd?: string;
}

export function adoptSession(tmuxSessionName: string, opts?: AdoptSessionOptions): Session {
  const t0 = Date.now();
  const port = allocatePort();
  const t1 = Date.now();
  if (!opts?.skipTmuxSetup) {
    // Apply server-level bindings (clipboard + scrollback) once. Lazy because
    // tmux server exits immediately if there are no sessions (exit-empty=on),
    // so we can only set these after at least one session exists. adoptSession
    // runs after `tmux new-session`, so the server is guaranteed alive here.
    // Idempotent via ensureTmuxBindings's internal flag.
    ensureTmuxBindings();
    // tmux mouse is ON: wheel scroll auto-enters copy-mode (the common need
    // is reading scrollback, not walking shell history), and mouse-aware TUI
    // apps (htop, lazygit, vim with `set mouse=a`) receive events. Drag-
    // select emits OSC 52 via copy-pipe-and-cancel; the iframe's xterm.js
    // OSC 52 handler (see TerminalView.tsx) relays that to the browser's
    // clipboard, so copy works across macOS / Linux / remote-server setups
    // without needing Shift+drag (ttyd's bundled xterm.js doesn't honor
    // Shift as a mouse-tracking bypass). Forced on here because adoptSession
    // may run on tmux sessions created outside our createTmuxSession path.
    try {
      // `=name` forces an exact target match (see tmuxSessionExists) so the
      // option lands on this session, not one it is merely a prefix of. The
      // trailing `:` is required — set-option takes a pane target, and on
      // tmux 3.6 a bare `=name` fails to resolve ("no such session").
      execFileSync('tmux', ['set-option', '-t', `=${tmuxSessionName}:`, 'mouse', 'on'], {
        stdio: 'ignore',
      });
    } catch {}
  }
  const t2 = Date.now();
  clearSessionTtydReadiness(tmuxSessionName, ttydReadinessState);
  spawnTtyd(tmuxSessionName, port);
  const t3 = Date.now();

  const session: Session = {
    id: tmuxSessionName,
    worktreeId: '_orphan',
    tmuxName: tmuxSessionName,
    port,
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.id, session);
  trackSilenceSession(session.tmuxName);

  const allocate_port_ms = t1 - t0;
  const total_ms = t3 - t0;
  console.log(
    `[session] adopted ${tmuxSessionName}: port=${port} allocate=${allocate_port_ms}ms setup=${t2 - t1}ms ttyd=${t3 - t2}ms total=${total_ms}ms skip=${opts?.skipTmuxSetup ? 1 : 0}`,
  );
  trackSessionAdopted({ total_ms, allocate_port_ms });
  let cwd = opts?.knownCwd ?? '';
  if (!cwd) {
    try {
      cwd = execFileSync(
        'tmux',
        // `=name:` — exact target match (see tmuxSessionExists); the trailing
        // `:` is required — display-message takes a pane target, and on tmux
        // 3.6 a bare `=name` resolves to nothing (empty expansions).
        ['display-message', '-t', `=${tmuxSessionName}:`, '-p', '#{pane_current_path}'],
        { encoding: 'utf-8' },
      ).trim();
    } catch {}
  }
  broadcast('session-adopted', { sessionId: tmuxSessionName, worktreeId: '_orphan', path: cwd });
  return session;
}

export function registerSession(session: Session): void {
  sessions.set(session.id, session);
  trackSilenceSession(session.tmuxName);
  const match = session.id.match(/-term-(\d+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    const current = counters.get(session.worktreeId) || 0;
    if (num > current) {
      counters.set(session.worktreeId, num);
    }
  }
}

export { killOrphanedTtydProcesses };
