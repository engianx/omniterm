import { test } from 'node:test';
import assert from 'node:assert';
import type { Tab } from '../types';
import {
  computeLabels,
  desiredHostTabs,
  fileTabId,
  isFileTabId,
  orderByHost,
  parseFileTabId,
  parsePersisted,
  planReconcile,
  serializePersisted,
  matchesGlob,
  buildDirStatus,
  changedSets,
} from './fileTabs';

const ROOT = '/ws/repo';

test('tab id round-trips kind and absolute path', () => {
  const id = fileTabId(ROOT, 'source', 'src/a:b.ts');
  assert.strictEqual(id, 'file:source:/ws/repo/src/a:b.ts');
  assert.deepStrictEqual(parseFileTabId(id), { kind: 'source', absPath: '/ws/repo/src/a:b.ts' });
  assert.deepStrictEqual(parseFileTabId(fileTabId(ROOT, 'preview', 'README.md')), {
    kind: 'preview',
    absPath: '/ws/repo/README.md',
  });
  assert.strictEqual(parseFileTabId('term-123'), null);
  assert.strictEqual(parseFileTabId('file:bogus:/x'), null);
  assert.strictEqual(isFileTabId('browser:1'), false);
  // Same relative path in two workspaces → distinct ids.
  assert.notStrictEqual(fileTabId('/a', 'source', 'x.ts'), fileTabId('/b', 'source', 'x.ts'));
});

test('labels: unique basenames stay bare', () => {
  assert.deepStrictEqual(computeLabels([{ path: 'a/x.ts' }, { path: 'b/y.ts' }]), ['x.ts', 'y.ts']);
});

test('labels: shared basenames get the shortest disambiguating ancestor', () => {
  assert.deepStrictEqual(
    computeLabels([{ path: 'src/foo/y.ts' }, { path: 'src/bar/y.ts' }, { path: 'z.ts' }]),
    ['y.ts — foo', 'y.ts — bar', 'z.ts'],
  );
  assert.deepStrictEqual(computeLabels([{ path: 'a/lib/x.ts' }, { path: 'b/lib/x.ts' }]), [
    'x.ts — a/lib',
    'x.ts — b/lib',
  ]);
  // Root-level file vs nested file of the same name.
  assert.deepStrictEqual(computeLabels([{ path: 'x.ts' }, { path: 'd/x.ts' }]), ['x.ts', 'x.ts — d']);
});

test('labels: a source/preview pair of one path never grows a suffix', () => {
  assert.deepStrictEqual(computeLabels([{ path: 'docs/README.md' }, { path: 'docs/README.md' }]), [
    'README.md',
    'README.md',
  ]);
});

test('desired tabs carry label, relative title, dirty and renamable:false', () => {
  const tabs = desiredHostTabs(ROOT, [
    { path: 'a/x.ts', kind: 'source', isDirty: true },
    { path: 'b/x.ts', kind: 'source', isDirty: false },
    { path: 'b/x.md', kind: 'preview', isDirty: false },
  ]);
  assert.deepStrictEqual(tabs[0], {
    type: 'file',
    id: 'file:source:/ws/repo/a/x.ts',
    name: 'x.ts — a',
    title: 'a/x.ts',
    dirty: true,
    renamable: false,
  });
  assert.strictEqual(tabs[1].name, 'x.ts — b');
  assert.strictEqual(tabs[2].title, 'Preview: b/x.md');
});

test('persistence: parses objects, legacy strings, and drops junk/duplicates', () => {
  assert.deepStrictEqual(
    parsePersisted({
      open: ['a.ts', { path: 'b.md', kind: 'preview' }, { path: 'c.ts' }, 42, { kind: 'source' }, 'a.ts'],
      active: 'preview::b.md',
    }),
    {
      open: [
        { path: 'a.ts', kind: 'source' },
        { path: 'b.md', kind: 'preview' },
        { path: 'c.ts', kind: 'source' },
      ],
      active: 'preview::b.md',
    },
  );
  assert.deepStrictEqual(parsePersisted(undefined), { open: [], active: null });
  assert.deepStrictEqual(parsePersisted({ open: 'nope' }), { open: [], active: null });
  // Active pointing at something not open is dropped.
  assert.strictEqual(parsePersisted({ open: ['a.ts'], active: 'source::zzz' }).active, null);
});

test('persistence: serialise round-trips through parse', () => {
  const open = [
    { path: 'a.ts', kind: 'source' as const },
    { path: 'a.md', kind: 'preview' as const },
  ];
  const s = serializePersisted(open, { path: 'a.md', kind: 'preview' });
  assert.deepStrictEqual(s, { open, active: 'preview::a.md' });
  assert.deepStrictEqual(parsePersisted(JSON.parse(JSON.stringify(s))), s);
  assert.strictEqual(serializePersisted(open, { path: 'gone.ts', kind: 'source' }).active, null);
  assert.strictEqual(serializePersisted(open, null).active, null);
});

