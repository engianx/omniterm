import { Router, type Request, type Response } from 'express';
import { confinePath } from '../../lib/paths.js';
import { allowedRoots } from '../../lib/allowedRoots.js';
import * as git from '../../lib/git.js';

/**
 * /api/git/* for the Changes panel and status bar. Every route takes `cwd`
 * (query for GET, body for POST): any path inside a repo, confined to the
 * allowed roots. The older /api/git/status and /api/git/show live in fs.ts.
 */
export const gitRouter: Router = Router();

type Handler = (cwd: string, req: Request) => Promise<unknown>;

function route(handler: Handler) {
  return async (req: Request, res: Response) => {
    const raw = req.method === 'GET' ? req.query.cwd : req.body?.cwd;
    const cwd = typeof raw === 'string' ? confinePath(raw, allowedRoots()) : null;
    if (!cwd) {
      res.status(403).json({ error: 'Path outside allowed roots' });
      return;
    }
    try {
      res.json((await handler(cwd, req)) ?? { ok: true });
    } catch (e) {
      if (e instanceof git.GitError) res.status(e.status).json({ error: e.message });
      else res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}

gitRouter.get('/git/info', route((cwd) => git.info(cwd)));

gitRouter.get(
  '/git/changes',
  route(async (cwd) => {
    const root = await git.requireRoot(cwd);
    const { staged, unstaged, untracked } = await git.status(root);
    return { root, staged, unstaged, untracked };
  }),
);

gitRouter.get(
  '/git/diff',
  route(async (cwd, req) => {
    const root = await git.requireRoot(cwd);
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    return git.diff(root, p, req.query.staged === '1' || req.query.staged === 'true');
  }),
);

gitRouter.post(
  '/git/stage',
  route(async (cwd, req) => git.stage(await git.requireRoot(cwd), req.body.paths)),
);

gitRouter.post(
  '/git/unstage',
  route(async (cwd, req) => git.unstage(await git.requireRoot(cwd), req.body.paths)),
);

gitRouter.post(
  '/git/discard',
  route(async (cwd, req) => git.discard(await git.requireRoot(cwd), req.body.paths)),
);

gitRouter.post(
  '/git/commit',
  route(async (cwd, req) => ({
    sha: await git.commit(await git.requireRoot(cwd), req.body.message, req.body.amend === true),
  })),
);

gitRouter.get('/git/branches', route(async (cwd) => git.branches(await git.requireRoot(cwd))));

gitRouter.post(
  '/git/checkout',
  route(async (cwd, req) =>
    git.checkout(await git.requireRoot(cwd), req.body.branch, req.body.create === true),
  ),
);

gitRouter.post(
  '/git/branch/rename',
  route(async (cwd, req) => git.renameBranch(await git.requireRoot(cwd), req.body.from, req.body.to)),
);
