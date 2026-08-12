// Runs inside the proxied Chrome DevTools iframe, not OmniTerm's parent page.
// This intentionally uses feature detection because DevTools frontend modules
// are an internal Chrome API and can change independently of OmniTerm.

const STATE_ATTRIBUTE = 'data-omniterm-screencast-shim';
const DETAIL_ATTRIBUTE = 'data-omniterm-screencast-shim-detail';
const COMPACT_FRAME_STYLE_ID = 'omniterm-devtools-compact-screencast-frame';
const COMPACT_FRAME_RESIZE_OBSERVER = Symbol('omnitermCompactFrameResizeObserver');
// Marks the `imageElement.onload` handler this shim installs, and carries the
// stock handler it wrapped. See installCompactScreencastFrame.
const WRAPPED_STOCK_ON_LOAD = Symbol('omnitermWrappedStockOnLoad');
// Messages OmniTerm's parent frame sends to a loaded shim. See TabBrowserView.
export const SHIM_MESSAGE_TYPE = 'omniterm:devtools-shim';
const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
// Collapse bursts of layout changes (split relayout, tab show/hide) into a
// single refit.
const REFIT_DEBOUNCE_MS = 150;
// ScreencastView.onResize() restarts casting on its own 100ms timer. Let that
// timer fire before the next refit so consecutive refits do not race it.
const REFIT_SETTLE_MS = 250;
// Upper bound on waiting for an in-flight startCasting() to publish its
// operation id. Well above a local CDP round trip, low enough that a wedged
// connection still lets the refit through.
const CASTING_HANDOFF_TIMEOUT_MS = 3_000;
let currentStage = 'startup';
const scriptElement = document.getElementById('omniterm-devtools-screencast-shim');
const requestedPosition = ['hidden', 'right', 'bottom'].includes(
  scriptElement?.dataset.inspectorPosition,
)
  ? scriptElement.dataset.inspectorPosition
  : 'hidden';

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Import a module out of the DevTools frontend that is hosting this shim. */
function importFrontendModule(path) {
  const frontendBaseUrl = new URL('.', window.location.href);
  return import(new URL(path, frontendBaseUrl).href);
}

function recordState(state, detail) {
  document.documentElement.setAttribute(STATE_ATTRIBUTE, state);
  if (detail) document.documentElement.setAttribute(DETAIL_ATTRIBUTE, detail);
  else document.documentElement.removeAttribute(DETAIL_ATTRIBUTE);
  window.dispatchEvent(
    new CustomEvent('omniterm:devtools-screencast-shim', {
      detail: { state, detail },
    }),
  );
}

function describeSplitState(split) {
  const sidebarShowing =
    typeof split.sidebarIsShowing === 'function'
      ? String(split.sidebarIsShowing())
      : 'unknown';
  const orientation =
    typeof split.isVertical === 'function'
      ? split.isVertical()
        ? 'right'
        : 'bottom'
      : 'unknown';
  return `sidebar=${sidebarShowing}; orientation=${orientation}`;
}

/**
 * Place InspectorView around the interactive screencast.
 *
 * Separated from the startup path so both branches are reachable from a test
 * and from a live `inspectorPosition` change, without reloading the frontend.
 */
export function applyInspectorPosition(split, position) {
  if (position === 'hidden') {
    if (typeof split?.hideSidebar !== 'function') {
      return { ok: false, reason: 'SplitWidget.hideSidebar is unavailable' };
    }
    split.hideSidebar();
    return { ok: true };
  }
  if (position !== 'right' && position !== 'bottom') {
    return { ok: false, reason: `unknown inspector position "${position}"` };
  }
  if (typeof split?.setVertical !== 'function' || typeof split?.showBoth !== 'function') {
    return { ok: false, reason: 'SplitWidget orientation APIs are unavailable' };
  }
  // SplitWidget's historical naming is inverted: true lays children out
  // left-to-right, while false lays them out top-to-bottom. InspectorView is
  // the second/sidebar widget, so these become right and bottom.
  split.setVertical(position === 'right');
  split.showBoth();
  return { ok: true };
}

