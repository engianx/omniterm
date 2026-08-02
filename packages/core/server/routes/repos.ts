import { Router } from 'express';
import { listRepos, getRepo, cloneRepo, addLocalPath, removeRepo } from '../../lib/repos.js';
import { displayNameForPath, repoIdForPath } from '../../lib/ids.js';
import { listWorktrees, createWorktree } from '../../lib/worktrees.js';
import { listTmuxSessions } from '../../plugins/terminal/lib/tmux.js';

export const reposRouter: Router = Router();

reposRouter.get('/repos', (_req, res) => {
  res.json(listRepos());
});

reposRouter.post('/repos', async (req, res) => {
  const { url, localPath, destination } = req.body || {};
  if (!url && !localPath) {
    res.status(400).json({ error: 'url or localPath is required' });
    return;
  }
  try {
    const result = localPath ? addLocalPath(localPath) : null;
    const repo = result
      ? { id: repoIdForPath(result.path), name: displayNameForPath(result.path), ...result }
      : cloneRepo(url, destination);
    res.status(201).json(repo);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes('already') ? 409 : 400).json({ error: message });
  }
});

reposRouter.delete('/repos/:repoId', (req, res) => {
  const repo = getRepo(req.params.repoId);
  if (!repo) {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }
  const result = removeRepo(req.params.repoId);
  res.json({ deleted: true, ...result });
});

reposRouter.get('/repos/:repoId/worktrees', (req, res) => {
  const repo = getRepo(req.params.repoId);
  if (!repo) {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }
  const worktrees = listWorktrees(repo.path, req.params.repoId);
  const tmuxSessions = listTmuxSessions();
  res.json(
    worktrees.map((wt) => ({
      ...wt,
      sessionCount: tmuxSessions.filter((s) => s.cwd === wt.path).length,
    })),
  );
});

reposRouter.post('/repos/:repoId/worktrees', async (req, res) => {
  const repo = getRepo(req.params.repoId);
  if (!repo) {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }
  const { branch, newBranch = true } = req.body || {};
  try {
    const wt = createWorktree(repo.path, req.params.repoId, branch, newBranch);
    res.status(201).json(wt);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes('already has a worktree') ? 409 : 400).json({ error: message });
  }
});
