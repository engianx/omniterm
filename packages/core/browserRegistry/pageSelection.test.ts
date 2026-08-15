import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceSelection,
  emptySelectionState,
  nextSelection,
  pickTargetAfterClose,
  promoteMru,
  type SelectionState,
} from './pageSelection.js';

// --- promoteMru ---------------------------------------------------------

test('promoteMru moves the active page to the front', () => {
  assert.deepEqual(promoteMru(['C', 'B', 'A'], 'A', ['A', 'B', 'C']), ['A', 'C', 'B']);
});

test('promoteMru does not duplicate a page already at the front', () => {
  assert.deepEqual(promoteMru(['A', 'B'], 'A', ['A', 'B']), ['A', 'B']);
});

test('promoteMru drops ids that are no longer live, keeping the stack bounded', () => {
  assert.deepEqual(promoteMru(['C', 'B', 'A'], 'B', ['A', 'B']), ['B', 'A']);
});

test('promoteMru seeds an empty stack', () => {
  assert.deepEqual(promoteMru([], 'A', ['A']), ['A']);
});

// --- pickTargetAfterClose: recency is the primary rule ------------------

// The reported case: A, B, C are opened, then the user visits A and then C,
// so the stack is [C, A, B]. Closing C should go back to A — where the user
// actually was — not to B, which merely sits next to it in the strip.
test('closing the active page returns to the most recently used survivor', () => {
  assert.equal(pickTargetAfterClose(['C', 'A', 'B'], ['A', 'B', 'C'], ['A', 'B'], 'C'), 'A');
});

// Opening A, B, C without ever switching leaves the stack in reverse creation
// order, because each new page is auto-selected as it appears. Recency then
// agrees with the neighbour rule, which is why this case still lands on B.
test('with no manual switching, recency still yields the neighbour', () => {
  assert.equal(pickTargetAfterClose(['C', 'B', 'A'], ['A', 'B', 'C'], ['A', 'B'], 'C'), 'B');
});

test('a stale closed id at the head of the stack is skipped', () => {
  assert.equal(pickTargetAfterClose(['C', 'B'], ['A', 'B', 'C'], ['A', 'B'], 'C'), 'B');
});

test('ids in the stack that are no longer live are skipped', () => {
  // D was used most recently but is gone too (e.g. a window closed).
  assert.equal(pickTargetAfterClose(['C', 'D', 'A'], ['A', 'C', 'D'], ['A'], 'C'), 'A');
});

test('closing a page that is not the active one still resolves by recency', () => {
  assert.equal(pickTargetAfterClose(['B', 'A'], ['A', 'B', 'C'], ['A', 'C'], 'B'), 'A');
});

// --- pickTargetAfterClose: positional fallback --------------------------

// Every survivor was opened but never activated, so recency has no opinion.
test('with an empty stack, closing the last page falls to its left neighbour', () => {
  assert.equal(pickTargetAfterClose([], ['A', 'B', 'C'], ['A', 'B'], 'C'), 'B');
});

test('with an empty stack, closing a middle page takes over the slot', () => {
  assert.equal(pickTargetAfterClose([], ['A', 'B', 'C'], ['A', 'C'], 'B'), 'C');
});

test('with an empty stack, an unknown closed page falls back to the head', () => {
  assert.equal(pickTargetAfterClose([], ['X', 'Y'], ['A', 'B'], 'C'), 'A');
});

test('a stale index past the new end clamps to the last page', () => {
  assert.equal(pickTargetAfterClose([], ['A', 'B', 'C', 'D'], ['A'], 'D'), 'A');
});

// --- boundaries ---------------------------------------------------------

test('closing the only page selects nothing', () => {
  assert.equal(pickTargetAfterClose(['A'], ['A'], [], 'A'), null);
});

test('two pages: closing either leaves the survivor selected', () => {
  assert.equal(pickTargetAfterClose(['A', 'B'], ['A', 'B'], ['B'], 'A'), 'B');
  assert.equal(pickTargetAfterClose(['B', 'A'], ['A', 'B'], ['A'], 'B'), 'A');
});

// --- nextSelection: the branch cascade -----------------------------------

const base = {
  justSwitchedBrowser: false,
  prevIds: [] as string[],
  pageIds: [] as string[],
  selectedTargetId: null as string | null,
  mru: [] as string[],
};