/**
 * Serialized, debounced wrapper around ScreencastView.onResize().
 *
 * Calling onResize() directly is unsafe. It calls stopCasting(), which bails
 * out early when `screencastOperationId` is still unset — exactly the window in
 * which startCasting() is awaiting its CDP round trip. Stock stopCasting()
 * leaves `isCasting` true on that path, so the restart that onResize() defers
 * by 100ms hits `if (this.isCasting) return` and is silently dropped. The
 * screencast then stays locked to the pre-resize dimensions until some later,
 * luckier resize happens to land outside the window.
 *
 * So: wait for the handoff to complete before asking for a restart, and never
 * have more than one refit in flight.
 *
 * Every refit is a `Page.stopScreencast` + `Page.startScreencast` round trip
 * that blanks the remote page for a moment, so `setSuspended(true)` holds them
 * off for the length of a continuous gesture such as a pane-resize drag. The
 * pending refit is not dropped — it fires once on resume.
 */
export function createRefitScheduler(view) {
  let pending = false;
  let draining = false;
  let suspended = false;
  let timer = 0;

  async function drain() {
    draining = true;
    try {
      while (pending && !suspended) {
        pending = false;
        const deadline = Date.now() + CASTING_HANDOFF_TIMEOUT_MS;
        while (view.isCasting && !view.screencastOperationId && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
        }
        if (suspended) {
          pending = true;
          break;
        }
        view.onResize();
        await sleep(REFIT_SETTLE_MS);
      }
    } finally {
      draining = false;
    }
  }

  function arm() {
    if (suspended || draining || timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      void drain();
    }, REFIT_DEBOUNCE_MS);
  }

  return {
    schedule() {
      pending = true;
      arm();
    },
    setSuspended(next) {
      if (suspended === Boolean(next)) return;
      suspended = Boolean(next);
      if (!suspended && pending) arm();
    },
  };
}

/**
 * Fit the screencast to the pane by removing the frame stock DevTools draws
 * around the page, and keep it fitted as the pane changes size.
 *
 * Returns a handle: `state` for the status string, `refit()` to request a
 * restart, `setSuspended()` to hold refits off during a gesture, and `revert()`
 * to put every override back. Reverting matters because the pieces only work as
 * a set — the CSS that strips the frame and the JS that stops reserving room
 * for it. Leaving one without the other is worse than stock, so the failure
 * path removes both.
 */
