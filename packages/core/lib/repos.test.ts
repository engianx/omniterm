import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function withTmpdir<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-repos-test-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('non-git paths left in trackedRepos are reclassified as tracked directories', async () => {
  const originalSettingsDir = process.env.SETTINGS_DIR;
  await withTmpdir(async (root) => {
    const settingsDir = path.join(root, 'settings');
    const staleRepoPath = path.join(root, 'tangerine');
    mkdirSync(staleRepoPath, { recursive: true });
    mkdirSync(settingsDir, { recursive: true });
    try {
      // paths.ts captures SETTINGS_DIR at module import time, so set it before
      // importing repos/settings in this test file.
      process.env.SETTINGS_DIR = settingsDir;
      writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ trackedRepos: [staleRepoPath], trackedDirs: [] }),
      );

      const { addLocalPath, listRepos } = await import('./repos.js');
      const { loadSettings } = await import('./settings.js');

      assert.deepEqual(listRepos(), []);
      assert.deepEqual(addLocalPath(staleRepoPath), { type: 'dir', path: staleRepoPath });
      assert.deepEqual(listRepos(), []);
      assert.deepEqual(loadSettings().trackedRepos, []);
      assert.deepEqual(loadSettings().trackedDirs, [staleRepoPath]);
    } finally {
      if (originalSettingsDir === undefined) {
        delete process.env.SETTINGS_DIR;
      } else {
        process.env.SETTINGS_DIR = originalSettingsDir;
      }
    }
  });
});
