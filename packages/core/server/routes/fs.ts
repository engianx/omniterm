import { Router, type Response } from 'express';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { trackFileOpened } from '../../lib/telemetry.js';
import { confinePath } from '../../lib/paths.js';
import { allowedRoots } from '../../lib/allowedRoots.js';
import { detectLanguage } from '../../lib/languages.js';

export const fsRouter: Router = Router();

fsRouter.get('/fs', async (req, res) => {
  const rawPath = (req.query.path as string) || '';
  const mode = (req.query.mode as string) || 'list';
  const resolved = confinePath(rawPath, allowedRoots());
  if (!resolved) {
    res.status(403).json({ error: 'Path outside allowed roots' });
    return;
  }

  try {
    if (mode === 'read') {
      // Images, PDFs, and CSV/TSV no longer come through here — they stream
      // from the path-confined raw route (/api/preview/raw) into dedicated
      // in-place viewers. This path serves editable text only.
      const s = await stat(resolved);
      const ext = path.extname(resolved).toLowerCase();
      if (s.size > 1024 * 1024) {
        res.status(413).json({ error: 'File too large (>1MB)' });
        return;
      }
      const content = await readFile(resolved, 'utf-8');
      const lang = detectLanguage(ext, path.basename(resolved).toLowerCase());
      trackFileOpened(lang);
      res.json({ path: rawPath, content, language: lang, size: s.size });
      return;
    }

    const entries = await readdir(resolved, { withFileTypes: true });
    const result = entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? ('directory' as const) : ('file' as const),
    }));
    result.sort((a, b) =>
      a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name),
    );
    res.json({ path: rawPath, entries: result });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

