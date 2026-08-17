import { Router, type Response } from 'express';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { promisify } from 'util';
import {
  getSession,
  deleteSession,
  adoptSession,
  listSessions,
  buildSessionEnv,
  ensureSessionTtydReady,
  unregisterSession,
  type Session,
} from '../lib/sessions.js';
import {
  createTmuxSession,
  isMeaningfulPaneTitle,
  listTmuxSessions,
  tmuxSessionExists,
} from '../lib/tmux.js';
import { loadSettings } from '../../../lib/settings.js';
import { trackSessionCreated } from '../../../lib/telemetry.js';
import { listRepos } from '../../../lib/repos.js';
import { assertValidEnvName, EnvNameError, getEnvPassthrough } from '../../../lib/sessionEnv.js';

const execFileAsync = promisify(execFile);
const DISCOVERY_COMMAND_TIMEOUT_MS = 5000;
// Bound client-supplied fields: the name becomes a tmux session name (practical
// ~256-byte limit) and initialCommand becomes part of the `tmux new-session`
// argv, so a huge value could hit OS arg-length limits.
export const MAX_SESSION_NAME_LEN = 128;
export const MAX_INITIAL_COMMAND_LEN = 4096;
// Bound the per-session `env` map: its entries become `tmux -e KEY=VALUE` argv
// words, so an unbounded map would hit OS arg-length limits.
export const MAX_ENV_VARS = 32;
export const MAX_ENV_VALUE_LEN = 4096;

/**
 * Validate the optional per-session `env` map (spec 001). Returns the map to
 * stamp on the session, or a message describing the first problem found — the
 * caller then rejects the whole request, so a caller's environment is never
 * half-applied.
 *
 * NOTE for callers: these values travel in the tmux server's argv and are
 * readable through `ps` and `tmux show-environment`. They are for per-terminal
 * configuration, not secrets; a secret belongs in the host's own environment
 * plus `--env-passthrough`, whose values never appear in an argv.
 */
function parseSessionEnv(raw: unknown): { env?: Record<string, string> } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'env must be an object mapping variable names to string values' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) {
    return { error: `env accepts at most ${MAX_ENV_VARS} variables` };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    try {
      assertValidEnvName(key);
    } catch (e) {
      return { error: e instanceof EnvNameError ? e.message : String(e) };
    }
    if (typeof value !== 'string') return { error: `env.${key} must be a string` };
    if (value.length > MAX_ENV_VALUE_LEN) {
      return { error: `env.${key} exceeds ${MAX_ENV_VALUE_LEN} characters` };
    }
    if (value.includes('\0')) return { error: `env.${key} must not contain a NUL byte` };
    env[key] = value;
  }
  return { env };
}

export const sessionsRouter: Router = Router();

/** The wire shape for a session, shared by every route that returns one. */
function serializeSession(session: Session) {
  return {
    id: session.id,
    worktreeId: session.worktreeId,
    port: session.port,
    url: `/t/${session.id}/`,
    createdAt: session.createdAt,
  };
}

/**
 * Resolve `name` to a ready-to-serve session — reuse the caller-supplied or
 * registered session if present, otherwise adopt the live tmux session — then
 * ensure its ttyd is ready. On readiness failure it unregisters the session and
 * rethrows, leaving the live tmux session intact, so each caller can shape its
 * own error response. Returns the session and whether it was already registered
 * (so HTTP callers can distinguish 200 re-attach from 201 fresh adopt). Pass
 * `existing` when the caller already resolved the registry entry, to skip a
 * redundant lookup. This is the single home for the
 * lookup → adopt → ensureReady → unregister-on-error flow.
 */
async function adoptAndReady(
  name: string,
  existing?: Session,
): Promise<{ session: Session; wasRegistered: boolean }> {
  const registered = existing ?? getSession(name);
  const session = registered ?? adoptSession(name);
  try {
    await ensureSessionTtydReady(session);
  } catch (e) {
    unregisterSession(session.id);
    throw e;
  }
  return { session, wasRegistered: Boolean(registered) };
}

/**
 * Adopt-or-attach a session by name and write the HTTP response: 200 if it was
 * already registered, 201 if freshly adopted, 503 if ttyd never became ready.
 * Shared by /create-session's create-or-adopt path and /adopt-session.
 */
