import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeAfterRemoval,
  clampRatio,
  closeSplit,
  focusPane,
  followActive,
  moveToOtherSide,
  openToSide,
  parseSplitViews,
  resolvePanes,
  restoreSplit,
  selectTab,
  singlePane,
  toPersisted,
  type SplitState,
} from './splitView';

const TABS = ['a', 'b', 'c', 'd'];
const split = (otherTabId: string | null, focused: 'primary' | 'secondary' = 'primary', ratio = 0.5): SplitState => ({
  otherTabId,
  focused,
  ratio,
});

test('clampRatio keeps each pane at least 20% and defaults junk to 0.5', () => {
  assert.equal(clampRatio(0.05), 0.2);
  assert.equal(clampRatio(0.95), 0.8);
  assert.equal(clampRatio(0.37), 0.37);
  assert.equal(clampRatio(Number.NaN), 0.5);
  assert.equal(clampRatio('0.3'), 0.5);
  assert.equal(clampRatio(undefined), 0.5);
});

test('resolvePanes maps the focused side to the active tab', () => {
  assert.deepEqual(resolvePanes(split('b'), 'a', TABS), { primary: 'a', secondary: 'b', focused: 'primary' });
  assert.deepEqual(resolvePanes(split('a', 'secondary'), 'b', TABS), {
    primary: 'a',
    secondary: 'b',
    focused: 'secondary',
  });
});

test('resolvePanes reads a stale split as a single pane', () => {
  const single = { primary: 'a', secondary: null, focused: 'primary' };
  assert.deepEqual(resolvePanes(split('gone'), 'a', TABS), single);
  assert.deepEqual(resolvePanes(split('a'), 'a', TABS), single);
  assert.deepEqual(resolvePanes(split(null), 'a', TABS), single);
  // An active id the strip does not know yet (mid-restore) still renders.
  assert.deepEqual(resolvePanes(split('b'), 'x', TABS), { primary: 'x', secondary: null, focused: 'primary' });
});

test('openToSide from a single pane keeps the active tab on the left', () => {
  const r = openToSide(singlePane(0.6), 'a', TABS, 'c');
  assert.equal(r.activeTabId, 'c', 'the opened tab takes focus');
  assert.deepEqual(resolvePanes(r.split, r.activeTabId, TABS), {
    primary: 'a',
    secondary: 'c',
    focused: 'secondary',
  });
  assert.equal(r.split.ratio, 0.6, 'ratio kept');
});

test('openToSide on the left side, and on the active tab itself', () => {
  const left = openToSide(singlePane(), 'a', TABS, 'c', 'primary');
  assert.deepEqual(resolvePanes(left.split, left.activeTabId, TABS), {
    primary: 'c',
    secondary: 'a',
    focused: 'primary',
  });
  // The active tab cannot be in both panes: its left neighbour stays behind.
  const self = openToSide(singlePane(), 'c', TABS, 'c');
  assert.deepEqual(resolvePanes(self.split, self.activeTabId, TABS), {
    primary: 'b',
    secondary: 'c',
    focused: 'secondary',
  });
  const first = openToSide(singlePane(), 'a', TABS, 'a');
  assert.equal(resolvePanes(first.split, first.activeTabId, TABS).primary, 'b', 'right neighbour for the first tab');
  // Nothing to put opposite it.
  const lone = openToSide(singlePane(), 'a', ['a'], 'a');
  assert.equal(lone.split.otherTabId, null);
  assert.equal(lone.activeTabId, 'a');
});

test('openToSide while split fills the unfocused side, or swaps a visible tab', () => {
  // a | b, focus left; open c → c replaces b on the right and takes focus.
  const r = openToSide(split('b'), 'a', TABS, 'c');
  assert.deepEqual(resolvePanes(r.split, r.activeTabId, TABS), {
    primary: 'a',
    secondary: 'c',
    focused: 'secondary',
  });
  // Opening the visible right tab to the right just focuses it.
  const f = openToSide(split('b'), 'a', TABS, 'b', 'secondary');
  assert.deepEqual(resolvePanes(f.split, f.activeTabId, TABS), {
    primary: 'a',
    secondary: 'b',
    focused: 'secondary',
  });
  // Dropping the left tab on the right swaps the panes.
  const s = openToSide(split('b'), 'a', TABS, 'a', 'secondary');
  assert.deepEqual(resolvePanes(s.split, s.activeTabId, TABS), {
    primary: 'b',
    secondary: 'a',
    focused: 'secondary',
  });
  // Unknown tab: no-op.
  const n = openToSide(split('b'), 'a', TABS, 'zzz');
  assert.deepEqual(n, { split: split('b'), activeTabId: 'a' });
});

test('moveToOtherSide swaps a visible tab and keeps focus on it', () => {
  const r = moveToOtherSide(split('b'), 'a', TABS, 'a');
  assert.deepEqual(resolvePanes(r.split, r.activeTabId, TABS), {
    primary: 'b',
    secondary: 'a',
    focused: 'secondary',
  });
  assert.equal(r.activeTabId, 'a');
  // Moving the unfocused tab also swaps, and focuses it.
  const u = moveToOtherSide(split('b'), 'a', TABS, 'b');
  assert.deepEqual(resolvePanes(u.split, u.activeTabId, TABS), {
    primary: 'b',
    secondary: 'a',
    focused: 'primary',
  });
  // Not split: same as open to the side.
  const o = moveToOtherSide(singlePane(), 'a', TABS, 'd');
  assert.deepEqual(resolvePanes(o.split, o.activeTabId, TABS), {
    primary: 'a',
    secondary: 'd',
    focused: 'secondary',
  });
});