// The reported bug. Switching to a browser that already holds pages must land
// on its FIRST page. It used to land on the last: the switch left an empty
// `pageIds` recorded as that browser's order, so when the real snapshot
// arrived `pageIds.length > prevIds.length` was N > 0 and the "new page
// appeared" case fired for what was only the first load. The caller now
// withholds the empty render entirely, so the first call for a switched-to
// browser carries its real pages with justSwitchedBrowser still true.
test('switching to a populated browser selects its first page, not its last', () => {
  assert.deepEqual(
    nextSelection({
      ...base,
      justSwitchedBrowser: true,
      prevIds: ['q1', 'q2', 'q3'],
      pageIds: ['q1', 'q2', 'q3'],
      selectedTargetId: null,
    }),
    { kind: 'select', targetId: 'q1' },
  );
});

// Same shape, but with no remembered order — a browser being visited for the
// first time. Still its first page: this is what made the old bug survive a
// naive fix that only protected browsers with a remembered order.
test('first visit to a populated browser also selects its first page', () => {
  assert.deepEqual(
    nextSelection({
      ...base,
      justSwitchedBrowser: true,
      prevIds: [],
      pageIds: ['q1', 'q2', 'q3'],
      selectedTargetId: null,
    }),
    { kind: 'select', targetId: 'q1' },
  );
});

test('a page opened while watching wins over the first-page case', () => {
  assert.deepEqual(
    nextSelection({
      ...base,
      prevIds: ['A', 'B'],
      pageIds: ['A', 'B', 'C'],
      selectedTargetId: null,
    }),
    { kind: 'select', targetId: 'C' },
  );
});

test('a page opened while watching is selected even with one already active', () => {
  assert.deepEqual(
    nextSelection({
      ...base,
      prevIds: ['A'],
      pageIds: ['A', 'B'],
      selectedTargetId: 'A',
    }),
    { kind: 'select', targetId: 'B' },
  );
});

// Growth must NOT be read as "a page appeared" on the pass that follows a
// switch, or the first-page case becomes unreachable again.
test('growth on the switch pass does not preempt the first-page case', () => {
  assert.deepEqual(
    nextSelection({
      ...base,
      justSwitchedBrowser: true,
      prevIds: [],
      pageIds: ['q1', 'q2'],
      selectedTargetId: null,
    }),
    { kind: 'select', targetId: 'q1' },
  );
});

test('the active page closing defers to recency', () => {
  assert.deepEqual(
    nextSelection({
      ...base,
      prevIds: ['A', 'B', 'C'],
      pageIds: ['A', 'B'],
      selectedTargetId: 'C',
      mru: ['C', 'A', 'B'],
    }),
    { kind: 'select', targetId: 'A' },
  );
});

test('closing the last remaining page selects nothing', () => {
  assert.deepEqual(
    nextSelection({ ...base, prevIds: ['A'], pageIds: [], selectedTargetId: 'A', mru: ['A'] }),
    { kind: 'select', targetId: null },
  );
});

test('a still-valid selection is recorded into the MRU stack', () => {
  assert.deepEqual(
    nextSelection({ ...base, prevIds: ['A', 'B'], pageIds: ['A', 'B'], selectedTargetId: 'B' }),
    { kind: 'record' },
  );
});

test('a browser with no pages and no selection is idle', () => {
  assert.deepEqual(nextSelection({ ...base, justSwitchedBrowser: true }), { kind: 'idle' });
});

test('closing a background page leaves the active one alone', () => {
  assert.deepEqual(
    nextSelection({
      ...base,
      prevIds: ['A', 'B', 'C'],
      pageIds: ['A', 'C'],
      selectedTargetId: 'C',
      mru: ['C', 'A'],
    }),
    { kind: 'record' },
  );
});

// --- advanceSelection: the switch sequence -------------------------------

/**
 * Drive advanceSelection the way the component does: feed observations in
 * order, carrying state forward, and track the selection each one produces.
 * This is the level both known bugs lived at — each individual frame looked
 * fine, and only the sequence was wrong.
 */
