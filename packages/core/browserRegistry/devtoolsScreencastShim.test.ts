// Regression tests for the DevTools screencast shim, covering the two ways the
// screencast fails to fill OmniTerm's browser pane. Both fakes mirror the stock
// control flow in Chrome's panels/screencast/ScreencastView.js and
// core/sdk/ScreenCaptureModel.js.
//
// FakeScreencastView — the restart race. stopCasting() bails out early while
// startCasting() is still awaiting its CDP round trip, and on that path leaves
// `isCasting` true. The restart onResize() defers by 100ms then hits
// `if (this.isCasting) return` and is dropped, so the screencast stays locked
// to the previous dimensions until a later resize lands outside the window.
//
// FakeFrameView — the geometry. Stock sizes the viewport to the page plus
// BORDERS_SIZE and repaints before returning, so stripping the border in CSS
// and correcting the size afterwards is too late: the canvas has already been
// measured and drawn at the oversized box.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long the CDP `Page.stopScreencast` round trip takes in this model. */
const STOP_ROUND_TRIP_MS = 200;

class FakeScreencastView {
  isCasting = false;
  screencastOperationId: number | undefined;
  deferredCasting: ReturnType<typeof setTimeout> | undefined;

  /** Width the currently live screencast was started with. */
  castingWidth = 0;
  /** Current available width, as `viewportDimensions()` would report it. */
  elementWidth = 400;

  #nextOperationId = 1;
  #hasLiveOperation = false;

  viewportDimensions() {
    return { width: this.elementWidth, height: 300 };
  }

  async startCasting() {
    if (this.isCasting) return;
    this.isCasting = true;
    const dimensions = this.viewportDimensions();
    if (dimensions.width < 0 || dimensions.height < 0) {
      this.isCasting = false;
      return;
    }
    // ScreenCaptureModel.startScreencast() awaits invoke_stopScreencast()
    // whenever an earlier operation is still registered. That await is the
    // window in which screencastOperationId is unset but isCasting is true.
    if (this.#hasLiveOperation) await sleep(STOP_ROUND_TRIP_MS);
    this.#hasLiveOperation = true;
    this.castingWidth = dimensions.width;
    this.screencastOperationId = this.#nextOperationId++;
  }

  stopCasting() {
    if (!this.screencastOperationId) return;
    this.screencastOperationId = undefined;
    this.isCasting = false;
  }

  onResize() {
    if (this.deferredCasting) clearTimeout(this.deferredCasting);
    this.deferredCasting = undefined;
    this.stopCasting();
    this.deferredCasting = setTimeout(() => void this.startCasting(), 100);
  }
}

/**
 * Chrome's private allowance for the 20px padding, the 1px viewport border and
 * the 1px canvas-container border it draws around the page. `BORDERS_SIZE` in
 * panels/screencast/ScreencastView.js; 44 as of Chrome 151.
 */
const BORDERS_SIZE = 44;
const NAVBAR_HEIGHT = 29;

class FakeElement {
  style: Record<string, string> = {};
  clientWidth = 900;
  clientHeight = 600;
  querySelector() {
    return { offsetHeight: NAVBAR_HEIGHT };
  }
}

/**
 * Models the geometry half of stock ScreencastView: onload sizes the viewport
 * to the page plus BORDERS_SIZE, then repaint() measures the canvas — which is
 * `flex: auto` inside the viewport, so it takes whatever that box is.
 */
class FakeFrameView {
  element = new FakeElement();
  viewportElement = new FakeElement();
  imageElement: { onload: ((event: unknown) => void) | null; src: string } = {
    onload: null,
    src: '',
  };
  isCasting = false;
  screencastOperationId: number | undefined = 1;

  /**
   * Stock computes the zoom inside its own onload; the shim has to read it back
   * off the instance. Flip `exposeScreenZoom` to model the field being renamed
   * or made private in a future Chrome — stock keeps working, the shim's read
   * goes undefined.
   */
  exposeScreenZoom = true;
  #zoom = 1;
  get screenZoom(): number | undefined {
    return this.exposeScreenZoom ? this.#zoom : undefined;
  }

  /** Viewport box each repaint() measured, in call order. */
  repaints: Array<Record<string, string>> = [];

  repaint() {
    this.repaints.push({ ...this.viewportElement.style });
  }

  onResize() {}

  viewportDimensions() {
    return {
      width: this.element.clientWidth - BORDERS_SIZE - 30,
      height: this.element.clientHeight - BORDERS_SIZE - 30 - NAVBAR_HEIGHT,
    };
  }