async function adoptOrAttach(name: string, res: Response, existing?: Session): Promise<void> {
  try {
    const { session, wasRegistered } = await adoptAndReady(name, existing);
    res.status(wasRegistered ? 200 : 201).json(serializeSession(session));
  } catch (e: unknown) {
    res.status(503).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The effective host-level passthrough configuration (spec 001 FR-011): the
 * accepted NAMES only. Values are deliberately absent — the whole point of
 * configuring by name is that the host never handles, stores, or echoes them.
 */
sessionsRouter.get('/session-env', (_req, res) => {
  res.json({ passthrough: getEnvPassthrough() });
});

sessionsRouter.get('/sessions/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(serializeSession(session));
});

sessionsRouter.delete('/sessions/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  deleteSession(req.params.sessionId);
  res.json({ deleted: true });
});

sessionsRouter.post('/create-session', async (req, res) => {
  const cwd = req.body?.cwd === '~' ? homedir() : req.body?.cwd;
  if (!cwd) {
    res.status(400).json({ error: 'cwd is required' });
    return;
  }

  // Optional: run a command in the new session (then drop to a shell), and/or
  // give the session a stable name so a repeat call re-attaches the same
  // session instead of spawning a duplicate (and does NOT re-run the command).
  // Used by deep links that open a terminal already running a command.
  //
  // SECURITY: initialCommand is executed verbatim in the user's shell — it is
  // direct code execution, not just data. This endpoint is unauthenticated (like
  // the rest of the local API) and the server binds all interfaces by default,
  // so the threat model relies on network-level access control; see the HOST
  // comment in startServer.ts. This is not a new capability: a network caller
  // could already spawn a bare shell here and drive it via the ttyd WebSocket.
  const rawCommand = req.body?.initialCommand;
  const initialCommand =
    typeof rawCommand === 'string' && rawCommand.trim() ? rawCommand.trim() : undefined;
  if (initialCommand !== undefined && initialCommand.length > MAX_INITIAL_COMMAND_LEN) {
    res
      .status(400)
      .json({ error: `initialCommand exceeds ${MAX_INITIAL_COMMAND_LEN} characters` });
    return;
  }
  const rawName = req.body?.name;
  const requestedName = typeof rawName === 'string' && rawName.trim() ? rawName : undefined;

  // A requested name becomes the tmux session name, the registry key, and a
  // path segment in /t/<name>/, so restrict it to characters safe in all three
  // (tmux treats '.' and ':' as target delimiters and '/' breaks the route) and
  // bound its length.
  if (
    requestedName !== undefined &&
    (requestedName.length > MAX_SESSION_NAME_LEN || !/^[A-Za-z0-9_-]+$/.test(requestedName))
  ) {
    res.status(400).json({
      error: `name must be 1–${MAX_SESSION_NAME_LEN} characters of letters, digits, dashes, or underscores`,
    });
    return;
  }

  // Per-session environment (spec 001). Validated BEFORE the create-or-adopt
  // branch so a malformed request is rejected whichever way it would have gone;
  // a well-formed map is applied only on create (see below).
  const parsedEnv = parseSessionEnv(req.body?.env);
  if ('error' in parsedEnv) {
    res.status(400).json({ error: parsedEnv.error });
    return;
  }

  // Create-or-adopt: reuse an existing session for a stable name rather than
  // spawning a duplicate, so a re-click lands back in the same session (the
  // command ran on first create and is NOT re-run). getSession doubles as
  // cleanup: if the tmux session died but its registry entry survived (the
  // exec'd shell exited while the host kept running), it evicts that stale entry
  // and frees its port — so falling through to create below can't leak it.
  if (requestedName) {
    const registered = getSession(requestedName);
    if (registered || tmuxSessionExists(requestedName)) {
      // Re-attach applies neither `initialCommand` nor `env` — the session
      // already exists and keeps the environment it was created with.
      // When `registered` is undefined here the tmux session exists but isn't in
      // the registry (e.g. after a host restart); adoptAndReady re-runs
      // getSession, but that's a cheap registry miss (no tmux exec) before it
      // adopts. Passing `registered` avoids the redundant lookup in the common
      // live-re-attach case.
      await adoptOrAttach(requestedName, res, registered);
      return;
    }
  }

  // Derived names flow into the same tmux-name / registry-key / URL-segment
  // sinks as requestedName, so sanitize the cwd basename to the same safe set
  // (a dotted dir like `my.app` would otherwise break tmux target lookups).
  const base = (cwd.split('/').pop() || 'session').replace(/[^A-Za-z0-9_-]/g, '-');
  const ts = Date.now().toString(36);
  const name = requestedName ?? `${base}-${ts}`;
  // A terminal tab is 1:1 with its session, so the registry is keyed by the
  // session name (== the tab id the client uses).
  let session: ReturnType<typeof adoptSession> | undefined;

  try {
    const t0 = Date.now();
    const host = req.headers.host ?? '127.0.0.1:17716';
    const registryUrl = `http://${host}/t/${name}/registry`;
    createTmuxSession(name, cwd, buildSessionEnv(registryUrl, parsedEnv.env), { initialCommand });
    const t1 = Date.now();
    // createTmuxSession already initialized mouse and bindings; avoid
    // repeating that work and reuse the known cwd.
    session = adoptSession(name, { skipTmuxSetup: true, knownCwd: cwd });
    const t2 = Date.now();
    await ensureSessionTtydReady(session);
    const t3 = Date.now();
    const tmux_ms = t1 - t0;
    const adopt_ms = t2 - t1;
    const ttyd_ready_ms = t3 - t2;
    const total_ms = t3 - t0;
    console.log(
      `[session] create-session: tmux=${tmux_ms}ms adopt=${adopt_ms}ms ttyd_ready=${ttyd_ready_ms}ms total=${total_ms}ms`,
    );
    trackSessionCreated({ total_ms, tmux_ms, adopt_ms, ttyd_ready_ms });
    res.status(201).json(serializeSession(session));
  } catch (e: unknown) {
    // This route created the tmux session immediately before adoption, so
    // readiness failure must remove that fresh tmux session too.
    if (session) deleteSession(session.id);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

sessionsRouter.get('/dir-sessions', async (req, res) => {
  try {
    const cwd = (req.query.cwd as string) || '~';
    const resolvedCwd = cwd === '~' ? homedir() : cwd;

    let tmuxOutput: string;
    try {
      const { stdout } = await execFileAsync(
        'tmux',
        // session_path = creation cwd (stable). pane_current_path drifts to
        // whichever pane has focus, so a multi-window session would migrate
        // out of its workspace bucket as the user navigates.
        ['list-sessions', '-F', '#{session_name}|||#{session_path}'],
        { encoding: 'utf-8', timeout: DISCOVERY_COMMAND_TIMEOUT_MS },
      );
      tmuxOutput = stdout.trim();
    } catch {
      res.json([]);
      return;
    }
    if (!tmuxOutput) {
      res.json([]);
      return;
    }

    // Match sessions under the requested dir, but only if no MORE specific
    // tracked path also contains them — otherwise $HOME (a tracked dir at
    // /Users/<u>) would greedily swallow every session in the workspace,
    // since virtually all paths are under $HOME. Most-specific-wins keeps
    // the prefix-match ergonomics (cd into a subdir still attaches to the
    // owning workspace) without the catch-all collapse.
    const allTrackedPaths = [...(await getRepoWorktreePaths()), ...loadSettings().trackedDirs];
    const isMostSpecificMatch = (sessionPath: string) => {
      if (!(sessionPath === resolvedCwd || sessionPath.startsWith(resolvedCwd + '/'))) return false;
      for (const p of allTrackedPaths) {
        if (p === resolvedCwd) continue;
        if (p.length > resolvedCwd.length && (sessionPath === p || sessionPath.startsWith(p + '/')))
          return false;
      }
      return true;
    };
    const matchingSessions = tmuxOutput
      .split('\n')
      .map((line) => {
        const [name, path] = line.split('|||');
        return { name, path };
      })
      .filter((s) => isMostSpecificMatch(s.path));

    const managedByTmuxName = new Map(listSessions().map((session) => [session.tmuxName, session]));
    const results = await Promise.all(
      matchingSessions.map(async (s) => {
        try {
          // Pass the pre-fetched registry entry so the batch avoids a per-item
          // getSession (and its tmux liveness exec) for already-managed sessions.
          const { session } = await adoptAndReady(s.name, managedByTmuxName.get(s.name));
          return {
            ...serializeSession(session),
            command: await getTmuxPaneTitleAsync(session.tmuxName),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[session] failed to ready adopted session ${s.name}: ${message}`);
          return null;
        }
      }),
    );
    res.json(results.filter((session) => session !== null));
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

sessionsRouter.post('/adopt-session/:sessionName', async (req, res) => {
  await adoptOrAttach(req.params.sessionName, res);
});

// Discover orphan tmux sessions

let repoPathCache: Set<string> = new Set();
let repoPathCacheTime = 0;

async function getRepoWorktreePaths(): Promise<Set<string>> {
  if (Date.now() - repoPathCacheTime < 30000) return repoPathCache;
  const paths = new Set<string>();
  const repoPaths: string[] = [];
  for (const { path: repoPath } of listRepos()) {
    paths.add(repoPath);
    repoPaths.push(repoPath);
  }

  const worktreePathLists = await Promise.all(
    repoPaths.map((repoPath) => listWorktreePathsAsync(repoPath)),
  );
  for (const worktreePaths of worktreePathLists) {
    for (const worktreePath of worktreePaths) paths.add(worktreePath);
  }
  repoPathCache = paths;
  repoPathCacheTime = Date.now();
  return paths;
}

async function listWorktreePathsAsync(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: DISCOVERY_COMMAND_TIMEOUT_MS,
    });
    const paths: string[] = [];
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        const worktreePath = line.substring('worktree '.length);
        if (worktreePath && !paths.includes(worktreePath)) paths.push(worktreePath);
      }
    }
    return paths;
  } catch (e) {
    console.error(`git worktree list failed for ${repoPath}:`, e);
    return [];
  }
}

async function getTmuxPaneTitleAsync(name: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      // `=name:` — exact target match (see tmuxSessionExists); the trailing
      // `:` is required — display-message takes a pane target, and on tmux
      // 3.6 a bare `=name` resolves to nothing (empty expansions).
      ['display-message', '-t', `=${name}:`, '-p', '#{pane_title}|||#{pane_current_command}'],
      { encoding: 'utf-8', timeout: DISCOVERY_COMMAND_TIMEOUT_MS },
    );
    const [rawTitle = '', rawCommand = ''] = stdout.trim().split('|||');
    const title = rawTitle.trim();
    if (isMeaningfulPaneTitle(name, title)) {
      return title;
    }
    return rawCommand.trim();
  } catch {
    return '';
  }
}

export interface DiscoveredSession {
  name: string;
  cwd: string;
  created: string;
}

/**
 * Group tmux sessions by directory for the workspace panel's OTHERS list and its
 * "active sessions" filter/dot.
 *
 * Two kinds of sessions surface here:
 *   - Orphans (not app-managed and not inside a git worktree) get their own
 *     workspace entry even in directories the user never explicitly tracked —
 *     that's how the panel discovers stray sessions to adopt.
 *   - Managed sessions only count toward an *already-tracked* non-git dir so its
 *     active dot/filter reflects them. Without this a non-git workspace whose
 *     only session was created through the app would be filtered OUT of the
 *     "active sessions" view (it was excluded from the orphan set and non-git
 *     dirs carry no separate session count). Git worktrees avoid this because
 *     server/routes/repos.ts counts *all* sessions at their path; this mirrors
 *     that for non-git dirs.
 *
 * The map values are only ever consumed by count (`.length`), never enumerated
 * by name, so including managed sessions here does not surface them as adoptable
 * orphans anywhere.
 */
export function bucketDiscoveredSessions(input: {
  tmuxSessions: DiscoveredSession[];
  managedNames: Set<string>;
  repoWorktreePaths: Set<string>;
  trackedDirs: string[];
  home: string;
}): Record<string, { name: string; created: string }[]> {
  const { tmuxSessions, managedNames, repoWorktreePaths, trackedDirs, home } = input;

  const byDir: Record<string, { name: string; created: string }[]> = { [home]: [] };
  for (const dir of trackedDirs) {
    if (!repoWorktreePaths.has(dir) && dir !== home) byDir[dir] = [];
  }

  for (const s of tmuxSessions) {
    const isOrphan = !managedNames.has(s.name) && !repoWorktreePaths.has(s.cwd);
    if (isOrphan) {
      if (!byDir[s.cwd]) byDir[s.cwd] = [];
      byDir[s.cwd].push({ name: s.name, created: s.created });
    } else if (byDir[s.cwd]) {
      // Managed (or worktree) session sitting in a pre-seeded tracked non-git
      // dir — count it so the dir reads as active. Worktree paths are never
      // byDir keys — enforced by the seeding loop above (`!repoWorktreePaths.has`)
      // and the orphan branch (which excludes worktree cwds) — so worktree
      // sessions never leak in here. Loosening either guard would break that.
      byDir[s.cwd].push({ name: s.name, created: s.created });
    }
  }
  return byDir;
}

sessionsRouter.get('/discover-sessions', async (_req, res) => {
  try {
    const byDir = bucketDiscoveredSessions({
      tmuxSessions: listTmuxSessions(),
      managedNames: new Set(listSessions().map((s) => s.tmuxName)),
      repoWorktreePaths: await getRepoWorktreePaths(),
      trackedDirs: loadSettings().trackedDirs,
      home: homedir(),
    });
    // Values may include managed sessions (see bucketDiscoveredSessions) — the
    // client must treat these as a count only, never enumerate them as
    // adoptable orphans.
    res.json(byDir);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
