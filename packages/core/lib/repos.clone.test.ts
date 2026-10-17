// Separate file from repos.test.ts: paths.ts captures SETTINGS_DIR at import
// time, so each settings directory needs its own module instance (process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('cloning back to a tracked path whose checkout is gone tracks it once', async () => {
  const originalSettingsDir = process.env.SETTINGS_DIR;
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-repos-clone-test-'));
  try {
    const settingsDir = path.join(root, 'settings');
    const source = path.join(root, 'source');
    const clonePath = path.join(root, 'checkout');
    mkdirSync(settingsDir, { recursive: true });
    mkdirSync(source, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    git(source, 'init', '-q');
    git(source, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

    // The checkout was tracked, then deleted (e.g. a container rebuild wiped it).
    process.env.SETTINGS_DIR = settingsDir;
    const settingsFile = path.join(settingsDir, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ trackedRepos: [clonePath], trackedDirs: [] }));

    const { cloneRepo, listRepos } = await import('./repos.js');
    await cloneRepo(source, clonePath);

    // Read the file directly: loadSettings would hide a duplicate by deduping.
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf-8')).trackedRepos, [clonePath]);
    assert.equal(listRepos().length, 1, 'one workspace, not two identical ones');
  } finally {
    if (originalSettingsDir === undefined) delete process.env.SETTINGS_DIR;
    else process.env.SETTINGS_DIR = originalSettingsDir;
    rmSync(root, { recursive: true, force: true });
  }
});
