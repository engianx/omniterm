import { Router } from 'express';
import { readdir, stat, readFile } from 'fs/promises';
import nodePath from 'path';
import { listWorktrees, renameBranch, isWorktreeDirty } from '../../lib/worktrees.js';
import { listRepos } from '../../lib/repos.js';
import { removeWorktreeAndSessions } from '../../lib/workspaces.js';
import { registryUrlForRequest } from '../../browserRegistry/tabRegistry.js';
import {
  createSession,
  deleteSession,
  ensureSessionTtydReady,
  listSessions,
} from '../../plugins/terminal/lib/sessions.js';
import { getTmuxPaneTitle } from '../../plugins/terminal/lib/tmux.js';
import { resolveWorktreePath } from '../../lib/paths.js';
import { detectLanguage } from '../../lib/languages.js';
import { sendWorktreeSessionReadinessError } from './worktreeSessionErrors.js';

export const worktreesRouter: Router = Router();

function findWorktreePath(wtId: string): string | null {
  for (const repo of listRepos()) {
    const wt = listWorktrees(repo.path, repo.id).find((w) => w.id === wtId);
    if (wt) return wt.path;
  }
  return null;
}

worktreesRouter.delete('/worktrees/:wtId', (req, res) => {
  const { wtId } = req.params;
  const force = req.query.force === 'true' || (req.body && req.body.force === true);
  for (const repo of listRepos()) {
    const wt = listWorktrees(repo.path, repo.id).find((w) => w.id === wtId);
    if (wt) {
      const removal = removeWorktreeAndSessions(repo.path, wt, force);
      if (removal.ok) {
        res.json({ deleted: true, sessionsKilled: removal.sessionsKilled });
      } else {
        res
          .status(removal.status)
          .json({ error: removal.error, requiresForce: removal.requiresForce });
      }
      return;
    }
  }
  res.status(404).json({ error: 'Worktree not found' });
});

worktreesRouter.get('/worktrees/:wtId/status', (req, res) => {
  const wtPath = findWorktreePath(req.params.wtId);
  if (!wtPath) {
    res.status(404).json({ error: 'Worktree not found' });
    return;
  }
  // Lets the UI decide whether to warn about uncommitted work before deleting.
  // Probed on demand (delete click) rather than folded into the worktree list
  // so we don't spawn a `git status` per worktree on every workspace refresh.
  res.json({ dirty: isWorktreeDirty(wtPath) });
});

worktreesRouter.post('/worktrees/:wtId/rename', (req, res) => {
  const { wtId } = req.params;
  const { newName } = req.body || {};
  if (!newName) {
    res.status(400).json({ error: 'newName is required' });
    return;
  }

  for (const repo of listRepos()) {
    const wt = listWorktrees(repo.path, repo.id).find((w) => w.id === wtId);
    if (wt) {
      try {
        renameBranch(wt.path, wt.branch, newName);
        res.json({ branch: newName });
      } catch (e: unknown) {
        res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
  }
  res.status(404).json({ error: 'Worktree not found' });
});

worktreesRouter.get('/worktrees/:wtId/sessions', (req, res) => {
  const sessions = listSessions(req.params.wtId);
  res.json(
    sessions.map((s) => ({
      id: s.id,
      worktreeId: s.worktreeId,
      port: s.port,
      url: `/t/${s.id}/`,
      createdAt: s.createdAt,
      command: getTmuxPaneTitle(s.tmuxName),
    })),
  );
});

worktreesRouter.post('/worktrees/:wtId/sessions', async (req, res) => {
  const { wtId } = req.params;
  const { worktreePath } = req.body || {};
  if (!worktreePath) {
    res.status(400).json({ error: 'worktreePath is required' });
    return;
  }

  try {
    // Tab id = session id (single-pane). Builder is invoked after the id
    // is generated inside createSession so the URL gets the real tabId.
    const session = createSession(wtId, worktreePath, {
      registryUrlFor: (tabId) => registryUrlForRequest(req, tabId),
    });
    try {
      await ensureSessionTtydReady(session);
    } catch (e: unknown) {
      sendWorktreeSessionReadinessError(res, session, e, deleteSession);
      return;
    }
    res.status(201).json({
      id: session.id,
      worktreeId: session.worktreeId,
      port: session.port,
      url: `/t/${session.id}/`,
      createdAt: session.createdAt,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes('No free ports') ? 503 : 500).json({ error: message });
  }
});

worktreesRouter.get('/worktrees/:wtId/files', async (req, res) => {
  const wtPath = findWorktreePath(req.params.wtId);
  if (!wtPath) {
    res.status(404).json({ error: 'Worktree not found' });
    return;
  }

  const relativePath = (req.query.path as string) || '';
  let resolved: string;
  try {
    resolved = resolveWorktreePath(wtPath, relativePath);
  } catch {
    res.status(403).json({ error: 'Path traversal detected' });
    return;
  }

  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const result = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith('.'))
        .map(async (e) => {
          const type = e.isDirectory() ? ('directory' as const) : ('file' as const);
          let size = 0;
          if (type === 'file') {
            try {
              size = (await stat(nodePath.join(resolved, e.name))).size;
            } catch {}
          }
          return { name: e.name, type, size };
        }),
    );
    result.sort((a, b) =>
      a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name),
    );
    res.json({ path: relativePath, entries: result });
  } catch {
    res.status(404).json({ error: 'Path not found' });
  }
});

worktreesRouter.get('/worktrees/:wtId/file', async (req, res) => {
  const wtPath = findWorktreePath(req.params.wtId);
  if (!wtPath) {
    res.status(404).json({ error: 'Worktree not found' });
    return;
  }

  const relativePath = (req.query.path as string) || '';
  if (!relativePath) {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  let resolved: string;
  try {
    resolved = resolveWorktreePath(wtPath, relativePath);
  } catch {
    res.status(403).json({ error: 'Path traversal detected' });
    return;
  }

  try {
    const s = await stat(resolved);
    if (s.size > 1024 * 1024) {
      res.status(413).json({ error: 'File too large (>1MB)' });
      return;
    }
    const content = await readFile(resolved, 'utf-8');
    const ext = nodePath.extname(resolved).toLowerCase();
    const base = nodePath.basename(resolved).toLowerCase();
    const language = detectLanguage(ext, base);
    res.json({ path: relativePath, content, language, size: s.size });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});