test('selectTab shows a hidden tab in the focused pane, or focuses the other pane', () => {
  const r = selectTab(split('b'), 'a', TABS, 'c');
  assert.deepEqual(resolvePanes(r.split, r.activeTabId, TABS), {
    primary: 'c',
    secondary: 'b',
    focused: 'primary',
  });
  const f = selectTab(split('b'), 'a', TABS, 'b');
  assert.deepEqual(resolvePanes(f.split, f.activeTabId, TABS), {
    primary: 'a',
    secondary: 'b',
    focused: 'secondary',
  });
  const single = selectTab(singlePane(), 'a', TABS, 'c');
  assert.deepEqual(single, { split: singlePane(), activeTabId: 'c' });
});

test('focusPane flips focus only while split', () => {
  const r = focusPane(split('b'), 'a', TABS, 'secondary');
  assert.equal(r.activeTabId, 'b');
  assert.deepEqual(r.split, split('a', 'secondary'));
  const same = focusPane(split('b'), 'a', TABS, 'primary');
  assert.equal(same.activeTabId, 'a');
  const single = focusPane(singlePane(), 'a', TABS, 'secondary');
  assert.equal(single.activeTabId, 'a');
});

test('closeSplit keeps the focused tab and the ratio', () => {
  const r = closeSplit(split('a', 'secondary', 0.3), 'b');
  assert.deepEqual(r, { split: singlePane(0.3), activeTabId: 'b' });
});

test('closing the focused tab of a split focuses the other pane', () => {
  assert.equal(activeAfterRemoval(split('b'), 'a', TABS, 'a', 'b'), 'b');
  assert.equal(activeAfterRemoval(split('b'), 'a', TABS, 'a', 'c'), 'b', 'other pane beats the neighbour');
  assert.equal(activeAfterRemoval(split('a', 'secondary'), 'b', TABS, 'b', 'c'), 'a');
  // Closing the unfocused tab or a hidden tab keeps the active one.
  assert.equal(activeAfterRemoval(split('b'), 'a', TABS, 'b', 'c'), 'a');
  assert.equal(activeAfterRemoval(split('b'), 'a', TABS, 'd', 'c'), 'a');
  // Not split: the host's neighbour.
  assert.equal(activeAfterRemoval(singlePane(), 'a', TABS, 'a', 'b'), 'b');
});

test('followActive collapses when the other tab goes, and swaps focus onto it', () => {
  // The other tab was removed → single pane (remaining tab keeps focus).
  assert.deepEqual(followActive(split('b'), 'a', 'a', ['a', 'c']), singlePane());
  // The focused tab was removed and its replacement is the other pane's tab.
  assert.deepEqual(followActive(split('b'), 'a', 'b', ['b', 'c']), singlePane());
  // An integration activated the other pane's tab: focus moves there.
  assert.deepEqual(followActive(split('b'), 'a', 'b', TABS), split('a', 'secondary'));
  // Another hidden tab activated: it lands in the focused pane, split kept.
  assert.deepEqual(followActive(split('b'), 'a', 'c', TABS), split('b'));
  const single = singlePane();
  assert.equal(followActive(single, 'a', 'b', TABS), single, 'identity when single');
});

test('toPersisted / restoreSplit round-trip', () => {
  const p = toPersisted(split('a', 'secondary', 0.4), 'b', TABS);
  assert.deepEqual(p, { secondaryTabId: 'b', primaryTabId: 'a', ratio: 0.4, focused: 'secondary' });
  const r = restoreSplit(p, 'c', TABS);
  assert.notEqual(r, 'wait');
  if (r === 'wait') return;
  assert.deepEqual(resolvePanes(r.split, r.activeTabId, TABS), {
    primary: 'a',
    secondary: 'b',
    focused: 'secondary',
  });
  assert.deepEqual(toPersisted(singlePane(0.7), 'a', TABS), {
    secondaryTabId: null,
    primaryTabId: null,
    ratio: 0.7,
    focused: 'primary',
  });
});

test('restoreSplit waits for tabs that have not restored yet', () => {
  const saved = { secondaryTabId: 'browser:x', primaryTabId: 't1', ratio: 0.5, focused: 'primary' as const };
  assert.equal(restoreSplit(saved, 't1', ['t1']), 'wait', 'secondary not back yet');
  assert.equal(restoreSplit(saved, null, ['browser:x']), 'wait', 'primary not back yet');
  const r = restoreSplit(saved, 't1', ['t1', 'browser:x']);
  assert.notEqual(r, 'wait');
  // No saved primary: the active tab is used.
  const legacy = restoreSplit({ secondaryTabId: 'b', ratio: 0.5, focused: 'primary' }, 'a', TABS);
  assert.notEqual(legacy, 'wait');
  if (legacy !== 'wait') assert.equal(legacy.activeTabId, 'a');
  // Nothing saved: ratio only.
  const none = restoreSplit({ secondaryTabId: null, ratio: 0.3, focused: 'primary' }, 'a', TABS);
  assert.deepEqual(none, { split: singlePane(0.3), activeTabId: 'a' });
});

test('parseSplitViews drops malformed entries and clamps', () => {
  assert.deepEqual(parseSplitViews(null), {});
  assert.deepEqual(parseSplitViews([]), {});
  assert.deepEqual(
    parseSplitViews({
      '/a': { secondaryTabId: 'b', primaryTabId: 'a', ratio: 0.99, focused: 'secondary' },
      '/b': { secondaryTabId: 7, ratio: 'x', focused: 'up' },
      '/c': 'junk',
    }),
    {
      '/a': { secondaryTabId: 'b', primaryTabId: 'a', ratio: 0.8, focused: 'secondary' },
      '/b': { secondaryTabId: null, primaryTabId: null, ratio: 0.5, focused: 'primary' },
    },
  );
});
