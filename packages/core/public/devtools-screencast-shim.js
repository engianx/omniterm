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

/** Cmd on macOS, Ctrl everywhere else. */
function usesCommandKey() {
  const platform = globalThis.navigator?.platform || globalThis.navigator?.userAgent || '';
  return /mac|iphone|ipad/i.test(platform);
}

/**
 * Which clipboard chord a keystroke is, if any.
 *
 * The modifier follows the keyboard the *viewer* is typing on, not the machine
 * the page runs on. Accepting both Meta and Ctrl everywhere would be worse
 * than useless: on a Mac, Ctrl+C is not copy, it is SIGINT to whatever the
 * remote page is running.
 */
export function classifyClipboardChord(event) {
  const chordModifier = usesCommandKey() ? event.metaKey : event.ctrlKey;
  // The platform's *other* modifier makes this some different chord rather
  // than this one — Ctrl+Cmd+C on a Mac is nobody's copy — so it disqualifies
  // the keystroke just as Alt does.
  const otherModifier = usesCommandKey() ? event.ctrlKey : event.metaKey;
  if (!chordModifier || otherModifier || event.altKey) return null;
  if (typeof event.key !== 'string') return null;
  const key = event.key.toLowerCase();
  // Shift is fine on paste — that is paste-as-plain-text and paste-and-match-
  // style — but not on copy or cut, where Cmd/Ctrl+Shift+C is DevTools' own
  // inspect-element shortcut and has to keep working.
  if (key === 'v') return 'paste';
  if (event.shiftKey) return null;
  if (key === 'c') return 'copy';
  if (key === 'x') return 'cut';
  return null;
}

/**
 * Read the selected text out of a page, as the user sees it.
 *
 * Evaluated in the remote page, so it is a string rather than a function: it
 * has to survive the trip and run in a realm this code shares nothing with.
 *
 * Focus can sit inside a nested frame, and a selection left behind in a frame
 * that has since lost focus stays highlighted — so ask the frame that actually
 * holds focus first, and only sweep the rest if it has nothing.
 */
const READ_SELECTION_EXPRESSION = `(() => {
  const activeIn = (win) => {
    let element = win.document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  };
  const textIn = (win) => {
    const selected = String(win.getSelection() ?? '');
    if (selected) return selected;
    // Depending on the browser and on where focus sits, a selection inside an
    // <input> or <textarea> is not reflected in getSelection().
    try {
      const element = activeIn(win);
      const start = element?.selectionStart;
      const end = element?.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        return String(element.value ?? '').slice(start, end);
      }
    } catch {
      // selectionStart throws on input types that do not support selection.
    }
    return '';
  };
  const focusedIn = (win) => {
    const element = activeIn(win);
    if (!element?.contentWindow) return win;
    try {
      return focusedIn(element.contentWindow);
    } catch {
      return win;
    }
  };
  const sweep = (win) => {
    const text = textIn(win);
    if (text) return text;
    for (const frame of Array.from(win.frames)) {
      try {
        const nested = sweep(frame);
        if (nested) return nested;
      } catch {
        // Cross-origin: unreachable from this realm, and its own CDP target.
      }
    }
    return '';
  };
  try {
    return textIn(focusedIn(window)) || sweep(window);
  } catch {
    return '';
  }
})()`;

/**
 * Carry the clipboard across the screencast in both directions.
 *
 * Stock DevTools does one thing with a keystroke: forward it as a raw
 * `Input.dispatchKeyEvent`. So a clipboard chord reaches the remote renderer
 * as a bare modified keypress, and whatever copy or paste it runs there
 * resolves against the *remote* machine's clipboard — which, for a headless
 * browser on a server, is an empty clipboard nobody can reach. Meanwhile the
 * viewing browser fires perfectly good local `paste`, `copy` and `cut` events
 * that the frontend has no listener for. Nothing connects the two ends, so the
 * chords appear to do nothing at all.
 *
 * Connect them, one direction each:
 *
 * - Paste takes the local event's `clipboardData` and applies it to the page
 *   with `Input.insertText`.
 * - Copy and cut answer the local event with `setData()`, which is the only
 *   way onto the viewer's clipboard and is synchronous — the text has to be in
 *   hand already, so the remote selection is mirrored here ahead of time (see
 *   `refreshSelection`). Cut then deletes the remote selection.
 *
 * None of this needs a Clipboard API permission prompt or a secure context,
 * which matters because OmniTerm is commonly reached over plain HTTP on a LAN
 * address, where `navigator.clipboard` does not exist at all.
 *
 * Chords are claimed before ScreencastView's canvas listener can forward them,
 * so the remote page does not also act on a bare chord with its own empty
 * clipboard. Only keystrokes owned by the screencast canvas are touched: the
 * rest of the frontend — console prompt, address bar, Sources editor — keeps
 * stock clipboard behaviour, where the viewer's browser is already doing the
 * right thing with local text.
 */