function drive(
  observations: Array<{
    browserId: string;
    pageIds: string[];
    targetsBrowserId: string | null;
    targetsLoaded: boolean;
    liveBrowserIds?: string[];
    /** Set to simulate the user clicking a chip before this observation. */
    clickTo?: string;
  }>,
  start: { state?: SelectionState; selectedTargetId?: string | null } = {},
) {
  let state = start.state ?? emptySelectionState;
  let selectedTargetId = start.selectedTargetId ?? null;
  for (const o of observations) {
    if (o.clickTo !== undefined) selectedTargetId = o.clickTo;
    const res = advanceSelection(state, {
      browserId: o.browserId,
      pageIds: o.pageIds,
      selectedTargetId,
      targetsBrowserId: o.targetsBrowserId,
      targetsLoaded: o.targetsLoaded,
      liveBrowserIds: o.liveBrowserIds ?? ['B1', 'B2'],
    });
    state = res.state;
    if (res.outcome.kind === 'select') selectedTargetId = res.outcome.targetId;
  }
  return { state, selectedTargetId };
}

/**
 * The exact sequence a browser switch produces. The discovery hook resets on
 * its own schedule, so the switch is observed in three steps before the real
 * page list arrives — and the two intermediate ones must not be recorded.
 */
function switchTo(browserId: string, pageIds: string[], previous: string | null) {
  return [
    // 1. Selection changed; the page list still describes the old browser.
    { browserId, pageIds: [], targetsBrowserId: previous, targetsLoaded: true },
    // 2. The hook has reset, but no snapshot has arrived for the new browser.
    { browserId, pageIds: [], targetsBrowserId: browserId, targetsLoaded: false },
    // 3. Target.getTargets answers.
    { browserId, pageIds, targetsBrowserId: browserId, targetsLoaded: true },
  ];
}

test('switching to a browser lands on its first page, not its last', () => {
  const { selectedTargetId } = drive([
    ...switchTo('B1', ['p1', 'p2'], null),
    { browserId: 'B1', pageIds: ['p1', 'p2'], targetsBrowserId: 'B1', targetsLoaded: true },
    ...switchTo('B2', ['q1', 'q2', 'q3'], 'B1'),
  ]);
  assert.equal(selectedTargetId, 'q1');
});

test('the transient empty page list never becomes a browser\'s recorded order', () => {
  const { state } = drive([...switchTo('B1', ['p1', 'p2', 'p3'], null)]);
  assert.deepEqual(state.browsers.B1?.prevIds, ['p1', 'p2', 'p3']);
});

test('switching away and back preserves the MRU stack', () => {
  // On B1 visit p1 then p3, so B1's stack is [p3, p1, p2]. Leave and return.
  const onB1 = {
    browserId: 'B1',
    pageIds: ['p1', 'p2', 'p3'],
    targetsBrowserId: 'B1',
    targetsLoaded: true,
  };
  const first = drive([
    ...switchTo('B1', ['p1', 'p2', 'p3'], null),
    { ...onB1, clickTo: 'p1' },
    { ...onB1, clickTo: 'p3' },
    onB1,
  ]);
  assert.deepEqual(first.state.browsers.B1?.mru, ['p3', 'p1']);

  const round = drive(
    [...switchTo('B2', ['q1'], 'B1'), ...switchTo('B1', ['p1', 'p2', 'p3'], 'B2')],
    { state: first.state, selectedTargetId: first.selectedTargetId },
  );
  // B1's recency survived the round trip: closing p3 still returns to p1.
  assert.deepEqual(round.state.browsers.B1?.mru, ['p3', 'p1']);
});

test('a page opened after the snapshot is still auto-selected', () => {
  const { selectedTargetId } = drive([
    ...switchTo('B1', ['p1', 'p2'], null),
    { browserId: 'B1', pageIds: ['p1', 'p2', 'p3'], targetsBrowserId: 'B1', targetsLoaded: true },
  ]);
  assert.equal(selectedTargetId, 'p3');
});

test('bookkeeping for a browser that goes away is dropped', () => {
  const { state } = drive([
    ...switchTo('B1', ['p1'], null),
    {
      browserId: 'B1',
      pageIds: ['p1'],
      targetsBrowserId: 'B1',
      targetsLoaded: true,
      liveBrowserIds: ['B1'],
    },
  ]);
  assert.ok(state.browsers.B1);
  const after = advanceSelection(state, {
    browserId: 'B2',
    pageIds: [],
    selectedTargetId: null,
    targetsBrowserId: 'B2',
    targetsLoaded: true,
    liveBrowserIds: ['B2'],
  });
  assert.equal(after.state.browsers.B1, undefined);
});