fsRouter.put('/fs', async (req, res) => {
  const { path: filePath, content } = req.body || {};
  if (!filePath || content === undefined) {
    res.status(400).json({ error: 'path and content required' });
    return;
  }
  const resolved = confinePath(filePath, allowedRoots());
  if (!resolved) {
    res.status(403).json({ error: 'Path outside allowed roots' });
    return;
  }
  try {
    await writeFile(resolved, content, 'utf-8');
    res.json({ saved: true, path: filePath });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ----- file operations (the Files tree's context menu) -----
//
//   POST   /api/fs/create {path}      → 201 {path}       empty file; 409 if it exists
//   POST   /api/fs/mkdir  {path}      → 201 {path}       one folder; 409 if it exists
//   POST   /api/fs/rename {from, to}  → 200 {from, to}   rename or move; 409 if `to` exists
//   DELETE /api/fs?path=              → 200 {deleted}    folders recursively
//
// Every path is absolute (or `~/…`) and confined to the allowed roots (403).
// A missing parent (or `from`/`path`) is 404. Deleting or moving a path that
// is, or contains, an allowed root — $HOME, a tracked workspace, a worktree —
// is refused with 400: those are workspaces, removed from the Workspaces list.

/**
 * True when `resolved` is one of `roots` or an ancestor of one, so removing or
 * moving it would take a workspace (or the home directory) with it.
 */
export function containsAllowedRoot(resolved: string, roots: string[]): boolean {
  return roots.some((raw) => {
    const root = path.normalize(path.resolve(raw));
    return root === resolved || root.startsWith(resolved.endsWith(path.sep) ? resolved : resolved + path.sep);
  });
}

/** Confine a request-body path; sends 400/403 and returns null when unusable. */
function confineBodyPath(raw: unknown, field: string, res: Response): string | null {
  if (typeof raw !== 'string' || !raw) {
    res.status(400).json({ error: `${field} is required` });
    return null;
  }
  const resolved = confinePath(raw, allowedRoots());
  if (!resolved) res.status(403).json({ error: 'Path outside allowed roots' });
  return resolved;
}

function sendFsError(res: Response, e: unknown, target: string): void {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    res.status(409).json({ error: `${target} already exists` });
  } else if (code === 'ENOENT' || code === 'ENOTDIR') {
    res.status(404).json({ error: 'Parent folder not found' });
  } else {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** lstat that maps "not there" to null (a dangling symlink still counts as there). */
async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

fsRouter.post('/fs/create', async (req, res) => {
  const resolved = confineBodyPath(req.body?.path, 'path', res);
  if (!resolved) return;
  try {
    // `wx`: fail with EEXIST rather than truncating an existing file.
    await writeFile(resolved, '', { encoding: 'utf-8', flag: 'wx' });
    res.status(201).json({ path: resolved });
  } catch (e: unknown) {
    sendFsError(res, e, path.basename(resolved));
  }
});

fsRouter.post('/fs/mkdir', async (req, res) => {
  const resolved = confineBodyPath(req.body?.path, 'path', res);
  if (!resolved) return;
  try {
    await mkdir(resolved);
    res.status(201).json({ path: resolved });
  } catch (e: unknown) {
    sendFsError(res, e, path.basename(resolved));
  }
});

fsRouter.post('/fs/rename', async (req, res) => {
  const from = confineBodyPath(req.body?.from, 'from', res);
  if (!from) return;
  const to = confineBodyPath(req.body?.to, 'to', res);
  if (!to) return;
  if (containsAllowedRoot(from, allowedRoots())) {
    res.status(400).json({ error: 'Cannot move a workspace root' });
    return;
  }
  if (to === from || to.startsWith(from + path.sep)) {
    res.status(400).json({ error: 'Cannot move a folder into itself' });
    return;
  }
  try {
    if (!(await lstatOrNull(from))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // rename(2) silently replaces an existing file, so check first.
    if (await lstatOrNull(to)) {
      res.status(409).json({ error: `${path.basename(to)} already exists` });
      return;
    }
    await rename(from, to);
    res.json({ from, to });
  } catch (e: unknown) {
    sendFsError(res, e, path.basename(to));
  }
});

fsRouter.delete('/fs', async (req, res) => {
  const resolved = confineBodyPath(req.query.path, 'path', res);
  if (!resolved) return;
  if (containsAllowedRoot(resolved, allowedRoots())) {
    res.status(400).json({ error: 'Cannot delete a workspace root' });
    return;
  }
  try {
    if (!(await lstatOrNull(resolved))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // A symlink is removed itself, never followed.
    await rm(resolved, { recursive: true });
    res.json({ deleted: true, path: resolved });
  } catch (e: unknown) {
    sendFsError(res, e, path.basename(resolved));
  }
});

fsRouter.get('/browse', async (req, res) => {
  const dirPath = (req.query.path as string) || homedir();
  const resolved = confinePath(dirPath, allowedRoots());
  if (!resolved) {
    res.status(403).json({ error: 'Path outside allowed roots' });
    return;
  }
  if (!existsSync(resolved)) {
    res.status(404).json({ error: 'Path not found' });
    return;
  }

  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const dirs = (
      await Promise.all(
        entries.map(async (e) => {
          if (e.name.startsWith('.')) return null;
          if (e.isDirectory()) return e.name;
          if (!e.isSymbolicLink()) return null;
          try {
            const s = await stat(path.join(resolved, e.name));
            return s.isDirectory() ? e.name : null;
          } catch {
            return null;
          }
        }),
      )
    )
      .filter((name): name is string => Boolean(name))
      .sort();
    const isGitRepo =
      existsSync(path.join(resolved, '.git')) || existsSync(path.join(resolved, 'HEAD'));
    // null when going up would leave the allowed roots, so the picker can
    // hide ".." instead of offering a step that 403s.
    const up = path.dirname(resolved);
    const parent = up !== resolved && confinePath(up, allowedRoots()) ? up : null;
    res.json({ path: resolved, parent, dirs, isGitRepo });
  } catch {
    res.status(403).json({ error: 'Cannot read directory' });
  }
});

// Git status: returns { [relativePath]: status } where status is M, A, D, ?, etc.
fsRouter.get('/git/status', (req, res) => {
  const cwd = (req.query.cwd as string) || '';
  const resolved = confinePath(cwd, allowedRoots());
  if (!resolved) {
    res.status(403).json({ error: 'Path outside allowed roots' });
    return;
  }
  try {
    const output = execFileSync('git', ['status', '--porcelain', '-uall'], {
      cwd: resolved,
      encoding: 'utf-8',
    }).replace(/\n$/, '');
    const files: Record<string, string> = {};
    if (output) {
      for (const line of output.split('\n')) {
        const xy = line.substring(0, 2);
        const filePath = line.substring(3);
        // Use the index+worktree status pair (e.g. " M", "??", "A ", "MM")
        files[filePath] = xy;
      }
    }
    res.json(files);
  } catch {
    res.json({});
  }
});

// Git show: returns file content at HEAD
fsRouter.get('/git/show', (req, res) => {
  const cwd = (req.query.cwd as string) || '';
  const filePath = (req.query.path as string) || '';
  const resolved = confinePath(cwd, allowedRoots());
  if (!resolved) {
    res.status(403).json({ error: 'Path outside allowed roots' });
    return;
  }
  if (!filePath) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  try {
    const content = execFileSync('git', ['show', `HEAD:${filePath}`], {
      cwd: resolved,
      encoding: 'utf-8',
    });
    res.json({ content });
  } catch {
    // File doesn't exist at HEAD (new file)
    res.json({ content: '' });
  }
});
