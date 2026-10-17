import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('saveSettings deep-merges tabOrder per workspace and defaults the new keys', async () => {
  const { loadSettings, saveSettings } = await import('./settings.js');
  try {
    rmSync(SETTINGS_PATH);
  } catch {
    /* fresh */
  }

  let s = loadSettings();
  assert.deepStrictEqual(s.tabOrder, {}, 'tabOrder defaults to an empty map');
  assert.strictEqual(s.sidebarSection, 'workspaces');

  saveSettings({ tabOrder: { '/a': ['t1', 'file:x', 'browser:1'] } });
  saveSettings({ tabOrder: { '/b': ['t2'] } });
  // Re-saving one workspace replaces only that workspace's order.
  saveSettings({ tabOrder: { '/a': ['browser:1', 't1'] } });

  s = loadSettings();
  assert.deepStrictEqual(s.tabOrder, { '/a': ['browser:1', 't1'], '/b': ['t2'] });
});

test('saveSettings deep-merges splitView per workspace', async () => {
  const { loadSettings, saveSettings } = await import('./settings.js');
  try {
    rmSync(SETTINGS_PATH);
  } catch {
    /* fresh */
  }

  assert.deepStrictEqual(loadSettings().splitView, {}, 'splitView defaults to an empty map');
  const a = { secondaryTabId: 'browser:1', primaryTabId: 't1', ratio: 0.4, focused: 'primary' as const };
  const b = { secondaryTabId: null, ratio: 0.5, focused: 'primary' as const };
  saveSettings({ splitView: { '/a': a } });
  saveSettings({ splitView: { '/b': b } });
  assert.deepStrictEqual(loadSettings().splitView, { '/a': a, '/b': b });
  // Re-saving one workspace replaces only that entry.
  const a2 = { ...a, focused: 'secondary' as const, ratio: 0.6 };
  saveSettings({ splitView: { '/a': a2 } });
  assert.deepStrictEqual(loadSettings().splitView, { '/a': a2, '/b': b });
});

test('loadSettings still parses legacy files/browser panel settings', async () => {
  const { loadSettings } = await import('./settings.js');

  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      filesPanelMode: 'overlay',
      browserPanelMode: 'docked',
      workspacePanelState: { '/a': { browserOpen: null, filesOpen: true } },
      filePanelTabs: { '/a': { open: ['README.md', { path: 'doc.md', kind: 'preview' }] } },
      terminalTabs: { '/a': [{ id: 's1', name: 'One' }] },
    }),
  );

  const s = loadSettings();
  assert.deepStrictEqual(s.terminalTabs, { '/a': [{ id: 's1', name: 'One' }] }, 'not reset');
  assert.deepStrictEqual(s.tabOrder, {});
  assert.strictEqual(s.filePanelTabs['/a'].open.length, 2);
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

  assert.deepStrictEqual(
    s.workspaces,
    [repo, '/tmp/keep-me'],
    'the real entries must survive a junk sibling entry',
  );
  assert.deepStrictEqual(Object.keys(s.terminalTabs), ['/ws'], 'terminalTabs must not be reset');
  assert.ok(
    !s.workspaces.some((p) => typeof p !== 'string'),
    'non-string entries must be dropped, not passed downstream',
  );
});

test('loadSettings drops repeated trackedRepos and trackedDirs entries', async () => {
  const { loadSettings } = await import('./settings.js');
  const repo = dir('twice-tracked');

  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      trackedRepos: [repo, repo],
      trackedDirs: ['/tmp/a', '/tmp/b', '/tmp/a'],
    }),
  );

  const s = loadSettings();

  // Each duplicate rendered as a second identical workspace with the same id.
  assert.deepStrictEqual(
    s.workspaces,
    [repo, '/tmp/a', '/tmp/b'],
    'first occurrence keeps its place',
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

/** A directory that passes the on-disk git-repo check (a `.git` dir is enough). */
function repoDir(...segments: string[]): string {
  const p = dir(...segments);
  mkdirSync(path.join(p, '.git'), { recursive: true });
  return p;
}

test('loadSettings migrates trackedRepos + trackedDirs into one deduped workspaces list', async () => {
  const { loadSettings } = await import('./settings.js');
  const repo = repoDir('migrate', 'repo');
  const plain = dir('migrate', 'plain');

  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ trackedRepos: [repo, plain], trackedDirs: [plain, '/tmp/gone'] }),
  );

  const s = loadSettings();
  // Repos first (the order the old panel showed them in), each path once.
  assert.deepStrictEqual(s.workspaces, [repo, plain, '/tmp/gone']);
  // The legacy lists are re-derived on disk: a non-git path filed under
  // trackedRepos lands in trackedDirs.
  assert.deepStrictEqual(s.trackedRepos, [repo]);
  assert.deepStrictEqual(s.trackedDirs, [plain, '/tmp/gone']);
});

test('an existing workspaces list wins over stale legacy lists', async () => {
  const { loadSettings } = await import('./settings.js');
  const plain = dir('wins', 'plain');
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ workspaces: [plain, plain], trackedRepos: [], trackedDirs: ['/tmp/old'] }),
  );
  const s = loadSettings();
  assert.deepStrictEqual(s.workspaces, [plain]);
  assert.deepStrictEqual(s.trackedDirs, [plain]);
});

test('legacy trackedRepos/trackedDirs writes are translated into workspaces', async () => {
  const { loadSettings, saveSettings } = await import('./settings.js');
  const repo = repoDir('legacy-write', 'repo');
  const other = repoDir('legacy-write', 'other-repo');
  const plain = dir('legacy-write', 'plain');

  saveSettings({ workspaces: [plain, repo] });
  // Replacing trackedRepos keeps the dirs and the surviving order...
  saveSettings({ trackedRepos: [repo, other] });
  assert.deepStrictEqual(loadSettings().workspaces, [plain, repo, other]);
  // ...and emptying trackedDirs untracks only the dirs.
  saveSettings({ trackedDirs: [] });
  assert.deepStrictEqual(loadSettings().workspaces, [repo, other]);
  // The file on disk carries the derived lists too, for older readers.
  const onDisk = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  assert.deepStrictEqual(onDisk.trackedRepos, [repo, other]);
  assert.deepStrictEqual(onDisk.trackedDirs, []);
});
