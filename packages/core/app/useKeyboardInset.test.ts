import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeKeyboardInset } from './useKeyboardInset.js';

// The inset formula is the heart of the mobile keyboard-clearance fix. These
// cases pin the exact reference-frame reasoning (incl. the offsetTop subtraction
// and the 0-clamp) using numbers measured on a real Chrome-iOS device, so a
// future "simplification" of the formula can't silently regress it.
describe('computeKeyboardInset', () => {
  it('returns 0 when visualViewport is unsupported (null)', () => {
    assert.equal(computeKeyboardInset(800, null), 0);
  });

  it('returns 0 when no keyboard is up (visual viewport fills the layout viewport)', () => {
    assert.equal(computeKeyboardInset(800, { height: 800, offsetTop: 0 }), 0);
  });

  it('returns the keyboard height for an iframe focus on Chrome iOS (layout viewport NOT resized)', () => {
    // Measured: terminal (iframe) focus — innerHeight stays full, only the
    // visual viewport shrinks, no pan. Inset must equal the keyboard height.
    assert.equal(computeKeyboardInset(765, { height: 507, offsetTop: 0 }), 258);
  });

  it('returns 0 for a parent-document focus on Chrome iOS (layout viewport resized AND panned)', () => {
    // Measured: compose-box focus — innerHeight already shrank to the visible
    // height and the page panned by the keyboard height. Subtracting offsetTop
    // avoids double-counting: the layout already made room, so inset is 0.
    assert.equal(computeKeyboardInset(507, { height: 507, offsetTop: 258 }), 0);
  });

  it('handles a partial pan (positive remainder after offsetTop)', () => {
    assert.equal(computeKeyboardInset(800, { height: 500, offsetTop: 100 }), 200);
  });

  it('clamps to 0 rather than returning a negative inset', () => {
    assert.equal(computeKeyboardInset(500, { height: 500, offsetTop: 50 }), 0);
  });
});
