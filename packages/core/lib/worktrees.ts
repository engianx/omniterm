import { execFileSync } from 'child_process';
import { copyFileSync, readdirSync } from 'fs';
import path from 'path';
import { generateName } from '../plugins/terminal/lib/naming.js';
import { worktreeIdForPath } from './ids.js';

// `Worktree` crosses the plugin boundary (HostContext.worktrees()), so it is
// declared in @omniterm/plugin-types and re-exported here.
import type { Worktree } from '@omniterm/plugin-types';
export type { Worktree };

function execGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function parseWorktreeList(repoPath: string, repoId: string): Worktree[] {
  let output: string;
  try {
    output = execGit(['worktree', 'list', '--porcelain'], repoPath);
  } catch (e) {
    console.error('git worktree list failed:', e);
    return [];
  }

  const worktrees: Worktree[] = [];
  const blocks = output.split('\n\n').filter((b) => b.trim());
  let isFirst = true;

  for (const block of blocks) {
    const lines = block.split('\n');
    let wtPath = '';
    let branch = '';
    let isBare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.substring('worktree '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.substring('branch '.length).replace('refs/heads/', '');
      } else if (line === 'bare') {
        isBare = true;
      }
    }

    if (!wtPath || isBare) {
      isFirst = false;
      continue;
    }

    const name = path.basename(wtPath);

    worktrees.push({
      id: worktreeIdForPath(wtPath),
      repoId,
      branch: branch || 'HEAD',
      path: wtPath,
      name,
      isMain: isFirst,
    });

    isFirst = false;
  }

  return worktrees;
}

export function listWorktrees(repoPath: string, repoId: string): Worktree[] {
  return parseWorktreeList(repoPath, repoId);
}

export function listBranches(repoPath: string): string[] {
  try {
    const output = execGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repoPath);
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function createWorktree(
  repoPath: string,
  repoId: string,
  branch?: string,
  newBranch: boolean = true,
): Worktree {
  const existingWorktrees = listWorktrees(repoPath, repoId);
  const existingNames = existingWorktrees.map((w) => w.name);
  const existingBranches = new Set(listBranches(repoPath));

  const name = generateName(repoId, existingNames);
  const branchName = branch || name;

  // Avoid collision with existing branches when auto-generating
  if (!branch && existingBranches.has(branchName)) {
    throw new Error(`Branch "${branchName}" already exists`);
  }

  if (existingWorktrees.some((w) => w.branch === branchName)) {
    throw new Error(`Branch "${branchName}" already has a worktree`);
  }

  // Worktree path: {repoPath}-{sanitizedBranchName} (same as Nostromo)
  const sanitized = branchName.replace(/\//g, '-');
  const wtPath = `${repoPath}-${sanitized}`;

  const args = newBranch
    ? ['worktree', 'add', '-b', branchName, wtPath]
    : ['worktree', 'add', wtPath, branchName];

  execGit(args, repoPath);

  // Copy .env* files from the main worktree into the new one (best-effort).
  // Pure Node instead of shelling out to `find` — avoids CLAUDE.md's no-
  // execSync rule and the shell-injection footgun of interpolating paths
  // into a command string.
  try {
    for (const entry of readdirSync(repoPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('.env')) {
        copyFileSync(path.join(repoPath, entry.name), path.join(wtPath, entry.name));
      }
    }
  } catch {
    // Best-effort
  }

  return {
    id: worktreeIdForPath(wtPath),
    repoId,
    branch: branchName,
    path: wtPath,
    name: path.basename(wtPath),
    isMain: false,
  };
}

export function isWorktreeDirty(wtPath: string): boolean {
  try {
    return execGit(['status', '--porcelain'], wtPath).trim().length > 0;
  } catch {
    // If status can't be read, assume dirty so we never force-delete blindly.
    return true;
  }
}

export function removeWorktree(
  repoPath: string,
  wtPath: string,
  { force = false }: { force?: boolean } = {},
): void {
  // Without --force, git refuses to remove a worktree that has uncommitted or
  // untracked changes — that refusal is the safeguard against silent data loss.
  // Only pass --force when the caller has explicitly confirmed discarding work.
  const args = force
    ? ['worktree', 'remove', '--force', wtPath]
    : ['worktree', 'remove', wtPath];
  execGit(args, repoPath);
}

export function renameBranch(wtPath: string, oldName: string, newName: string): void {
  execGit(['branch', '-m', oldName, newName], wtPath);
}