export function installScreencastClipboard(view) {
  // Same contract as installCompactScreencastFrame: this is an optional
  // enhancement installed before the inspector is placed, so a Chrome that has
  // reshaped these internals has to degrade to stock here rather than throw
  // out of placeInspector and leave the whole shim unapplied.
  const stock = (detail) => ({ state: `clipboard=stock (${detail})`, revert: () => {} });

  try {
    const inputAgent = view?.inputModel?.inputAgent;
    const target = typeof view?.inputModel?.target === 'function' ? view.inputModel.target() : null;
    const runtimeAgent = typeof target?.runtimeAgent === 'function' ? target.runtimeAgent() : null;

    const canPaste = typeof inputAgent?.invoke_insertText === 'function';
    const canRead = typeof runtimeAgent?.invoke_evaluate === 'function';
    // Cut is copy plus the delete half, which rides the same editing-command
    // channel Chrome itself uses to deliver a menu or key-binding command.
    const canCut = canRead && typeof inputAgent?.invoke_dispatchKeyEvent === 'function';
    const installed = [canPaste && 'paste', canRead && 'copy', canCut && 'cut'].filter(Boolean);

    if (!view?.canvasElement || installed.length === 0) {
      return stock('ScreencastView CDP agents are unavailable');
    }

    // The remote page is a canvas on this side, so it has no focusable element
    // of its own: that one canvas holds the frontend's focus for the whole
    // screencast, and DevTools refocuses it on every event it handles.
    const ownsFocus = () => document.activeElement === view.canvasElement;

    // `copy` must be answered synchronously, so the selection cannot be fetched
    // when the chord arrives — by the time a CDP round trip returned, the event
    // would be long gone and the clipboard already written. Mirror it instead,
    // refreshed on everything that can change it.
    let selectedText = '';
    let reading = false;
    let readAgain = false;
    let readDeep = false;
    // Bumped whenever this bridge itself invalidates the mirror. A read still in
    // flight across that point is describing text that no longer exists.
    let selectionEpoch = 0;

    const readSelection = async (agent) => {
      const response = await agent.invoke_evaluate({
        expression: READ_SELECTION_EXPRESSION,
        returnByValue: true,
      });
      const value = response?.result?.value;
      return typeof value === 'string' ? value : '';
    };

    /** Frames Chrome put in their own process, and so out of the page's reach. */
    const crossOriginFrameAgents = () => {
      const targets = target.targetManager?.()?.targets?.() ?? [];
      return targets
        .filter((other) => other !== target && other.type?.() === 'frame')
        .map((other) => other.runtimeAgent?.())
        .filter((agent) => typeof agent?.invoke_evaluate === 'function');
    };

    /**
     * Bring the mirror up to date.
     *
     * `deep` additionally asks the cross-origin frame targets, which the page's
     * own expression cannot see into. That fan-out costs a round trip per such
     * frame, and a page carrying ads or embeds has many, so it rides only the
     * infrequent events — a finished selection gesture, the modifier pressed
     * ahead of a chord — and never the per-keystroke refresh.
     */
    const refreshSelection = (deep = false) => {
      if (!canRead) return;
      if (deep) readDeep = true;
      // Never more than one read in flight, and never drop the last one: a
      // request that arrives mid-read is the newest state of the selection, so
      // it has to run after, not instead. Dropping it would leave the mirror
      // stale exactly when the user is about to press the chord.
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      void (async () => {
        try {
          do {
            readAgain = false;
            const fanOut = readDeep;
            readDeep = false;
            const epoch = selectionEpoch;
            let text = await readSelection(runtimeAgent);
            // Only pay for the fan-out when the page itself came back with
            // nothing, and run it in parallel — the point is to have an answer
            // before the chord lands, which one round trip per frame would miss.
            if (!text && fanOut) {
              const texts = await Promise.all(
                crossOriginFrameAgents().map((agent) => readSelection(agent).catch(() => '')),
              );
              text = texts.find(Boolean) ?? '';
            }
            if (epoch === selectionEpoch) selectedText = text;
          } while (readAgain);
        } catch {
          // Better a copy that does nothing than one that quietly puts text from
          // a page the viewer has already left onto their clipboard.
          selectedText = '';
        } finally {
          reading = false;
        }
      })();
    };

    // A selection the viewer made in the frontend itself — console output, a
    // stack trace, a panel's static text — stays highlighted and is what their
    // copy should take, and selecting it never had to move focus off the canvas.
    const frontendHasSelection = () => Boolean(String(window.getSelection() ?? ''));

    const shouldClaim = (chord) => {
      if (chord === 'paste') return canPaste;
      if (chord === 'cut' && !canCut) return false;
      // Claim copy and cut only when the page has something to copy and this
      // side does not. With no selection they have to stay page keystrokes:
      // Ctrl+C is SIGINT to a terminal running in the remote page, and
      // swallowing it would be far worse than a copy that does nothing.
      return Boolean(selectedText) && !frontendHasSelection();
    };

    // The letter whose keydown was claimed, so its keyup can follow suit.
    let claimedKey = '';

    const onKeyDown = (event) => {
      if (!ownsFocus()) return;
      // Pressing the modifier is the last chance to catch up before the chord
      // itself lands: it covers a selection the page's own script changed, and a
      // drag whose mouseup was released outside the iframe.
      if (event.key === 'Meta' || event.key === 'Control') refreshSelection(true);
      const chord = classifyClipboardChord(event);
      claimedKey = chord && shouldClaim(chord) ? event.key.toLowerCase() : '';
      if (claimedKey) event.stopPropagation();
      // Deliberately no preventDefault: the local default action is what fires
      // the clipboard event this all depends on.
    };

    const onKeyUp = (event) => {
      if (!ownsFocus()) return;
      // Follow what the keydown decided rather than deciding again. The two
      // edges have to agree, and the mirror moves between them: a cut empties
      // it, so re-deriving here would withhold the keydown and then forward
      // the keyup, leaving the page a release it never saw pressed.
      if (claimedKey && typeof event.key === 'string' && event.key.toLowerCase() === claimedKey) {
        event.stopPropagation();
        claimedKey = '';
      }
      // Any keystroke at all can move the caret or replace the selection. One
      // small evaluate per key is nothing beside the JPEG stream already running.
      refreshSelection();
    };

    const onMouseUp = () => {
      if (ownsFocus()) refreshSelection(true);
    };

    const onPaste = (event) => {
      if (!ownsFocus()) return;
      // Nothing here is editable, so the default action has nothing to do, but
      // claim the event so no DevTools clipboard handler acts on it either.
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      // insertText rather than a synthesized key event per character: one round
      // trip, and it carries newlines, emoji and other text no
      // windowsVirtualKeyCode can describe.
      void inputAgent.invoke_insertText({ text });
    };

    const onCopy = (event) => {
      // With an empty mirror, or with a selection of the viewer's own to copy,
      // leave the event alone rather than writing over their clipboard.
      if (!ownsFocus() || !selectedText || frontendHasSelection()) return;
      if (event.type === 'cut' && !canCut) return;
      const clipboardData = event.clipboardData;
      // Without a DataTransfer there is no route onto the viewer's clipboard,
      // and a cut that deleted text it could not carry would be unrecoverable.
      if (!clipboardData) return;
      event.preventDefault();
      event.stopPropagation();
      clipboardData.setData('text/plain', selectedText);
      if (event.type !== 'cut') return;
      // `delete` is a no-op both on a collapsed caret and on a selection that is
      // not editable, which is what a cut should do in either case.
      void inputAgent.invoke_dispatchKeyEvent({
        type: 'keyDown',
        key: '',
        windowsVirtualKeyCode: 0,
        nativeVirtualKeyCode: 0,
        commands: ['delete'],
      });
      // The mirrored text is gone from the page now, and any read still in
      // flight was started before it went.
      selectedText = '';
      selectionEpoch++;
    };

    // Capture on window, so these run ahead of the frontend: DevTools binds its
    // key listeners to the canvas itself and its shortcut registry to the
    // document, and both of those sit below window on the capture path. (The
    // frontend's own consume() is stopImmediatePropagation, which reaches no
    // further than the node it fires on, so it cannot cut these off.)
    const listeners = [
      ['keydown', onKeyDown],
      ['keyup', onKeyUp],
      ['mouseup', onMouseUp],
      ...(canPaste ? [['paste', onPaste]] : []),
      ...(canRead ? [['copy', onCopy]] : []),
      ...(canCut ? [['cut', onCopy]] : []),
    ];
    for (const [type, listener] of listeners) window.addEventListener(type, listener, true);

    return {
      state: `clipboard=${installed.join('+')}`,
      revert: () => {
        for (const [type, listener] of listeners) window.removeEventListener(type, listener, true);
      },
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
function listenForParentMessages(split, frame, clipboard) {
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
        recordState(
          data.inspectorPosition,
          `${describeSplitState(split)}; ${frame.state}; ${clipboard.state}`,
        );
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
      const clipboard = installScreencastClipboard(app.screencastView);

      currentStage = `place inspector on ${requestedPosition}`;
      const applied = applyInspectorPosition(split, requestedPosition);
      if (!applied.ok) {
        // Both handles were installed for a screencast we then failed to
        // place. They only make sense as part of that arrangement — the
        // clipboard bridge in particular claims copy/paste chords on behalf
        // of a canvas that is now laid out by stock DevTools — so roll them
        // back instead of leaving them armed. Same reasoning as the frame
        // handle's own degrade path.
        clipboard.revert();
        frame.revert();
        recordState('unsupported', applied.reason);
        return;
      }

      listenForParentMessages(split, frame, clipboard);
      recordState(
        requestedPosition,
        `${describeSplitState(split)}; ${frame.state}; ${clipboard.state}`,
      );
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