export function installCompactScreencastFrame(view) {
  const stock = (detail) => ({
    state: `frame=stock (${detail})`,
    refit: () => {},
    setSuspended: () => {},
    revert: () => {},
  });

  try {
    if (
      !view?.element ||
      !view.viewportElement ||
      !view.imageElement ||
      typeof view.viewportDimensions !== 'function' ||
      typeof view.screencastFrame !== 'function' ||
      typeof view.onResize !== 'function' ||
      typeof view.repaint !== 'function'
    ) {
      return stock('ScreencastView frame APIs are unavailable');
    }

    const stockViewportDimensions = view.viewportDimensions.bind(view);
    const stockScreencastFrame = view.screencastFrame.bind(view);
    const scheduler = createRefitScheduler(view);
    let resizeObserver = null;
    let reverted = false;

    const revert = () => {
      if (reverted) return;
      reverted = true;
      document.getElementById(COMPACT_FRAME_STYLE_ID)?.remove();
      view.viewportDimensions = stockViewportDimensions;
      view.screencastFrame = stockScreencastFrame;
      resizeObserver?.disconnect();
      delete view[COMPACT_FRAME_RESIZE_OBSERVER];
      // Stock reassigns imageElement.onload on its next frame, so the wrapper
      // still installed there retires on its own. Restart casting so the page
      // is refitted to stock's own (smaller) available size.
      scheduler.schedule();
    };

    const style = document.createElement('style');
    style.id = COMPACT_FRAME_STYLE_ID;
    style.textContent = `
      .screencast-viewport {
        border: 0 !important;
        border-radius: 0 !important;
        padding: 0 !important;
      }

      .screencast-canvas-container {
        border: 0 !important;
      }
    `;
    document.getElementById(COMPACT_FRAME_STYLE_ID)?.remove();
    document.head.appendChild(style);

    // Stock DevTools subtracts a fixed frame (44px in current Chrome) and a
    // gutter from the available surface before scaling the page. Derive the
    // actual content box instead so this remains independent of those private
    // constants and of the current navigation-bar height.
    view.viewportDimensions = () => {
      const navigationHeight =
        view.element.querySelector('.screencast-navigation')?.offsetHeight ?? 0;
      const width = view.element.clientWidth;
      const height = view.element.clientHeight - navigationHeight;
      // Stock returns a negative size when there is no room, and startCasting()
      // depends on that to bail out and clear `isCasting`. Keep that contract
      // rather than asking Chrome for a 0x0 screencast while the pane is
      // hidden or not laid out yet.
      if (width <= 0 || height <= 0) return { width: -1, height: -1 };
      return { width, height };
    };

    view.screencastFrame = (base64Data, metadata) => {
      stockScreencastFrame(base64Data, metadata);
      if (
        !metadata ||
        typeof metadata.deviceWidth !== 'number' ||
        typeof metadata.deviceHeight !== 'number'
      ) {
        return;
      }

      // Stock sizes the viewport to the page *plus* BORDERS_SIZE, its private
      // allowance for the 20px padding, the 1px viewport border and the 1px
      // canvas-container border it draws around the page (44px total in Chrome
      // 151). The CSS above removes all three, so that allowance becomes dead
      // space: the canvas is `flex: auto`, stretches into it, and repaint()
      // draws the page at the top-left of a canvas 44px too wide and too tall.
      // The uncovered strip on the right falls through to the viewport's grey
      // background, and the strip below is painted by the checkerboard fill,
      // which resolves black. Take the allowance back off.
      //
      // Then repaint. Correcting the size alone is not enough: stock's onload
      // ends in updateHighlightInOverlayAndRepaint(), which reaches repaint()
      // without ever awaiting on this path, so the canvas has already been
      // measured and drawn at the oversized geometry by the time this runs.
      //
      // Current Chrome assigns a fresh onload above, so the wrapper below is
      // built on stock's handler every frame. Nothing guarantees that, so
      // unwrap our own handler when we find it rather than chaining onto it —
      // otherwise a Chrome that assigns onload once would grow one closure per
      // frame until the frontend stalls.
      const installed = view.imageElement.onload;
      const stockOnLoad =
        typeof installed === 'function' && WRAPPED_STOCK_ON_LOAD in installed
          ? installed[WRAPPED_STOCK_ON_LOAD]
          : installed;

      const wrapper = function (event) {
        if (typeof stockOnLoad === 'function') stockOnLoad.call(this, event);
        // screenZoom is set by the handler above, so it can only be read here —
        // it is undefined until the first frame lands. If it ever stops being
        // readable the compact geometry cannot be computed, and the CSS above
        // has already removed the border stock is still reserving room for, so
        // put everything back instead of leaving a half-applied frame.
        if (!Number.isFinite(view.screenZoom)) {
          revert();
          recordState('degraded', 'ScreencastView.screenZoom is unreadable; reverted to stock');
          return;
        }
        view.viewportElement.style.width = `${metadata.deviceWidth * view.screenZoom}px`;
        view.viewportElement.style.height = `${metadata.deviceHeight * view.screenZoom}px`;
        view.repaint();
      };
      wrapper[WRAPPED_STOCK_ON_LOAD] = stockOnLoad;
      view.imageElement.onload = wrapper;
    };

    // Keep the screencast fitted when the outer browser pane or inspector split
    // changes size. DevTools does not always propagate the first split layout
    // as a Widget resize, and OmniTerm can resize or hide the iframe at any
    // time without the frontend hearing about it.
    if (typeof ResizeObserver === 'function') {
      let width = view.element.clientWidth;
      let height = view.element.clientHeight;
      resizeObserver = new ResizeObserver(() => {
        const nextWidth = view.element.clientWidth;
        const nextHeight = view.element.clientHeight;
        if (nextWidth === width && nextHeight === height) return;
        width = nextWidth;
        height = nextHeight;
        scheduler.schedule();
      });
      resizeObserver.observe(view.element);
      view[COMPACT_FRAME_RESIZE_OBSERVER] = resizeObserver;
    }

    // Restart casting once the split widget has completed layout so Chrome
    // binds the wrapped frame handler to the final available surface.
    scheduler.schedule();
    return {
      state: 'frame=compact',
      refit: scheduler.schedule,
      setSuspended: scheduler.setSuspended,
      revert,
    };
  } catch (error) {
    return stock(String(error));
  }
}

