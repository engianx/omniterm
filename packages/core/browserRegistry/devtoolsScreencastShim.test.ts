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

interface ClipboardHandle {
  state: string;
  revert: () => void;
}

/**
 * Enough of ScreencastView for the clipboard bridge: the canvas that owns
 * focus, the InputModel whose agent carries text into the page, and the target
 * whose runtime agent reads the page's selection back out.
 */
class FakeClipboardView {
  canvasElement = { id: 'screencast-canvas' };
  /** Text handed to the remote page by Input.insertText. */
  inserted: string[] = [];
  /** Raw Input.dispatchKeyEvent calls — the cut's delete half lands here. */
  dispatched: Array<Record<string, unknown>> = [];
  /** What the remote page's selection currently reads back as. */
  remoteSelection = '';
  /** Selections sitting in cross-origin frames, each one its own CDP target. */
  frameSelections: string[] = [];
  /** Reads of the page itself, and of those separate frame targets. */
  reads = 0;
  frameReads = 0;
  /** While set, reads park unresolved so a test can interleave with one. */
  holdReads = false;
  parked: Array<() => void> = [];

  target = {
    runtimeAgent: () => ({ invoke_evaluate: () => this.read() }),
    targetManager: () => ({ targets: () => [this.target, ...this.frameTargets()] }),
    type: () => 'frame',
  };

  inputModel: Record<string, unknown> = {
    inputAgent: {
      invoke_insertText: ({ text }: { text: string }) => {
        this.inserted.push(text);
        return Promise.resolve({});
      },
      invoke_dispatchKeyEvent: (params: Record<string, unknown>) => {
        this.dispatched.push(params);
        return Promise.resolve({});
      },
    },
    target: () => this.target,
  };

  read() {
    this.reads++;
    // Captured at call time: a parked read answers with the selection as it
    // was when it started, which is the whole point of the epoch guard.
    const value = this.remoteSelection;
    if (!this.holdReads) return Promise.resolve({ result: { value } });
    return new Promise((resolve) => {
      this.parked.push(() => resolve({ result: { value } }));
    });
  }

  frameTargets() {
    return this.frameSelections.map((value) => ({
      type: () => 'frame',
      runtimeAgent: () => ({
        invoke_evaluate: () => {
          this.frameReads++;
          return Promise.resolve({ result: { value } });
        },
      }),
    }));
  }

  releaseReads() {
    const parked = this.parked;
    this.parked = [];
    for (const resolve of parked) resolve();
  }

  get inputAgent(): Record<string, unknown> {
    return this.inputModel.inputAgent as Record<string, unknown>;
  }
}

/** A KeyboardEvent/ClipboardEvent shaped like the ones the shim inspects. */
function fakeEvent<T extends Record<string, unknown>>(props: T) {
  const record = { stopPropagation: 0, preventDefault: 0 };
  return {
    ...props,
    record,
    stopPropagation: () => {
      record.stopPropagation++;
    },
    preventDefault: () => {
      record.preventDefault++;
    },
  };
}

/** The DataTransfer a clipboard event carries, recording what is written. */
function fakeClipboardData(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getData: (type: string) => data[type] ?? '',
    setData: (type: string, value: string) => {
      data[type] = value;
    },
  };
}

function deliver(type: string, event: unknown) {
  const listeners =
    (globalThis as unknown as { __shimListeners: Map<string, Array<(e: unknown) => void>> })
      .__shimListeners.get(type) ?? [];
  for (const listener of listeners) listener(event);
}

