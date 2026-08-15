import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTargetAfterClose, promoteMru } from './pageSelection.js';

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
