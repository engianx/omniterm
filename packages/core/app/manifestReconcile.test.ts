import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileInstances, isTabReady, buildPluginIframeSrc, type TrackedInstance } from './manifestReconcile.js';
import type { Tab } from './types';
import type { PluginManifestEntry } from '../plugins/types.js';

function entry(type: string, hasList: boolean): PluginManifestEntry {
  return {
    type,
    label: type,
    endpoints: {
      create: `/api/${type}/instances`,
      ...(hasList ? { list: `/api/${type}/instances` } : {}),
    },
    iframe: { urlTemplate: `/${type}/{id}` },
  };
}

const tab = (type: string, id: string): Tab => ({ type, id, name: id });

// ---- reconcileInstances ----

test('list results are authoritative for list-backed plugins', () => {
  const prev: Record<string, TrackedInstance> = { a: { id: 'a', type: 'dbg', status: 'starting' } };
  const fresh: Record<string, TrackedInstance> = { a: { id: 'a', type: 'dbg', status: 'running' } };
  const merged = reconcileInstances(prev, fresh, new Set(['dbg']), new Set(), new Set());
  assert.equal(merged.a!.status, 'running');
});

test('preserves instances of plugins without a list endpoint', () => {
  const prev: Record<string, TrackedInstance> = { a: { id: 'a', type: 'notepad', file: '/x' } };
  // poll only covers list-backed plugins, so `fresh` is empty here
  const merged = reconcileInstances(prev, {}, new Set(), new Set(), new Set());
  assert.deepEqual(merged.a, { id: 'a', type: 'notepad', file: '/x' });
});

test('A1: optimistic create (running) is kept until the list confirms it', () => {
  const optimistic = new Set(['a']);
  const prev: Record<string, TrackedInstance> = { a: { id: 'a', type: 'dbg', status: 'running' } };
  // list hasn't caught up yet → fresh empty
  const merged = reconcileInstances(prev, {}, new Set(['dbg']), optimistic, new Set());
  assert.ok(merged.a, 'optimistic running seed must survive a not-yet-confirming poll');
  assert.ok(optimistic.has('a'), 'still optimistic until confirmed');

  // next poll includes it → confirmed, optimistic cleared
  const merged2 = reconcileInstances(
    merged,
    { a: { id: 'a', type: 'dbg', status: 'running' } },
    new Set(['dbg']),
    optimistic,
    new Set(),
  );
  assert.ok(merged2.a);
  assert.ok(!optimistic.has('a'), 'optimistic flag cleared once the list confirms');
});

test('A2: closed id is suppressed until the backend list drops it, then tombstone clears', () => {
  const closed = new Set(['a']);
  // backend list still returns the just-closed instance
  const merged = reconcileInstances(
    {},
    { a: { id: 'a', type: 'dbg', status: 'running' } },
    new Set(['dbg']),
    new Set(),
    closed,
  );
  assert.ok(!merged.a, 'closed instance must not resurrect while backend still lists it');
  assert.ok(closed.has('a'), 'tombstone retained while backend still lists it');

  // backend has now dropped it → tombstone clears
  const merged2 = reconcileInstances({}, {}, new Set(['dbg']), new Set(), closed);
  assert.ok(!merged2.a);
  assert.ok(!closed.has('a'), 'tombstone cleared once backend drops the instance');
});

// ---- isTabReady (A3) ----

test('isTabReady: unknown type is not ready', () => {
  assert.equal(isTabReady(tab('x', '1'), new Map(), {}), false);
});

test('isTabReady: list-less plugin is always ready', () => {
  const m = new Map([['notepad', entry('notepad', false)]]);
  assert.equal(isTabReady(tab('notepad', '1'), m, {}), true);
});

test('isTabReady: list-backed plugin ready only when present and running', () => {
  const m = new Map([['dbg', entry('dbg', true)]]);
  const running: Record<string, TrackedInstance> = { '1': { id: '1', type: 'dbg', status: 'running' } };
  const starting: Record<string, TrackedInstance> = { '1': { id: '1', type: 'dbg', status: 'starting' } };
  assert.equal(isTabReady(tab('dbg', '1'), m, running), true);
  assert.equal(isTabReady(tab('dbg', '1'), m, starting), false, 'starting → not ready');
  assert.equal(isTabReady(tab('dbg', '1'), m, {}), false, 'A3: absent instance → not a zombie iframe');
});

test('isTabReady: list-backed with status-less instance is ready', () => {
  const m = new Map([['dbg', entry('dbg', true)]]);
  const inst: Record<string, TrackedInstance> = { '1': { id: '1', type: 'dbg' } };
  assert.equal(isTabReady(tab('dbg', '1'), m, inst), true);
});

// ---- buildPluginIframeSrc ----
// Regression guard for the 003 debugger bug: the embedded SPA scopes its /api/*
// calls off the URL path and restores its file from yamlPath, so the host MUST
// substitute both {id} and {file} (URL-encoded) into the manifest urlTemplate.

test('buildPluginIframeSrc: substitutes {id} and {file}, both URL-encoded', () => {
  const src = buildPluginIframeSrc(
    '/debugger/{id}/?embedded=1&yamlPath={file}',
    'dbg-a0c3',
    '/Users/dev/omniterm-dbg-test/login.test.yaml',
  );
  assert.equal(
    src,
    '/debugger/dbg-a0c3/?embedded=1&yamlPath=%2FUsers%2Fdev%2Fomniterm-dbg-test%2Flogin.test.yaml',
  );
});

test('buildPluginIframeSrc: missing file → empty yamlPath (no "undefined")', () => {
  const src = buildPluginIframeSrc('/debugger/{id}/?embedded=1&yamlPath={file}', 'x', undefined);
  assert.equal(src, '/debugger/x/?embedded=1&yamlPath=');
});

test('buildPluginIframeSrc: encodes ids/paths with reserved chars (no & or # injection)', () => {
  // A path containing & or # must not break out of the query/fragment.
  const src = buildPluginIframeSrc('/d/{id}/?embedded=1&yamlPath={file}', 'a&b', '/x/a b&c#d.yaml');
  assert.equal(src, '/d/a%26b/?embedded=1&yamlPath=%2Fx%2Fa%20b%26c%23d.yaml');
});

test('buildPluginIframeSrc: template without {file} is left untouched', () => {
  // Plugins that resolve everything server-side from {id} use just {id}.
  assert.equal(buildPluginIframeSrc('/notepad/{id}', '7', undefined), '/notepad/7');
});