function setActiveElement(element: unknown) {
  (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement =
    element;
}

function setFrontendSelection(text: string) {
  (globalThis as unknown as { __frontendSelection: string }).__frontendSelection = text;
}

function setPlatform(platform: string) {
  (globalThis as unknown as { navigator: { platform: string } }).navigator.platform = platform;
}

/**
 * Hand the mirror a selection and let the read settle. The bridge refreshes on
 * every event that could have changed the selection, because `copy` has to be
 * answered synchronously and cannot wait for a round trip of its own.
 */
async function mirrorSelection(view: FakeClipboardView, text: string) {
  view.remoteSelection = text;
  deliver('mouseup', fakeEvent({}));
  await sleep(0);
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
  installScreencastClipboard: (view: FakeClipboardView) => ClipboardHandle;
  classifyClipboardChord: (event: Record<string, unknown>) => string | null;
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
    // Which element holds the frontend's focus. The clipboard bridge only
    // acts on events the screencast canvas owns, so tests move this to stand
    // in for clicking the page versus clicking the console.
    activeElement: null as unknown,
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
  // The clipboard chord follows the platform of the machine the viewer is
  // typing on, which is the one running this frontend. Node exposes its own
  // read-only `navigator`, so this has to be redefined rather than assigned.
  globals.__frontendSelection = '';
  Object.defineProperty(globals, 'navigator', {
    value: { platform: 'MacIntel' },
    configurable: true,
    writable: true,
  });
  // Capture-phase listeners the shim installs on window, keyed by event type,
  // so a test can deliver an event to them the way the browser would.
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  globals.__shimListeners = listeners;
  globals.window = {
    location: { href: 'http://127.0.0.1:1/devtools/inspector.html' },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    dispatchEvent: () => true,
    // The frontend's own selection — what the viewer highlighted in the
    // console or a panel, which their copy should take ahead of the page's.
    getSelection: () => (globalThis as unknown as { __frontendSelection: string })
      .__frontendSelection,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const forType = listeners.get(type) ?? [];
      forType.push(fn);
      listeners.set(type, forType);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      const forType = listeners.get(type) ?? [];
      listeners.set(
        type,
        forType.filter((listener) => listener !== fn),
      );
    },
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

// --- Clipboard bridge ----------------------------------------------------
//
// Stock DevTools forwards a clipboard chord to the remote page as a plain
// keystroke, which resolves against the remote machine's own (unreachable,
// usually empty) clipboard, and ignores the local clipboard event carrying the
// real one. The bridge carries text across in both directions instead.

test('the paste chord is stopped for DevTools but left for the local browser', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);

  const chord = fakeEvent({ key: 'v', metaKey: true });
  deliver('keydown', chord);

  // Forwarding it as well would paste the remote machine's own clipboard on
  // top of the text the bridge is about to insert.
  assert.equal(chord.record.stopPropagation, 1, 'ScreencastView must not forward the chord');
  // The whole mechanism hangs on this: preventDefault() would suppress the
  // local paste default action, and with it the `paste` event that carries the
  // clipboard.
  assert.equal(chord.record.preventDefault, 0, 'the local paste default action must still run');
});

test('a paste over the screencast is inserted into the remote page', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  assert.equal(installScreencastClipboard(view).state, 'clipboard=paste+copy+cut');
  setActiveElement(view.canvasElement);

  deliver('paste', fakeEvent({ clipboardData: fakeClipboardData({ 'text/plain': 'hi 👋' }) }));

  assert.deepEqual(view.inserted, ['hi 👋']);
});

test('a copy writes the remote selection onto the local clipboard', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);
  await mirrorSelection(view, 'selected in the remote page');

  const chord = fakeEvent({ key: 'c', metaKey: true });
  deliver('keydown', chord);
  const copy = fakeEvent({ type: 'copy', clipboardData: fakeClipboardData() });
  deliver('copy', copy);

  assert.equal(chord.record.stopPropagation, 1, 'the page must not also handle the chord');
  // setData only reaches the clipboard when the default action is cancelled.
  assert.equal(copy.record.preventDefault, 1);
  assert.deepEqual(copy.clipboardData.data, { 'text/plain': 'selected in the remote page' });
});

test('a cut copies and then deletes the remote selection', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);
  await mirrorSelection(view, 'text being moved');

  deliver('cut', fakeEvent({ type: 'cut', clipboardData: fakeClipboardData() }));

  assert.deepEqual(view.dispatched, [
    {
      type: 'keyDown',
      key: '',
      windowsVirtualKeyCode: 0,
      nativeVirtualKeyCode: 0,
      commands: ['delete'],
    },
  ]);

  // The selection is gone now, so a second cut before the mirror refreshes
  // must not delete a second time — that would eat text the user never cut.
  const second = fakeEvent({ type: 'cut', clipboardData: fakeClipboardData() });
  deliver('cut', second);
  assert.equal(view.dispatched.length, 1, 'no second delete');
  assert.equal(second.record.preventDefault, 0, 'and nothing written to the clipboard');
});

test('copy with nothing selected stays a page keystroke', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);
  await mirrorSelection(view, '');

  const chord = fakeEvent({ key: 'c', metaKey: true });
  deliver('keydown', chord);
  const copy = fakeEvent({
    type: 'copy',
    clipboardData: fakeClipboardData({ 'text/plain': 'local' }),
  });
  deliver('copy', copy);

  // Ctrl+C is SIGINT to anything running a terminal in the remote page, so
  // swallowing it when there is nothing to copy would be far worse than a copy
  // that does nothing.
  assert.equal(chord.record.stopPropagation, 0, 'the chord reaches the page');
  // And an empty mirror must not overwrite whatever the viewer already had.
  assert.equal(copy.record.preventDefault, 0);
  assert.deepEqual(copy.clipboardData.data, { 'text/plain': 'local' });
});

