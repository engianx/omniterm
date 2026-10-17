import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';

// On-disk git detection: read `.git` files directly instead of spawning git.
// Kept free of settings/workspace imports so settings.ts can classify tracked
// paths (see deriveLegacyTracking) without an import cycle.

/** A repo root: a work tree with `.git` (dir or linked-worktree file), or a bare repo. */
export function isGitRepo(dirPath: string): boolean {
  return existsSync(path.join(dirPath, '.git')) || existsSync(path.join(dirPath, 'HEAD'));
}

// Resolve the path to the git config file for a repo. Handles a normal `.git`
// directory, a linked-worktree `.git` file (gitdir: -> commondir), and a bare
// repo whose config sits at the root.
function gitConfigPath(repoPath: string): string | null {
  const dotGit = path.join(repoPath, '.git');
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return path.join(dotGit, 'config');
    if (st.isFile()) {
      // A `.git` file without a `gitdir:` line is malformed; fall through to the
      // bare-repo check below (returns null → empty remoteUrl) rather than throw.
      const m = readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitdir = path.resolve(repoPath, m[1].trim());
        const cdFile = path.join(gitdir, 'commondir');
        const common = existsSync(cdFile)
          ? path.resolve(gitdir, readFileSync(cdFile, 'utf-8').trim())
          : gitdir;
        return path.join(common, 'config');
      }
    }
  } catch {
    // fall through to bare-repo check
  }
  const rootCfg = path.join(repoPath, 'config');
  return existsSync(rootCfg) ? rootCfg : null;
}

// Minimal git-config parse: find the [remote "origin"] section and its url.
function parseOriginUrl(configText: string): string {
  let inOrigin = false;
  for (const raw of configText.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (inOrigin) {
      const m = line.match(/^url\s*=\s*(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return '';
}

// Cache parsed remote URLs by config path + mtime. Reading/parsing .git/config
// directly avoids spawning a `git config` subprocess per repo on every workspace
// switch — that synchronous spawn (×N repos) blocked the Node event loop and was
// the dominant cost of listing repos and switching workspaces.
const remoteUrlCache = new Map<string, { mtimeMs: number; url: string }>();

/** The `origin` remote URL of a repo or worktree, or '' when there is none. */
export function getRemoteUrl(repoPath: string): string {
  const cfg = gitConfigPath(repoPath);
  if (!cfg) return '';
  try {
    const { mtimeMs } = statSync(cfg);
    const hit = remoteUrlCache.get(cfg);
    if (hit && hit.mtimeMs === mtimeMs) return hit.url;
    const url = parseOriginUrl(readFileSync(cfg, 'utf-8'));
    remoteUrlCache.set(cfg, { mtimeMs, url });
    return url;
  } catch {
    return '';
  }
}
