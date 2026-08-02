import { Router } from 'express';
import { readdir, readFile, writeFile, stat } from 'fs/promises';
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
    res.json({ path: resolved, parent: path.dirname(resolved), dirs, isGitRepo });
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