test('the mirror refreshes on everything that can move a selection', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);

  deliver('mouseup', fakeEvent({}));
  deliver('keyup', fakeEvent({ key: 'ArrowLeft', shiftKey: true }));
  await sleep(0);
  // Pressing the modifier is the last chance to catch up before the chord
  // lands — it covers a drag released outside the iframe, and a selection the
  // page's own script changed.
  deliver('keydown', fakeEvent({ key: 'Meta', metaKey: true }));
  await sleep(0);
  assert.equal(view.reads, 3);

  // Not while the frontend's own console or address bar holds focus.
  setActiveElement({ id: 'console-prompt' });
  deliver('mouseup', fakeEvent({}));
  deliver('keyup', fakeEvent({ key: 'a' }));
  await sleep(0);
  assert.equal(view.reads, 3, 'no CDP traffic for keystrokes the screencast does not own');
});

test('clipboard events elsewhere in the frontend keep stock behaviour', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);
  await mirrorSelection(view, 'remote selection');
  // Focus in the console prompt, the address bar, the Sources editor — all
  // local text fields the viewer's browser already handles correctly.
  setActiveElement({ id: 'console-prompt' });

  const chord = fakeEvent({ key: 'c', metaKey: true });
  deliver('keydown', chord);
  const copy = fakeEvent({ type: 'copy', clipboardData: fakeClipboardData() });
  deliver('copy', copy);
  const paste = fakeEvent({ clipboardData: fakeClipboardData({ 'text/plain': 'hi' }) });
  deliver('paste', paste);

  assert.equal(chord.record.stopPropagation, 0, 'DevTools keeps its own shortcut handling');
  assert.deepEqual(
    copy.clipboardData.data,
    {},
    'the local selection is copied, not the remote one',
  );
  assert.equal(paste.record.preventDefault, 0, 'the local field pastes as usual');
  assert.deepEqual(view.inserted, [], 'nothing is forwarded to the remote page');
});

test('chords follow the platform the viewer is typing on', async () => {
  const { classifyClipboardChord } = await loadShim();

  setPlatform('MacIntel');
  assert.equal(classifyClipboardChord({ key: 'v', metaKey: true }), 'paste');
  assert.equal(classifyClipboardChord({ key: 'c', metaKey: true }), 'copy');
  assert.equal(classifyClipboardChord({ key: 'x', metaKey: true }), 'cut');
  // The reason this is platform-aware at all: on a Mac, Ctrl+C is not copy,
  // it is SIGINT to whatever the remote page is running.
  assert.equal(classifyClipboardChord({ key: 'c', ctrlKey: true }), null, 'Ctrl+C on a Mac');

  setPlatform('Win32');
  assert.equal(classifyClipboardChord({ key: 'c', ctrlKey: true }), 'copy');
  assert.equal(classifyClipboardChord({ key: 'c', metaKey: true }), null, 'Super+C on Windows');

  // Shift is paste-as-plain-text, but on copy it is DevTools' inspect-element.
  assert.equal(classifyClipboardChord({ key: 'V', ctrlKey: true, shiftKey: true }), 'paste');
  assert.equal(classifyClipboardChord({ key: 'C', ctrlKey: true, shiftKey: true }), null);
  // Alt+Ctrl+V is a page shortcut in its own right (Slack, editors), so it has
  // to keep reaching the remote page rather than turning into a paste.
  assert.equal(classifyClipboardChord({ key: 'v', ctrlKey: true, altKey: true }), null);
  // And so does the platform's other modifier, for the same reason.
  assert.equal(classifyClipboardChord({ key: 'c', ctrlKey: true, metaKey: true }), null);
  setPlatform('MacIntel');
  assert.equal(classifyClipboardChord({ key: 'c', metaKey: true, ctrlKey: true }), null);
  assert.equal(classifyClipboardChord({ key: 'v' }), null, 'plain v types into the page');
  assert.equal(classifyClipboardChord({ ctrlKey: true }), null, 'a bare modifier has no key');
});

