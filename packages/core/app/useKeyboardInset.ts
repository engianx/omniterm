'use client';

import { useLayoutEffect, useState } from 'react';

/**
 * Pure soft-keyboard inset from a layout-viewport height and a visualViewport
 * snapshot (or null when unsupported). Exported for unit tests.
 *
 * The gap between the layout viewport (`innerHeight`) and the visible region
 * (`vv.height`, shifted down by `vv.offsetTop` when iOS pans the page to reveal a
 * focused input) IS the keyboard. `offsetTop` is subtracted so a browser that
 * resizes the layout viewport AND pans (Chrome iOS on a parent-document focus:
 * innerHeight already shrank, offsetTop grew) yields 0 — no double-count — while a
 * browser that only shrinks the visual viewport (Chrome iOS on an iframe focus:
 * innerHeight full, offsetTop 0) yields the true keyboard height. Clamped at 0.
 */
export function computeKeyboardInset(
  innerHeight: number,
  vv: { height: number; offsetTop: number } | null,
): number {
  if (!vv) return 0;
  return Math.max(0, innerHeight - vv.height - vv.offsetTop);
}

/** Read the current soft-keyboard inset from `visualViewport` (0 if unsupported). */
function readKeyboardInset(): number {
  if (typeof window === 'undefined' || !window.visualViewport) return 0;
  return computeKeyboardInset(window.innerHeight, window.visualViewport);
}

/**
 * Height (px) the soft keyboard currently covers at the bottom of the layout
 * viewport. 0 when no keyboard is open or `visualViewport` is unsupported.
 *
 * iOS Safari *and* Chrome do NOT resize the layout viewport (`100dvh`,
 * `window.innerHeight`) when the soft keyboard opens — only the *visual*
 * viewport shrinks. So a full-height terminal keeps its bottom rows (the active
 * prompt) hidden behind the keyboard, and the user types blind. Callers use this
 * inset to shrink the terminal — and dock the mobile input bar — into the
 * visible region above the keyboard. Single source of truth so the terminal's
 * bottom edge and the input bar can't drift apart.
 *
 * `useLayoutEffect` (not `useEffect`) so the inset is applied before paint — no
 * one-frame flash of full-height content when the keyboard opens.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(readKeyboardInset);

  useLayoutEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = () => setInset(readKeyboardInset());
    // Re-seed on mount: the useState initializer's snapshot can already be stale
    // by the time this effect commits (the keyboard may have begun animating), so
    // read once more here rather than trusting the render-time value.
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return inset;
}