/**
 * Apply live updates from OmniTerm's parent frame.
 *
 * Both of these used to require reloading the frontend: the inspector position
 * was baked into the iframe's React key, and a pane-resize drag had no way to
 * tell the shim to stop restarting the screencast mid-gesture.
 */
function listenForParentMessages(split, frame) {
  window.addEventListener('message', (event) => {
    // Same-origin by construction — the frontend is served through OmniTerm's
    // own proxy — so anything else is not the host frame.
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== SHIM_MESSAGE_TYPE) return;

    if (typeof data.resizing === 'boolean') frame.setSuspended(data.resizing);

    if (typeof data.inspectorPosition === 'string') {
      const applied = applyInspectorPosition(split, data.inspectorPosition);
      if (applied.ok) {
        frame.refit();
        recordState(data.inspectorPosition, `${describeSplitState(split)}; ${frame.state}`);
      } else {
        recordState('unsupported', applied.reason);
      }
    }
  });
}

async function placeInspector() {
  currentStage = 'import screencast module';
  const screencastModule = await importFrontendModule('panels/screencast/screencast.js');
  const ScreencastApp = screencastModule?.ScreencastApp?.ScreencastApp;

  if (typeof ScreencastApp?.instance !== 'function') {
    recordState('unsupported', 'ScreencastApp.instance is unavailable');
    return;
  }

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // iframe `load` fires before DevTools finishes its asynchronous startup.
    // Calling instance() before the real app is initialized constructs it too
    // early and Chrome throws (for example, before en-US locale registration).
    // The screencast DOM is created by the initialized app, so use it as the
    // readiness signal before retrieving the already-existing singleton.
    if (!document.querySelector('.screencast')) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    currentStage = 'read ScreencastApp instance';
    const app = ScreencastApp.instance();
    const split = app?.rootSplitWidget;

    // Wait for the page target as well as the split. Applying the choice before
    // modelAdded() calls showBoth() would let that later call overwrite it.
    if (app?.screencastView && split) {
      // Install the frame overrides before touching the split. Every placement
      // triggers a Widget resize, and the resize path must already be running
      // through the serialized refit scheduler when it does.
      const frame = installCompactScreencastFrame(app.screencastView);

      currentStage = `place inspector on ${requestedPosition}`;
      const applied = applyInspectorPosition(split, requestedPosition);
      if (!applied.ok) {
        recordState('unsupported', applied.reason);
        return;
      }

      listenForParentMessages(split, frame);
      recordState(requestedPosition, `${describeSplitState(split)}; ${frame.state}`);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  recordState('unsupported', 'Screencast split view did not become available');
}

placeInspector().catch((error) => {
  recordState(
    'error',
    `${currentStage}: ${typeof error?.stack === 'string' ? error.stack : String(error)}`,
  );
});