test('each direction degrades on its own when Chrome moves an API', async () => {
  const { installScreencastClipboard } = await loadShim();

  const noInsert = new FakeClipboardView();
  delete noInsert.inputAgent.invoke_insertText;
  assert.equal(installScreencastClipboard(noInsert).state, 'clipboard=copy+cut');
  setActiveElement(noInsert.canvasElement);
  const pasteChord = fakeEvent({ key: 'v', metaKey: true });
  deliver('keydown', pasteChord);
  // Swallowing the chord with nothing to insert would be worse than stock:
  // the remote page would stop seeing the keystroke at all.
  assert.equal(pasteChord.record.stopPropagation, 0);

  const noRead = new FakeClipboardView();
  delete noRead.inputModel.target;
  assert.equal(installScreencastClipboard(noRead).state, 'clipboard=paste');

  const noDelete = new FakeClipboardView();
  delete noDelete.inputAgent.invoke_dispatchKeyEvent;
  assert.equal(installScreencastClipboard(noDelete).state, 'clipboard=paste+copy');

  const gone = new FakeClipboardView();
  gone.inputModel = {};
  assert.match(installScreencastClipboard(gone).state, /^clipboard=stock/);
});

test('a read that outlives a cut cannot resurrect the mirror', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);
  await mirrorSelection(view, 'text being moved');

  // The refresh that rides the modifier keydown is still in flight when the
  // chord completes — the common shape on a link with any latency at all.
  view.holdReads = true;
  deliver('keydown', fakeEvent({ key: 'Meta', metaKey: true }));
  deliver('cut', fakeEvent({ type: 'cut', clipboardData: fakeClipboardData() }));
  assert.equal(view.dispatched.length, 1, 'the cut itself goes through');

  view.remoteSelection = '';
  view.releaseReads();
  await sleep(0);

  // That read answers with the pre-cut selection. Letting it back into the
  // mirror would arm a second cut that deletes whatever is selected next
  // while the clipboard still holds this text.
  const second = fakeEvent({ type: 'cut', clipboardData: fakeClipboardData() });
  deliver('cut', second);
  assert.equal(view.dispatched.length, 1, 'no second delete');
  assert.equal(second.record.preventDefault, 0);
});

test("a selection in the frontend wins over the page's", async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);
  await mirrorSelection(view, 'selected in the remote page');
  // Highlighting console output or a stack trace never had to move focus off
  // the canvas, so focus alone cannot tell the two intents apart.
  setFrontendSelection('a stack trace the viewer highlighted');

  const chord = fakeEvent({ key: 'c', metaKey: true });
  deliver('keydown', chord);
  const copy = fakeEvent({ type: 'copy', clipboardData: fakeClipboardData() });
  deliver('copy', copy);

  assert.equal(chord.record.stopPropagation, 0);
  assert.equal(copy.record.preventDefault, 0, 'the frontend copies its own text');
  assert.deepEqual(copy.clipboardData.data, {});
  setFrontendSelection('');
});

test('the cross-origin fan-out stays off the per-keystroke path', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);
  // A page whose own realm has no selection, and one cross-origin frame that
  // does. Ad-carrying pages have many such frames, and typing must not cost a
  // round trip for each of them per keystroke.
  view.frameSelections = ['selected inside a cross-origin frame'];

  deliver('keyup', fakeEvent({ key: 'a' }));
  await sleep(0);
  assert.equal(view.reads, 1, 'the page itself is still read');
  assert.equal(view.frameReads, 0, 'but its frames are not');

  deliver('mouseup', fakeEvent({}));
  await sleep(0);
  assert.equal(view.frameReads, 1, 'a finished selection gesture does ask them');

  const copy = fakeEvent({ type: 'copy', clipboardData: fakeClipboardData() });
  deliver('copy', copy);
  assert.deepEqual(copy.clipboardData.data, {
    'text/plain': 'selected inside a cross-origin frame',
  });
});

test('a cut with no DataTransfer deletes nothing', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  installScreencastClipboard(view);
  setActiveElement(view.canvasElement);
  await mirrorSelection(view, 'text being moved');

  // Deleting text that could not be carried anywhere is unrecoverable, so an
  // event with no route to the clipboard has to be left alone entirely.
  const cut = fakeEvent({ type: 'cut' });
  deliver('cut', cut);

  assert.deepEqual(view.dispatched, [], 'nothing deleted');
  assert.equal(cut.record.preventDefault, 0);
});

test('an install-time throw degrades to stock instead of unplacing the shim', async () => {
  const { installScreencastClipboard } = await loadShim();
  const view = new FakeClipboardView();
  Object.defineProperty(view, 'inputModel', {
    get() {
      throw new Error('Chrome moved ScreencastView.inputModel');
    },
  });

  // This runs before applyInspectorPosition, so a throw here would take the
  // inspector placement and the compact frame down with it — an optional
  // enhancement breaking what already worked.
  assert.match(installScreencastClipboard(view).state, /^clipboard=stock \(Error/);
});