test('orderByHost follows the host strip, unshown items keep store order at the end', () => {
  const items = ['f1', 'f2', 'f3', 'f4'];
  const host: Tab[] = [
    { type: 'terminal', id: 't', name: 't' },
    { type: 'file', id: 'f3', name: '' },
    { type: 'file', id: 'f1', name: '' },
  ];
  assert.deepStrictEqual(orderByHost(items, (x) => x, host), ['f3', 'f1', 'f2', 'f4']);
});

const term: Tab = { type: 'terminal', id: 'term-1', name: 'Term' };

test('reconcile re-adds missing tabs (preview after its source) without touching others', () => {
  const desired = desiredHostTabs(ROOT, [
    { path: 'a.md', kind: 'source', isDirty: false },
    { path: 'a.md', kind: 'preview', isDirty: false },
  ]);
  const plan = planReconcile({ desired, hostTabs: [term], pruneStale: true });
  assert.deepStrictEqual(plan.update, []);
  assert.deepStrictEqual(plan.remove, []);
  assert.deepStrictEqual(
    plan.open.map((o) => [o.tab.id, o.after]),
    [
      ['file:source:/ws/repo/a.md', undefined],
      ['file:preview:/ws/repo/a.md', 'file:source:/ws/repo/a.md'],
    ],
  );
});

test('reconcile converges: applying the plan yields an empty plan', () => {
  const desired = desiredHostTabs(ROOT, [{ path: 'x.ts', kind: 'source', isDirty: true }]);
  const host: Tab[] = [term, { ...desired[0], name: 'old', dirty: false }];
  const plan = planReconcile({ desired, hostTabs: host, pruneStale: true });
  assert.deepStrictEqual(plan.open, []);
  assert.deepStrictEqual(plan.update, [{ id: desired[0].id, patch: { name: 'x.ts', dirty: true } }]);
  const applied = host.map((t) => (t.id === desired[0].id ? { ...t, ...plan.update[0].patch } : t));
  assert.deepStrictEqual(planReconcile({ desired, hostTabs: applied, pruneStale: true }), {
    open: [],
    update: [],
    remove: [],
  });
});

test('reconcile skips suppressed (user-closed) tabs and prunes stale ones only when allowed', () => {
  const desired = desiredHostTabs(ROOT, [{ path: 'x.ts', kind: 'source', isDirty: false }]);
  const stale: Tab = { type: 'file', id: 'file:source:/other/y.ts', name: 'y.ts' };
  const suppressed = new Set([desired[0].id]);
  const p1 = planReconcile({ desired, hostTabs: [term, stale], suppressed, pruneStale: false });
  assert.deepStrictEqual(p1, { open: [], update: [], remove: [] });
  const p2 = planReconcile({ desired, hostTabs: [term, stale], suppressed, pruneStale: true });
  assert.deepStrictEqual(p2.remove, [stale.id]);
  // A non-file tab of another type is never pruned.
  const p3 = planReconcile({ desired: [], hostTabs: [term], pruneStale: true });
  assert.deepStrictEqual(p3.remove, []);
});

test('tree helpers: glob, dir colours, changed sets', () => {
  assert.ok(matchesGlob('*.test.yaml', 'Foo.TEST.yaml'));
  assert.ok(!matchesGlob('*.yaml', 'a.yml'));
  assert.deepStrictEqual(buildDirStatus({ 'a/b/c.ts': 'M ', 'a/d.ts': '??' }), {
    a: 'var(--warning, #d29922)',
    'a/b': 'var(--warning, #d29922)',
  });
  const { files, dirs } = changedSets({ 'a/b/c.ts': 'M ' });
  assert.deepStrictEqual([...files], ['a/b/c.ts']);
  assert.deepStrictEqual([...dirs], ['a', 'a/b']);
});

test('diff tabs: own id and label, opened after their source, never persisted', () => {
  const diffId = fileTabId(ROOT, 'diff', 'a.ts');
  assert.deepStrictEqual(parseFileTabId(diffId), { kind: 'diff', absPath: '/ws/repo/a.ts' });
  const desired = desiredHostTabs(ROOT, [
    { path: 'a.ts', kind: 'source', isDirty: false },
    { path: 'a.ts', kind: 'diff', isDirty: false },
  ]);
  assert.strictEqual(desired[1].name, 'a.ts (diff)');
  assert.strictEqual(desired[1].title, 'Changes: a.ts');
  const plan = planReconcile({ desired, hostTabs: [term], pruneStale: true });
  assert.strictEqual(plan.open[1].after, 'file:source:/ws/repo/a.ts');

  const s = serializePersisted(
    [
      { path: 'a.ts', kind: 'source' },
      { path: 'a.ts', kind: 'diff' },
    ],
    { path: 'a.ts', kind: 'diff' },
  );
  assert.deepStrictEqual(s, { open: [{ path: 'a.ts', kind: 'source' }], active: null });
});
