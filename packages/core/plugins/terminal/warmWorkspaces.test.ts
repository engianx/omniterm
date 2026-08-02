import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildWarmRenderList,
  pruneSessionsFromByPath,
  survivingTerminalTabs,
  type SessionInfo,
  type WarmSnapshot,
} from './warmWorkspaces.js';
import type { Tab } from '../../app/types.js';

// Terminal tabs are 1:1 with sessions, so tab.id === sessionId throughout.
const termTab = (id: string): Tab => ({ type: 'terminal', id, name: id });
const session = (id: string, worktreeId = 'wt'): SessionInfo => ({
  id,
  worktreeId,
  port: 0,
  url: `/t/${id}/`,
  createdAt: '',
});

describe('buildWarmRenderList', () => {
  const flat = { tag: 'FLAT' };
  const byPath = { a: { tag: 'snap-a' }, b: { tag: 'snap-b' } };

  it('renders the active workspace from flat once flat represents it', () => {
    const list = buildWarmRenderList({ byPath, flat, flatPath: 'b', activePath: 'b' });
    assert.deepStrictEqual(
      list.map((e) => [e.path, e.source, e.visible]),
      [
        ['a', 'snapshot', false],
        ['b', 'flat', true],
      ],
    );
  });

  it('during a switch (flatPath lags activePath) renders BOTH from snapshots', () => {
    // activePath has flipped to b, but flat still holds a's data. b must render
    // from its snapshot so its live iframes are preserved (no remount).
    const list = buildWarmRenderList({ byPath, flat, flatPath: 'a', activePath: 'b' });
    const b = list.find((e) => e.path === 'b');
    const a = list.find((e) => e.path === 'a');
    assert.strictEqual(b?.source, 'snapshot');
    assert.strictEqual(b?.visible, true);
    assert.strictEqual(a?.source, 'snapshot');
    assert.strictEqual(a?.visible, false);
  });

  it('omits the active path when it has no snapshot and flat is not yet hydrated', () => {
    // Cold target mid-switch: activePath has no byPath entry and flat still
    // represents a different path, so the active path renders nothing.
    const list = buildWarmRenderList({ byPath, flat, flatPath: 'a', activePath: 'cold' });
    assert.deepStrictEqual(list.map((e) => e.path).sort(), ['a', 'b']);
    assert.ok(!list.some((e) => e.path === 'cold'));
  });

  it('includes the active path from flat even when not yet in byPath', () => {
    // byPath does not contain the active path 'a' yet (snapshot effect pending).
    const list = buildWarmRenderList({
      byPath: { b: { tag: 'snap-b' } },
      flat,
      flatPath: 'a',
      activePath: 'a',
    });
    const a = list.find((e) => e.path === 'a');
    assert.strictEqual(a?.source, 'flat');
    assert.strictEqual(a?.visible, true);
  });

  it('does not duplicate the active path already present in byPath', () => {
    const list = buildWarmRenderList({ byPath, flat, flatPath: 'a', activePath: 'a' });
    assert.strictEqual(list.filter((e) => e.path === 'a').length, 1);
  });

  it('renders nothing visible when there is no active workspace', () => {
    const list = buildWarmRenderList({ byPath, flat, flatPath: null, activePath: null });
    assert.deepStrictEqual(
      list.map((e) => [e.path, e.visible]),
      [
        ['a', false],
        ['b', false],
      ],
    );
  });
});

describe('survivingTerminalTabs', () => {
  it('keeps a terminal tab whose session is live', () => {
    const tabs = survivingTerminalTabs([termTab('s1')], new Set(['s1']));
    assert.deepStrictEqual(
      tabs.map((t) => t.id),
      ['s1'],
    );
  });

  it('drops a terminal tab whose session died', () => {
    const tabs = survivingTerminalTabs([termTab('s1')], new Set());
    assert.deepStrictEqual(tabs, []);
  });

  it('passes non-terminal tabs through untouched', () => {
    const debugTab: Tab = { type: 'debugger', id: 'dbg', name: 'Debugger' };
    const tabs = survivingTerminalTabs([debugTab, termTab('s1')], new Set()); // s1 dead
    assert.deepStrictEqual(
      tabs.map((t) => t.id),
      ['dbg'], // debugger kept, dead terminal dropped
    );
  });
});

describe('pruneSessionsFromByPath', () => {
  const snap = (ids: string[], worktreeId = 'wt', activeTabId = ids[0] ?? null): WarmSnapshot => ({
    sessions: Object.fromEntries(ids.map((id) => [id, session(id, worktreeId)])),
    tabs: ids.map(termTab),
    activeTabId,
  });

  it('removes a dead session from the holding workspace only', () => {
    const byPath = { a: snap(['s1', 's2']), b: snap(['s3']) };
    const next = pruneSessionsFromByPath(byPath, new Set(['s2']));
    assert.deepStrictEqual(Object.keys(next.a.sessions), ['s1']);
    assert.deepStrictEqual(
      next.a.tabs.map((t) => t.id),
      ['s1'],
    );
    assert.strictEqual(next.b, byPath.b); // untouched workspace keeps its reference
  });

  it('drops a workspace that loses its last terminal', () => {
    const byPath = { a: snap(['s1']), b: snap(['s2']) };
    const next = pruneSessionsFromByPath(byPath, new Set(['s1']));
    assert.deepStrictEqual(Object.keys(next), ['b']);
  });

  it('prunes a deadIds set that spans multiple workspaces', () => {
    const byPath = { a: snap(['s1', 's2']), b: snap(['s3', 's4']) };
    const next = pruneSessionsFromByPath(byPath, new Set(['s2', 's3']));
    assert.deepStrictEqual(Object.keys(next.a.sessions), ['s1']);
    assert.deepStrictEqual(Object.keys(next.b.sessions), ['s4']);
  });

  it('returns the same reference when no session matched', () => {
    const byPath = { a: snap(['s1']) };
    const next = pruneSessionsFromByPath(byPath, new Set(['nope']));
    assert.strictEqual(next, byPath);
  });

  it('reassigns activeTabId when the active tab was dropped', () => {
    const byPath = { a: snap(['s1', 's2'], 'wt', 's2') }; // active is s2
    const next = pruneSessionsFromByPath(byPath, new Set(['s2']));
    assert.strictEqual(next.a.activeTabId, 's1'); // falls to the surviving tab
  });

  it('keeps activeTabId when the active tab survives', () => {
    const byPath = { a: snap(['s1', 's2'], 'wt', 's1') };
    const next = pruneSessionsFromByPath(byPath, new Set(['s2']));
    assert.strictEqual(next.a.activeTabId, 's1');
  });
});
