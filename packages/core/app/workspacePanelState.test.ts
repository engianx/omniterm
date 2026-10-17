import { test } from 'node:test';
import assert from 'node:assert';
import {
  MAX_TAB_ORDER_LENGTH,
  mergeTabOrder,
  neighbourAfterRemoval,
  parseTabOrders,
  placeBySavedOrder,
} from './workspacePanelState';

const t = (id: string) => ({ id });
const ids = (tabs: { id: string }[]) => tabs.map((x) => x.id);

test('parseTabOrders tolerates missing, legacy and malformed values', () => {
  assert.deepStrictEqual(parseTabOrders(undefined), {});
  assert.deepStrictEqual(parseTabOrders(null), {});
  assert.deepStrictEqual(parseTabOrders([]), {});
  // A legacy workspacePanelState-shaped value must not throw.
  assert.deepStrictEqual(parseTabOrders({ '/a': { browserOpen: null, filesOpen: true } }), {});
  assert.deepStrictEqual(parseTabOrders({ '/a': ['x', 3, 'y', 'x'], '/b': [] }), {
    '/a': ['x', 'y'],
  });
});

test('mergeTabOrder keeps absent saved ids next to their saved predecessor', () => {
  // f1 not restored yet: it must stay between t1 and t2.
  assert.deepStrictEqual(mergeTabOrder(['t1', 't2'], ['t1', 'f1', 't2']), ['t1', 'f1', 't2']);
  // Absent id with no predecessor goes to the front.
  assert.deepStrictEqual(mergeTabOrder(['t1'], ['b1', 't1']), ['b1', 't1']);
  // A reorder of open tabs wins over the saved order.
  assert.deepStrictEqual(mergeTabOrder(['t2', 't1'], ['t1', 't2']), ['t2', 't1']);
  // Empty strip (mid workspace switch) leaves the saved order intact.
  assert.deepStrictEqual(mergeTabOrder([], ['a', 'b']), ['a', 'b']);
});

test('mergeTabOrder caps length by dropping absent ids, never open ones', () => {
  const saved = Array.from({ length: MAX_TAB_ORDER_LENGTH }, (_, i) => `old${i}`);
  const merged = mergeTabOrder(['live'], saved);
  assert.strictEqual(merged.length, MAX_TAB_ORDER_LENGTH);
  assert.ok(merged.includes('live'));
  assert.ok(!merged.includes('old0'));
});

test('placeBySavedOrder slots async arrivals into their saved position', () => {
  const saved = ['t1', 'f1', 't2', 'b1'];
  // Terminals restore first, in the order the terminal plugin chose.
  let tabs = placeBySavedOrder([], [t('t2'), t('t1')], saved);
  assert.deepStrictEqual(ids(tabs), ['t1', 't2']);
  // The file tab is appended later by its integration → lands between them.
  tabs = placeBySavedOrder(tabs, [...tabs, t('f1')], saved);
  assert.deepStrictEqual(ids(tabs), ['t1', 'f1', 't2']);
  // The browser tab arrives last and belongs at the end.
  tabs = placeBySavedOrder(tabs, [...tabs, t('b1')], saved);
  assert.deepStrictEqual(ids(tabs), ['t1', 'f1', 't2', 'b1']);
});

test('placeBySavedOrder never shuffles tabs already on the strip', () => {
  const prev = [t('t2'), t('t1')]; // user dragged t2 first
  const next = [...prev, t('x')];
  const out = placeBySavedOrder(prev, next, ['t1', 't2', 'x']);
  assert.deepStrictEqual(ids(out), ['t2', 't1', 'x']);
});

test('placeBySavedOrder leaves unknown and pinned ids where the caller put them', () => {
  const prev = [t('a'), t('b')];
  const next = [t('a'), t('new'), t('b')];
  assert.strictEqual(placeBySavedOrder(prev, next, ['a', 'b']), next);
  const pinned = [t('a'), t('p'), t('b')];
  assert.strictEqual(placeBySavedOrder(prev, pinned, ['a', 'b', 'p'], new Set(['p'])), pinned);
  // Placed before the first later-ranked tab when nothing earlier is present.
  const out = placeBySavedOrder([t('b')], [t('b'), t('a')], ['a', 'b']);
  assert.deepStrictEqual(ids(out), ['a', 'b']);
});

test('neighbourAfterRemoval prefers the right neighbour, then the left', () => {
  const tabs = [t('a'), t('b'), t('c')];
  assert.strictEqual(neighbourAfterRemoval(tabs, 'b'), 'c');
  assert.strictEqual(neighbourAfterRemoval(tabs, 'c'), 'b');
  assert.strictEqual(neighbourAfterRemoval([t('a')], 'a'), null);
  assert.strictEqual(neighbourAfterRemoval(tabs, 'zzz'), null);
});
