import { Router, type Response } from 'express';
import { allowedRoots } from '../../lib/allowedRoots.js';
import { confinePath } from '../../lib/paths.js';
import {
  addWorkspace,
  cloneWorkspace,
  completeDirs,
  createWorkspaceWorktree,
  deleteWorkspaceWorktree,
  findWorkspace,
  listWorkspaces,
  untrackWorkspace,
  WorkspaceError,
} from '../../lib/workspaces.js';
import { listTmuxSessions } from '../../plugins/terminal/lib/tmux.js';

export const workspacesRouter: Router = Router();

function listWithSessions() {
  return listWorkspaces(listTmuxSessions().map((s) => s.cwd));
}

/** Confine a request path, answering 400/403 itself when it can't be used. */
function confined(raw: unknown, res: Response): string | null {
  if (typeof raw !== 'string' || !raw) {
    res.status(400).json({ error: 'path is required' });
    return null;
  }
  const resolved = confinePath(raw, allowedRoots());
  if (!resolved) res.status(403).json({ error: 'Path outside allowed roots' });
  return resolved;
}

function sendError(res: Response, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  res.status(e instanceof WorkspaceError ? e.status : 500).json({ error: message });
}

/** Answer with the listed entry for `dirPath` (created → 201, else 200). */
async function sendEntry(res: Response, dirPath: string, status: number): Promise<void> {
  const entry = findWorkspace(await listWithSessions(), dirPath);
  if (entry) res.status(status).json(entry);
  else res.status(500).json({ error: `"${dirPath}" is not listed after tracking` });
}

workspacesRouter.get('/workspaces', async (_req, res) => {
  try {
    res.json({ workspaces: await listWithSessions() });
  } catch (e) {
    sendError(res, e);
  }
});

workspacesRouter.post('/workspaces', async (req, res) => {
  const dirPath = confined(req.body?.path, res);
  if (!dirPath) return;
  try {
    const { path, created } = addWorkspace(dirPath);
    await sendEntry(res, path, created ? 201 : 200);
  } catch (e) {
    sendError(res, e);
  }
});

workspacesRouter.post('/workspaces/clone', async (req, res) => {
  const url = req.body?.url;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  let destination: string | undefined;
  if (req.body?.destination) {
    const d = confined(req.body.destination, res);
    if (!d) return;
    destination = d;
  }
  try {
    await sendEntry(res, await cloneWorkspace(url.trim(), destination), 201);
  } catch (e) {
    sendError(res, e);
  }
});

workspacesRouter.delete('/workspaces', (req, res) => {
  const dirPath = confined(req.query.path, res);
  if (!dirPath) return;
  try {
    res.json({ deleted: true, ...untrackWorkspace(dirPath) });
  } catch (e) {
    sendError(res, e);
  }
});

workspacesRouter.post('/workspaces/worktrees', async (req, res) => {
  const dirPath = confined(req.body?.path, res);
  if (!dirPath) return;
  const { branch, newBranch = true } = req.body || {};
  if (branch !== undefined && (typeof branch !== 'string' || !branch.trim())) {
    res.status(400).json({ error: 'branch must be a non-empty string' });
    return;
  }
  try {
    await sendEntry(res, createWorkspaceWorktree(dirPath, branch, newBranch !== false), 201);
  } catch (e) {
    sendError(res, e);
  }
});

workspacesRouter.delete('/workspaces/worktrees', (req, res) => {
  const dirPath = confined(req.query.path, res);
  if (!dirPath) return;
  const force = req.query.force === 'true' || req.body?.force === true;
  const removal = deleteWorkspaceWorktree(dirPath, force);
  if (removal.ok) {
    res.json({ deleted: true, sessionsKilled: removal.sessionsKilled });
  } else {
    res.status(removal.status).json({ error: removal.error, requiresForce: removal.requiresForce });
  }
});

workspacesRouter.get('/workspaces/complete', async (req, res) => {
  const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
  res.json({ dirs: await completeDirs(prefix, allowedRoots()) });
});
