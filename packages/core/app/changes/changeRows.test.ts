import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeCount,
  changeGroups,
  filterBranches,
  rowPaths,
  statusColor,
  statusLetter,
  statusTitle,
  type GitChanges,
} from './changeRows';

const changes: GitChanges = {
  root: '/r',
  staged: [
    { path: 'src/new.ts', status: 'R', oldPath: 'src/old.ts' },
    { path: 'a.txt', status: 'M' },
  ],
  unstaged: [
    { path: 'a.txt', status: 'M' },
    { path: 'z/conflict.txt', status: 'U' },
  ],
  untracked: [{ path: 'b c.md', status: '?' }],
};

test('changeGroups folds untracked into Changes, sorted by path, with name/dir split', () => {
  const g = changeGroups(changes);
  assert.deepEqual(
    g.staged.map((r) => [r.key, r.name, r.dir, r.staged]),
    [
      ['s:a.txt', 'a.txt', '', true],
      ['s:src/new.ts', 'new.ts', 'src', true],
    ],
  );
  assert.deepEqual(
    g.changes.map((r) => [r.key, r.status]),
    [
      ['w:a.txt', 'M'],
      ['w:b c.md', '?'],
      ['w:z/conflict.txt', 'U'],
    ],
  );
  assert.equal(g.staged[1].oldPath, 'src/old.ts');
  assert.equal('oldPath' in g.staged[0], false);
});

test('changeCount counts distinct files', () => {
  assert.equal(changeCount(changes), 4);
  assert.equal(changeCount(null), 0);
});

test('rowPaths names both sides of a rename', () => {
  const g = changeGroups(changes);
  assert.deepEqual(rowPaths(g.staged[1]), ['src/new.ts', 'src/old.ts']);
  assert.deepEqual(rowPaths(g.staged[0]), ['a.txt']);
});

test('status letters, titles and colours', () => {
  assert.equal(statusLetter('?'), 'U');
  assert.equal(statusLetter('U'), '!');
  assert.equal(statusLetter('M'), 'M');
  assert.equal(statusColor('?'), statusColor('A'));
  assert.match(statusColor('D') ?? '', /danger/);
  assert.match(statusColor('M') ?? '', /warning/);
  assert.match(statusColor('R') ?? '', /warning/);
  assert.match(statusColor('U') ?? '', /danger/);
  assert.equal(statusTitle(changeGroups(changes).staged[1]), 'Renamed from src/old.ts');
});

test('filterBranches is a case-insensitive substring match', () => {
  const b = [{ name: 'main' }, { name: 'Feat/Login' }, { name: 'fix-login' }];
  assert.deepEqual(filterBranches(b, '  LOGIN ').map((x) => x.name), ['Feat/Login', 'fix-login']);
  assert.equal(filterBranches(b, '').length, 3);
});