  screencastFrame(_base64Data: string, metadata: { deviceWidth: number; deviceHeight: number }) {
    this.imageElement.onload = () => {
      this.viewportElement.style.width = `${metadata.deviceWidth * this.#zoom + BORDERS_SIZE}px`;
      this.viewportElement.style.height = `${metadata.deviceHeight * this.#zoom + BORDERS_SIZE}px`;
      // Stock reaches repaint() through updateHighlightInOverlayAndRepaint(),
      // which takes no await on the screencast-frame path.
      this.repaint();
    };
    this.imageElement.src = 'data:image/jpg;base64,AAAA';
  }
}

interface Scheduler {
  schedule: () => void;
  setSuspended: (suspended: boolean) => void;
}

interface FrameHandle {
  state: string;
  refit: () => void;
  setSuspended: (suspended: boolean) => void;
  revert: () => void;
}

interface SplitLike {
  hideSidebar?: () => void;
  setVertical?: (vertical: boolean) => void;
  showBoth?: () => void;
}

/**
 * Load the shim in Node. It is a browser-only static asset, so stub the handful
 * of globals its module body touches. Its bootstrap fails at the dynamic import
 * of Chrome's screencast module and is swallowed by its own catch.
 */
async function loadShim(): Promise<{
  createRefitScheduler: (view: FakeScreencastView) => Scheduler;
  installCompactScreencastFrame: (view: FakeFrameView) => FrameHandle;
  applyInspectorPosition: (
    split: SplitLike,
    position: string,
  ) => { ok: boolean; reason?: string };
}> {
  const documentElement = { setAttribute() {}, removeAttribute() {} };
  const globals = globalThis as unknown as Record<string, unknown>;
  // One shared style element, so the shim's remove-then-append and its revert
  // are both observable.
  const styles = new Map<string, { id: string; remove: () => void }>();
  globals.document = {
    documentElement,
    getElementById: (id: string) => styles.get(id) ?? null,
    querySelector: () => null,
    createElement: () => {
      const el = {
        id: '',
        textContent: '',
        dataset: {},
        remove: () => styles.delete(el.id),
      };
      return el;
    },
    head: {
      appendChild: (el: { id: string; remove: () => void }) => styles.set(el.id, el),
    },
  };
  globals.__shimStyles = styles;
  globals.window = {
    location: { href: 'http://127.0.0.1:1/devtools/inspector.html' },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    dispatchEvent: () => true,
    addEventListener: () => {},
  };
  // Resolved at runtime: the shim is a browser asset with no type declarations.
  const shimUrl = new URL('../public/devtools-screencast-shim.js', import.meta.url).href;
  return await import(shimUrl);
}

/**
 * Drive the view into the vulnerable window: a restart is in flight and its
 * operation id has not landed yet, so stopCasting() is a no-op.
 */
async function enterCastingHandoff(view: FakeScreencastView): Promise<void> {
  await view.startCasting(); // first cast: no prior operation, so no round trip
  assert.equal(view.castingWidth, 400);

  view.elementWidth = 800;
  view.onResize();
  await sleep(150); // let the deferred restart start and reach its await

  assert.equal(view.isCasting, true);
  assert.equal(view.screencastOperationId, undefined, 'expected the handoff window');
}

test('stock onResize() during the casting handoff drops the new size', async () => {
  const view = new FakeScreencastView();
  await enterCastingHandoff(view);

  view.elementWidth = 1200;
  view.onResize();

  await sleep(STOP_ROUND_TRIP_MS + 400);
  assert.equal(view.castingWidth, 800, 'the 1200px resize is silently lost');
});

test('the shim scheduler refits after the casting handoff completes', async () => {
  const { createRefitScheduler } = await loadShim();
  const view = new FakeScreencastView();
  const { schedule: scheduleRefit } = createRefitScheduler(view);
  await enterCastingHandoff(view);

  view.elementWidth = 1200;
  scheduleRefit();

  await sleep(STOP_ROUND_TRIP_MS + 800);
  assert.equal(view.castingWidth, 1200);
  assert.equal(view.isCasting, true);
});

test('the shim scheduler collapses a burst of resizes into one refit', async () => {
  const { createRefitScheduler } = await loadShim();
  const view = new FakeScreencastView();
  const { schedule: scheduleRefit } = createRefitScheduler(view);
  await view.startCasting();

  for (const width of [500, 700, 900, 1100]) {
    view.elementWidth = width;
    scheduleRefit();
  }

  await sleep(STOP_ROUND_TRIP_MS + 800);
  assert.equal(view.castingWidth, 1100);
});

test('stock geometry leaves BORDERS_SIZE of dead space around the page', () => {
  const view = new FakeFrameView();
  view.screencastFrame('AAAA', { deviceWidth: 800, deviceHeight: 500 });
  view.imageElement.onload?.(null);

  // The canvas ends up 44px wider and taller than the page that was drawn into
  // its top-left: grey on the right, black along the bottom.
  assert.deepEqual(view.repaints.at(-1), { width: '844px', height: '544px' });
});

test('the shim sizes the viewport to the page and repaints at that size', async () => {
  const { installCompactScreencastFrame } = await loadShim();
  const view = new FakeFrameView();
  assert.equal(installCompactScreencastFrame(view).state, 'frame=compact');

  view.screencastFrame('AAAA', { deviceWidth: 800, deviceHeight: 500 });
  view.imageElement.onload?.(null);

  assert.deepEqual(view.viewportElement.style, { width: '800px', height: '500px' });
  assert.deepEqual(
    view.repaints.at(-1),
    { width: '800px', height: '500px' },
    'the last repaint must measure the corrected box, not the oversized one',
  );
});

test('the shim reclaims the border and gutter from the available surface', async () => {
  const { installCompactScreencastFrame } = await loadShim();
  const view = new FakeFrameView();
  assert.deepEqual(view.viewportDimensions(), { width: 826, height: 497 });

  installCompactScreencastFrame(view);

  // Full content box below the navigation bar: no BORDERS_SIZE, no gutter.
  assert.deepEqual(view.viewportDimensions(), { width: 900, height: 571 });
});

test('an unreadable screenZoom reverts every override, not just the resize', async () => {
  const { installCompactScreencastFrame } = await loadShim();
  const styles = (globalThis as unknown as { __shimStyles: Map<string, unknown> }).__shimStyles;
  const view = new FakeFrameView();
  installCompactScreencastFrame(view);
  assert.ok(
    styles.has('omniterm-devtools-compact-screencast-frame'),
    'the compact-frame CSS is installed up front',
  );
  view.exposeScreenZoom = false;

  view.screencastFrame('AAAA', { deviceWidth: 800, deviceHeight: 500 });
  view.imageElement.onload?.(null);

  // Skipping only the resize would leave the CSS stripping the 44px border
  // that stock is still reserving room for — grey right, black bottom, which
  // is the bug this shim exists to fix. Everything has to come back together.
  assert.equal(
    styles.has('omniterm-devtools-compact-screencast-frame'),
    false,
    'the compact-frame CSS is removed',
  );
  assert.deepEqual(
    view.viewportDimensions(),
    { width: 826, height: 497 },
    'viewportDimensions reserves the border and gutter again',
  );
  assert.deepEqual(view.viewportElement.style, { width: '844px', height: '544px' });
  assert.equal(view.repaints.length, 1, 'no pointless extra repaint per frame');
});

test('the onload wrapper does not chain when stock stops reassigning it', async () => {
  const { installCompactScreencastFrame } = await loadShim();
  const view = new FakeFrameView();
  installCompactScreencastFrame(view);

  // Models a Chrome that assigns imageElement.onload once instead of per frame:
  // whatever the shim installed is still there when the next frame arrives.
  const stockAssign = view.screencastFrame.bind(view);
  let assigned = false;
  view.screencastFrame = (data: string, metadata: { deviceWidth: number; deviceHeight: number }) => {
    if (assigned) return;
    assigned = true;
    stockAssign(data, metadata);
  };

  for (let i = 0; i < 50; i++) {
    view.screencastFrame('AAAA', { deviceWidth: 800, deviceHeight: 500 });
  }
  view.repaints.length = 0;
  view.imageElement.onload?.(null);

  // One wrapper, so one stock handler call and one corrective repaint — not 50
  // nested closures walked per decoded frame.
  assert.equal(view.repaints.length, 2, 'stock repaint plus exactly one corrective repaint');
  assert.deepEqual(view.viewportElement.style, { width: '800px', height: '500px' });
});

test('a suspended scheduler holds refits until it resumes', async () => {
  const { createRefitScheduler } = await loadShim();
  const view = new FakeScreencastView();
  const scheduler = createRefitScheduler(view);
  await view.startCasting();

  scheduler.setSuspended(true);
  for (const width of [500, 700, 900]) {
    view.elementWidth = width;
    scheduler.schedule();
  }
  await sleep(600);
  assert.equal(view.castingWidth, 400, 'no restart while the drag is in progress');

  scheduler.setSuspended(false);
  await sleep(STOP_ROUND_TRIP_MS + 800);
  assert.equal(view.castingWidth, 900, 'exactly one refit, at the final size');
});

test('applyInspectorPosition maps right and bottom onto SplitWidget', async () => {
  const { applyInspectorPosition } = await loadShim();
  const calls: string[] = [];
  const split: SplitLike = {
    hideSidebar: () => calls.push('hideSidebar'),
    // SplitWidget's naming is inverted, so this assertion is the guard against
    // flipping the boolean: vertical(true) lays children out left-to-right,
    // which puts the sidebar — InspectorView — on the right.
    setVertical: (vertical: boolean) => calls.push(`setVertical:${vertical}`),
    showBoth: () => calls.push('showBoth'),
  };

  assert.deepEqual(applyInspectorPosition(split, 'right'), { ok: true });
  assert.deepEqual(calls, ['setVertical:true', 'showBoth']);

  calls.length = 0;
  assert.deepEqual(applyInspectorPosition(split, 'bottom'), { ok: true });
  assert.deepEqual(calls, ['setVertical:false', 'showBoth']);

  calls.length = 0;
  assert.deepEqual(applyInspectorPosition(split, 'hidden'), { ok: true });
  assert.deepEqual(calls, ['hideSidebar']);
});

test('applyInspectorPosition reports rather than throws on a changed SplitWidget', async () => {
  const { applyInspectorPosition } = await loadShim();

  assert.equal(applyInspectorPosition({}, 'hidden').ok, false);
  assert.equal(applyInspectorPosition({}, 'right').ok, false);
  assert.equal(applyInspectorPosition({ hideSidebar: () => {} }, 'sideways').ok, false);
});
