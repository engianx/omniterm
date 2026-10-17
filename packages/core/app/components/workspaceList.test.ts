import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkspaceRows, hasAlertElsewhere, type WorkspaceEntry } from './workspaceList.js';

function entry(p: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    id: `wt-${p}`,
    path: p,
    name: p.split('/').pop() as string,
    exists: true,
    parent: null,
    git: null,
    sessionCount: 0,
    ...extra,
  };
}

const git = (branch: string, isMainWorktree = true) => ({
  root: '/r',
  branch,
  isMainWorktree,
  remoteUrl: '',
});

test('one list: folders and repos together, linked worktrees nested and labelled by branch', () => {
  const rows = buildWorkspaceRows({
    workspaces: [
      entry('/home/me'),
      entry('/src/app', { git: git('main') }),
      entry('/src/app-feat', { parent: '/src/app', git: git('feat', false) }),
      entry('/src/app-detached', { parent: '/src/app', git: git('HEAD', false) }),
    ],
    orphanSessions: {},
    alertedPaths: new Set(),
  });
  assert.deepEqual(
    rows.map((r) => [r.label, r.children.map((c) => c.label)]),
    [
      ['me', []],
      ['app', ['feat', 'app-detached']],
    ],
  );
});

test('live workspaces sort first, keeping the user order within each group', () => {
  const rows = buildWorkspaceRows({
    workspaces: [
      entry('/a'),
      entry('/b'),
      entry('/c', { git: git('main') }),
      entry('/c-x', { parent: '/c', git: git('x', false), sessionCount: 1 }),
      entry('/d', { sessionCount: 2 }),
    ],
    orphanSessions: { '/b': [{ name: 's', created: '0' }] },
    alertedPaths: new Set(),
  });
  assert.deepEqual(
    rows.map((r) => r.entry.path),
    ['/b', '/c', '/d', '/a'],
  );
  assert.equal(rows[1].live, false, 'a repo is sorted up by a live worktree, not marked live');
  assert.equal(rows[1].children[0].live, true);
});

test('folders with only stray sessions are appended as discovered rows', () => {
  const rows = buildWorkspaceRows({
    workspaces: [entry('/a')],
    orphanSessions: {
      '/a': [],
      '/tmp/stray': [{ name: 's', created: '0' }],
      '/home/idle': [],
    },
    alertedPaths: new Set(),
  });
  assert.deepEqual(
    rows.map((r) => [r.entry.path, r.discovered]),
    [
      ['/tmp/stray', true],
      ['/a', false],
    ],
  );
});

test('same-named top-level rows are qualified so they can be told apart', () => {
  const rows = buildWorkspaceRows({
    workspaces: [entry('/work/app'), entry('/home/app')],
    orphanSessions: {},
    alertedPaths: new Set(),
  });
  assert.deepEqual(
    rows.map((r) => r.label),
    ['app (work)', 'app (home)'],
  );
});

test('hasAlertElsewhere ignores the active workspace', () => {
  const ws = [entry('/a'), entry('/b')];
  assert.equal(hasAlertElsewhere(ws, {}, new Set(['/a']), '/a'), false);
  assert.equal(hasAlertElsewhere(ws, {}, new Set(['/b']), '/a'), true);
  assert.equal(hasAlertElsewhere(ws, { '/x': [] }, new Set(['/x']), '/a'), true);
});
