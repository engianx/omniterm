import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keepFocusIf } from './MobileInputChrome.js';

/** Minimal stand-in for the React pointer/mouse event the guard receives. */
function fakeEvent() {
  let prevented = 0;
  return {
    event: { preventDefault: () => void prevented++ } as never,
    get preventedCount() {
      return prevented;
    },
  };
}

// keepFocusIf is the single focus-suppression primitive: bar keys call
// keepFocusIf(true) (always keep focus so the soft keyboard never drops), while
// the »/« toggle calls keepFocusIf(kbInset > 0) (keep focus only when a keyboard
// is up, else allow the plain tap). These cases lock that truth table.
describe('keepFocusIf', () => {
  it('suppresses focus theft (preventDefault) when active', () => {
    const probe = fakeEvent();
    keepFocusIf(true)(probe.event);
    assert.equal(probe.preventedCount, 1);
  });

  it('does NOT preventDefault when inactive (lets the tap through)', () => {
    const probe = fakeEvent();
    keepFocusIf(false)(probe.event);
    assert.equal(probe.preventedCount, 0);
  });

  it('returns a fresh handler per call (no shared mutable state)', () => {
    const a = keepFocusIf(true);
    const b = keepFocusIf(false);
    assert.notEqual(a, b);
    const pa = fakeEvent();
    const pb = fakeEvent();
    a(pa.event);
    b(pb.event);
    assert.equal(pa.preventedCount, 1);
    assert.equal(pb.preventedCount, 0);
  });
});
