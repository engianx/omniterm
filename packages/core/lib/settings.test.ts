import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// settings.ts derives SETTINGS_PATH from SETTINGS_DIR at module load
// (process.env.SETTINGS_DIR || ~/.omniterm). Point it at a throwaway dir BEFORE
// the module is imported, then load via dynamic import so the override takes
// effect (and the real ~/.omniterm/settings.json is never touched).
const SETTINGS_DIR = mkdtempSync(path.join(tmpdir(), 'omniterm-settings-'));
process.env.SETTINGS_DIR = SETTINGS_DIR;
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

after(() => rmSync(SETTINGS_DIR, { recursive: true, force: true }));

test('saveSettings/loadSettings round-trip and deep-merge terminalTabs per path', async () => {
  const { loadSettings, saveSettings } = await import('./settings.js');
  try {
    rmSync(SETTINGS_PATH);
  } catch {
    /* fresh */
  }

  saveSettings({ defaultShell: 'zsh', terminalFontSize: 18 });
  let s = loadSettings();
  assert.strictEqual(s.defaultShell, 'zsh');
  assert.strictEqual(s.terminalFontSize, 18);

  // Saving one workspace's terminalTabs must not erase another's (deep-merge).
  saveSettings({ terminalTabs: { '/a': [{ id: 's1', name: 'A' }] } });
  saveSettings({ terminalTabs: { '/b': [{ id: 's2', name: 'B' }] } });
  s = loadSettings();
  assert.deepStrictEqual(Object.keys(s.terminalTabs).sort(), ['/a', '/b']);
  assert.deepStrictEqual(s.terminalTabs['/a'], [{ id: 's1', name: 'A' }]);
});

test('saveSettings deep-merges panel visibility per workspace', async () => {
  const { loadSettings, saveSettings } = await import('./settings.js');
  try {
    rmSync(SETTINGS_PATH);
  } catch {
    /* fresh */
  }

  saveSettings({
    workspacePanelState: { '/a': { browserOpen: true, filesOpen: false } },
  });
  saveSettings({
    workspacePanelState: { '/b': { browserOpen: false, filesOpen: true } },
  });

  const s = loadSettings();
  assert.deepStrictEqual(s.workspacePanelState, {
    '/a': { browserOpen: true, filesOpen: false },
    '/b': { browserOpen: false, filesOpen: true },
  });
});

test('loadSettings migrates global panel visibility to the active workspace', async () => {
  const { loadSettings } = await import('./settings.js');

  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      activePath: '/workspace/current',
      browserPanelOpen: false,
      filesPanelDockedOpen: true,
    }),
  );

  const s = loadSettings();
  assert.deepStrictEqual(s.workspacePanelState, {
    '/workspace/current': { browserOpen: false, filesOpen: true },
  });
  assert.ok(!('browserPanelOpen' in s), 'legacy browser visibility is removed after migration');
  assert.ok(!('filesPanelDockedOpen' in s), 'legacy file visibility is removed after migration');
});

test('loadSettings migrates legacy tabLayouts → terminalTabs without clobbering', async () => {
  const { loadSettings } = await import('./settings.js');

  // Legacy file: only `tabLayouts` (with the removed split-pane `layout` field).
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      tabLayouts: { '/c': [{ id: 's3', name: 'C', layout: { type: 'leaf', sessionId: 's3' } }] },
    }),
  );
  let s = loadSettings();
  assert.ok(!('tabLayouts' in s), 'legacy tabLayouts key is dropped from the loaded settings');
  assert.strictEqual(s.terminalTabs['/c'][0].id, 's3');
  assert.strictEqual(s.terminalTabs['/c'][0].name, 'C');

  // If a file already has terminalTabs, migration must NOT clobber it with tabLayouts.
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      tabLayouts: { '/legacy': [{ id: 'old', name: 'Old' }] },
      terminalTabs: { '/new': [{ id: 'cur', name: 'Cur' }] },
    }),
  );
  s = loadSettings();
  assert.deepStrictEqual(Object.keys(s.terminalTabs), ['/new']);
  assert.ok(!('tabLayouts' in s));
});

/** A directory under the throwaway settings dir, so no test depends on the
 *  machine's real filesystem layout (ids branch on whether a path resolves). */
