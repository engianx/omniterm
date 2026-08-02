// Pure terminal-input logic + a thin injector for the mobile accessory key bar
// and compose field (feature 006-mobile-terminal-input).
//
// Delivery goes through ttyd's xterm.js `Terminal`, exposed same-origin as
// `iframe.contentWindow.term` (the same handle the OSC-52 clipboard handler in
// TerminalView already uses). We send with `term.input()` and read `term.modes`
// live for mode-faithful arrows. We deliberately do NOT use `term.paste()`:
// bracketed-paste mode wraps content in ESC[200~/201~ and would mangle control
// bytes and suppress command execution. We also avoid synthetic `keydown`
// dispatch, which carries cross-frame and WebKit `keyCode`-reflection risk —
// `term.input()` produces the identical bytes deterministically (verified in
// specs/006-mobile-terminal-input/research.md).

export type ArrowDir = 'up' | 'down' | 'left' | 'right';

/** Minimal shape we rely on from xterm.js 5.4's Terminal (feature-detected). */
export interface XtermModes {
  applicationCursorKeysMode?: boolean;
  bracketedPasteMode?: boolean;
}
export interface XtermLike {
  input(data: string, wasUserInput?: boolean): void;
  modes?: XtermModes;
}
/** A `term` that has passed feature detection — `modes` is guaranteed present. */
export type XtermReady = XtermLike & { modes: XtermModes };

/** A key-bar entry. `bytes` keys send fixed data; `arrow` keys are mode-aware. */
export type KeyDescriptor =
  | { id: string; label: string; ariaLabel: string; type: 'bytes'; data: string }
  | { id: string; label: string; ariaLabel: string; type: 'arrow'; dir: ArrowDir };

/** C0 control bytes used by the bar. */
export const ESC = '\x1b';
export const TAB = '\x09';
export const ETX = '\x03'; // Ctrl-C

/**
 * Default mobile key bar. Esc/Tab/arrows + a one-tap Ctrl-C, then a few
 * shell-common symbols. Fixed in v1 (FR-005); user-configurable sets are out of
 * scope.
 */
export const KEY_BAR: readonly KeyDescriptor[] = [
  { id: 'esc', label: 'Esc', ariaLabel: 'Escape', type: 'bytes', data: ESC },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab', type: 'bytes', data: TAB },
  { id: 'ctrl-c', label: '^C', ariaLabel: 'Control C (interrupt)', type: 'bytes', data: ETX },
  { id: 'up', label: '↑', ariaLabel: 'Up arrow', type: 'arrow', dir: 'up' },
  { id: 'down', label: '↓', ariaLabel: 'Down arrow', type: 'arrow', dir: 'down' },
  { id: 'left', label: '←', ariaLabel: 'Left arrow', type: 'arrow', dir: 'left' },
  { id: 'right', label: '→', ariaLabel: 'Right arrow', type: 'arrow', dir: 'right' },
  { id: 'slash', label: '/', ariaLabel: 'Slash', type: 'bytes', data: '/' },
  { id: 'dash', label: '-', ariaLabel: 'Hyphen', type: 'bytes', data: '-' },
  { id: 'tilde', label: '~', ariaLabel: 'Tilde', type: 'bytes', data: '~' },
  { id: 'pipe', label: '|', ariaLabel: 'Pipe', type: 'bytes', data: '|' },
];

/**
 * The control byte for a letter (Ctrl-`<letter>`), or null for a non-letter.
 * `a`/`A` → \x01 … `z`/`Z` → \x1a. Case-insensitive.
 */
export function controlByteForLetter(letter: string): string | null {
  // ASCII a–z/A–Z only. Guard the input directly (not the uppercased result):
  // 'ß'.toUpperCase() === 'SS' and 'ı'.toUpperCase() === 'I' would otherwise
  // sneak past a length/range check and emit a stray control byte.
  if (!/^[a-z]$/i.test(letter)) return null;
  return String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);
}

/**
 * The escape sequence for an arrow key. Normal cursor mode emits `ESC[A..D`;
 * application-cursor mode (DECCKM, set by TUIs like vim/less) emits `ESC O A..D`.
 * Reading the live mode keeps arrows correct inside those apps.
 */
export function arrowSequence(dir: ArrowDir, applicationCursorMode: boolean): string {
  const final = dir === 'up' ? 'A' : dir === 'down' ? 'B' : dir === 'right' ? 'C' : 'D';
  return (applicationCursorMode ? `${ESC}O` : `${ESC}[`) + final;
}

/**
 * Resolve a `term` handle from an iframe `contentWindow`, feature-detecting the
 * API we need. Returns null (never throws) when the terminal isn't ready or the
 * shape is missing, so callers degrade to a no-op.
 */
export function getTerminal(win: Window | null | undefined): XtermReady | null {
  try {
    const term = (win as unknown as { term?: unknown })?.term as XtermLike | undefined;
    if (
      term &&
      typeof term.input === 'function' &&
      term.modes != null &&
      typeof term.modes === 'object'
    ) {
      return term as XtermReady;
    }
  } catch {
    // Cross-origin or not-ready — fall through to null.
  }
  return null;
}

/** Write raw data to the PTY via `term.input()`. Returns false if unavailable. */
export function sendData(win: Window | null | undefined, data: string): boolean {
  const term = getTerminal(win);
  if (!term) return false;
  term.input(data);
  return true;
}

/**
 * Send a key-bar descriptor. Arrow keys read the live application-cursor mode so
 * they stay faithful inside TUIs; everything else sends fixed bytes.
 */
export function sendDescriptor(win: Window | null | undefined, descriptor: KeyDescriptor): boolean {
  const term = getTerminal(win);
  if (!term) return false;
  const data =
    descriptor.type === 'arrow'
      ? arrowSequence(descriptor.dir, !!term.modes.applicationCursorKeysMode)
      : descriptor.data;
  term.input(data);
  return true;
}

/** Send a Ctrl-`<letter>` control byte. No-op (false) for non-letters. */
export function sendControlLetter(win: Window | null | undefined, letter: string): boolean {
  const byte = controlByteForLetter(letter);
  if (byte === null) return false;
  return sendData(win, byte);
}

/**
 * Send composed text as a single write (never paste → never bracket-wrapped).
 * `run` appends a carriage return so the shell executes the line. Empty text is
 * a no-op returning false.
 */
export function sendComposed(win: Window | null | undefined, text: string, run: boolean): boolean {
  if (text.length === 0) return false;
  return sendData(win, run ? `${text}\r` : text);
}

// ----- sticky Ctrl modifier state machine (US2) -----

export type CtrlState = 'idle' | 'armed';
export type CtrlAction = 'toggle' | 'consume' | 'clear';

/**
 * One-shot Ctrl modifier. `toggle` arms from idle and disarms when armed;
 * `consume` (after a letter is sent) and `clear` (when the active terminal
 * changes) return to idle.
 */
export function ctrlReducer(state: CtrlState, action: CtrlAction): CtrlState {
  switch (action) {
    case 'toggle':
      return state === 'armed' ? 'idle' : 'armed';
    case 'consume':
    case 'clear':
      return 'idle';
  }
}
