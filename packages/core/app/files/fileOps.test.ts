import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  breadcrumbSegments,
  diffModeFor,
  invalidEntryName,
  isInside,
  joinRel,
  parentOf,
  relativeTo,
  remapPath,
  treeMenuEntries,
} from './fileOps';

test('isInside / relativeTo match whole path segments only', () => {
  assert.equal(isInside('/w/app', '/w/app'), true);
  assert.equal(isInside('/w/app/src/a.ts', '/w/app'), true);
  assert.equal(isInside('/w/apple', '/w/app'), false);
  assert.equal(relativeTo('/w/app', '/w/app'), '');
  assert.equal(relativeTo('/w/app', '/w/app/src/a.ts'), 'src/a.ts');
  assert.equal(relativeTo('/w/app', '/w/apple/a.ts'), null);
  assert.equal(relativeTo('/', '/etc/hosts'), 'etc/hosts');
});

test('joinRel / parentOf', () => {
  assert.equal(joinRel('', 'a'), 'a');
  assert.equal(joinRel('src', 'a'), 'src/a');
  assert.equal(parentOf('src/lib/a.ts'), 'src/lib');
  assert.equal(parentOf('a.ts'), '');
});

test('invalidEntryName rejects empty, separators and dot names', () => {
  assert.equal(invalidEntryName('a.ts'), null);
  assert.equal(invalidEntryName('.env'), null);
  assert.ok(invalidEntryName(''));
  assert.ok(invalidEntryName('   '));
  assert.ok(invalidEntryName('a/b'));
  assert.ok(invalidEntryName('.'));
  assert.ok(invalidEntryName('..'));
});

test('remapPath moves the renamed path and its descendants only', () => {
  assert.equal(remapPath('src', 'src', 'lib'), 'lib');
  assert.equal(remapPath('src/a/b.ts', 'src', 'lib'), 'lib/a/b.ts');
  assert.equal(remapPath('srcs/b.ts', 'src', 'lib'), null);
  assert.equal(remapPath('other.ts', 'src', 'lib'), null);
});

test('diffModeFor picks worktree changes over staged ones', () => {
  assert.equal(diffModeFor('??'), 'worktree');
  assert.equal(diffModeFor(' M'), 'worktree');
  assert.equal(diffModeFor('MM'), 'worktree');
  assert.equal(diffModeFor('M '), 'staged');
  assert.equal(diffModeFor('A '), 'staged');
  assert.equal(diffModeFor(undefined), null);
  assert.equal(diffModeFor('  '), null);
});

const actions = (t: Parameters<typeof treeMenuEntries>[0]) => treeMenuEntries(t).map((e) => e.action);

test('folder menu: terminal, workspace, create, rename/delete, copy', () => {
  const entries = treeMenuEntries({
    isDir: true,
    isRoot: false,
    canSplit: true,
    hasChanges: true,
    previewable: false,
  });
  assert.deepEqual(
    entries.map((e) => e.action),
    [
      'open-terminal',
      'open-workspace',
      'new-file',
      'new-folder',
      'rename',
      'delete',
      'copy-path',
      'copy-relative-path',
    ],
  );
  assert.deepEqual(
    entries.filter((e) => e.separatorBefore).map((e) => e.action),
    ['new-file', 'rename', 'copy-path'],
  );
});

test('root menu cannot rename, delete or re-open the workspace', () => {
  assert.deepEqual(
    actions({ isDir: true, isRoot: true, canSplit: true, hasChanges: false, previewable: false }),
    ['open-terminal', 'new-file', 'new-folder', 'copy-path'],
  );
});

test('file menu shows side / diff / preview only when they apply', () => {
  assert.deepEqual(
    actions({ isDir: false, isRoot: false, canSplit: true, hasChanges: true, previewable: true }),
    [
      'open',
      'open-side',
      'open-diff',
      'open-preview',
      'rename',
      'delete',
      'copy-path',
      'copy-relative-path',
    ],
  );
  assert.deepEqual(
    actions({ isDir: false, isRoot: false, canSplit: false, hasChanges: false, previewable: false }),
    ['open', 'rename', 'delete', 'copy-path', 'copy-relative-path'],
  );
});

test('breadcrumbSegments collapses the home directory into ~', () => {
  assert.deepEqual(breadcrumbSegments('/home/u/git/app'), [
    { label: '~', path: '/home/u' },
    { label: 'git', path: '/home/u/git' },
    { label: 'app', path: '/home/u/git/app' },
  ]);
  assert.deepEqual(breadcrumbSegments('/Users/u'), [{ label: '~', path: '/Users/u' }]);
  assert.deepEqual(breadcrumbSegments('/srv/data'), [
    { label: '/', path: '/' },
    { label: 'srv', path: '/srv' },
    { label: 'data', path: '/srv/data' },
  ]);
});