function dir(...segments: string[]): string {
  const p = path.join(SETTINGS_DIR, ...segments);
  mkdirSync(p, { recursive: true });
  return p;
}

// Regression: the namingSchemes migration made loadSettings dereference
// trackedRepos elements for the first time, inside the try block whose catch
// returns first-run defaults. One non-string entry — writable through the
// unvalidated PUT /api/settings, or hand-edited — turned every load into a
// silent reset, and the next save then overwrote the user's real repos, tabs
// and schemes.
test('loadSettings survives a non-string trackedRepos entry instead of resetting', async () => {
  const { loadSettings } = await import('./settings.js');
  const repo = dir('good-repo');

  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      trackedRepos: [repo, null],
      trackedDirs: ['/tmp/keep-me'],
      terminalTabs: { '/ws': [{ id: 's1', name: 'Tab 1' }] },
      namingSchemes: { 'good-repo': 'gems' },
    }),
  );

  const s = loadSettings();

  assert.ok(s.trackedRepos.includes(repo), 'the real repo must survive a junk sibling entry');
  assert.deepStrictEqual(s.trackedDirs, ['/tmp/keep-me'], 'trackedDirs must not be reset');
  assert.deepStrictEqual(Object.keys(s.terminalTabs), ['/ws'], 'terminalTabs must not be reset');
  assert.ok(
    !s.trackedRepos.some((p) => typeof p !== 'string'),
    'non-string entries must be dropped, not passed downstream',
  );
});

test('loadSettings rekeys namingSchemes from legacy basename ids to repo ids', async () => {
  const { loadSettings } = await import('./settings.js');
  const { repoIdForPath } = await import('./ids.js');

  const work = dir('Acme', 'omniterm');
  const personal = dir('Personal', 'omniterm');
  const monots = dir('Acme', 'monots');
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      trackedRepos: [work, personal, monots],
      namingSchemes: { omniterm: 'gems', monots: 'spices', 'long-gone-repo': 'cities' },
    }),
  );

  const schemes = loadSettings().namingSchemes;

  // Tracked repos carry their scheme over to the new path-derived id...
  assert.strictEqual(schemes[repoIdForPath(work)], 'gems');
  assert.strictEqual(schemes[repoIdForPath(monots)], 'spices');
  // ...and the legacy keys are gone, so assignScheme stops treating them as taken.
  assert.ok(!('omniterm' in schemes));
  assert.ok(!('monots' in schemes));

  // Only the first tracked repo of a colliding name inherits the scheme; the
  // other must fall through to a fresh assignment rather than share the pool.
  assert.ok(!(repoIdForPath(personal) in schemes));

  // A scheme for a repo that is no longer tracked is left untouched — the repo
  // may be re-added, and dropping it would renumber its future worktree names.
  assert.strictEqual(schemes['long-gone-repo'], 'cities');
});

// Regression: legacy keys were written by the old slugFromPath (basename of the
// raw tracked path). Looking them up by the resolved basename skips every repo
// tracked through a differently-named symlink, silently stranding its scheme.
test('migration finds legacy keys written from the tracked path spelling', async () => {
  const { loadSettings } = await import('./settings.js');
  const { repoIdForPath } = await import('./ids.js');

  const target = dir('work', 'omniterm-main');
  const link = path.join(SETTINGS_DIR, 'work', 'current');
  try {
    symlinkSync(target, link);
  } catch {
    /* already created by an earlier run in this process */
  }

  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ trackedRepos: [link], namingSchemes: { current: 'gems' } }),
  );

  const schemes = loadSettings().namingSchemes;
  assert.strictEqual(schemes[repoIdForPath(link)], 'gems');
  assert.ok(!('current' in schemes), 'the legacy key must be consumed, not left orphaned');
});

test('namingSchemes migration is idempotent and leaves migrated files alone', async () => {
  const { loadSettings, saveSettings } = await import('./settings.js');
  const { repoIdForPath } = await import('./ids.js');

  const work = dir('idempotent', 'omniterm');
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ trackedRepos: [work], namingSchemes: { omniterm: 'gems' } }),
  );

  saveSettings({});
  const first = loadSettings().namingSchemes;
  saveSettings({});
  const second = loadSettings().namingSchemes;

  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(second, { [repoIdForPath(work)]: 'gems' });
});
