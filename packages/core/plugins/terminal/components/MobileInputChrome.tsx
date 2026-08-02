'use client';

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useKeyboardInset } from '../../../app/useKeyboardInset';
import {
  KEY_BAR,
  ctrlReducer,
  sendComposed,
  sendControlLetter,
  sendDescriptor,
  type KeyDescriptor,
} from '../lib/terminalInput';

interface Props {
  /** Accessor for the active terminal iframe's contentWindow (lazy: read at send time). */
  getWindow: () => Window | null;
  /**
   * Id of the active terminal session (null while a terminal tab is active but
   * its session is still loading). Used to reset the compose buffer / armed Ctrl
   * when the user genuinely switches to a *different* terminal — without losing
   * in-progress input across a transient load gap.
   */
  activeSessionId: string | null;
}

const CTRL_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * A pointer/mouse-down handler that suppresses focus theft (so the soft keyboard
 * stays exactly as it is) only when `active`. The single focus-guard primitive:
 * every bar key uses `keepFocusIf(true)` (always keep focus), while the
 * collapse/expand toggle uses `keepFocusIf(kbInset > 0)` — it must leave the
 * keyboard untouched when one is up but must NOT preventDefault when none is (an
 * unconditional guard can swallow the first tap there).
 *
 * Callers wire it to BOTH onPointerDown and onMouseDown: on a UA with Pointer
 * Events the pointerdown preventDefault already suppresses the synthesized
 * mousedown, so the mousedown handler is just the fallback for any UA that emits
 * mouse events without pointer events.
 */
export const keepFocusIf =
  (active: boolean) => (e: React.PointerEvent | React.MouseEvent) => {
    if (active) e.preventDefault();
  };

/**
 * A bar key. Suppresses focus theft (pointer-down preventDefault) so tapping it
 * never blurs whatever holds focus — the terminal's hidden textarea (so the soft
 * keyboard stays open) or the compose field. Every tappable key in the bar goes
 * through this, so a future key can't accidentally omit the focus guard.
 */
function KeyButton({
  label,
  onClick,
  style,
  ariaLabel,
  ariaPressed,
}: {
  label: React.ReactNode;
  onClick: () => void;
  style?: React.CSSProperties;
  ariaLabel?: string;
  ariaPressed?: boolean;
}) {
  // Every bar key unconditionally keeps focus (the soft keyboard must stay put).
  const keepFocus = keepFocusIf(true);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      style={style ?? S.key}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * Mobile-only terminal input chrome (feature 006): an accessory key bar pinned
 * above the soft keyboard for the meta/control keys soft keyboards lack, plus a
 * compose field that lets iPhone dictation arrive as one write.
 *
 * All delivery goes through the same-origin `term` handle (via `getWindow`) using
 * the pure injector in lib/terminalInput. The parent passes the active session
 * id; an effect resets the compose buffer and any armed Ctrl when it changes to a
 * *different* terminal, so input never carries over to another shell (while
 * surviving a transient same-session reload).
 */
export default function MobileInputChrome({ getWindow, activeSessionId }: Props) {
  const [ctrl, dispatchCtrl] = useReducer(ctrlReducer, 'idle');
  const [composeOpen, setComposeOpen] = useState(false);
  // Soft-keyboard height the bar docks above. This same inset feeds the terminal
  // surface's bottom clearance (published below as a CSS var, consumed by the
  // ttyd layer in integration.tsx) so the bar sits exactly at the terminal's new
  // bottom edge — one source of truth, no drift.
  const kbInset = useKeyboardInset();
  // Collapsed by default so the bar costs almost no screen until summoned.
  // Persisted so the choice sticks across tab switches / reloads.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('omniterm.mobileKeys.collapsed') !== 'false';
    } catch {
      return true;
    }
  });
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Publish the terminal's bottom occlusion (keyboard + the bar's own height) as
  // a CSS var that the ttyd layer in integration.tsx uses as its `bottom`, so the
  // active prompt clears BOTH the soft keyboard and this bar — not just the
  // keyboard. (The layer is absolutely positioned, so it must be lifted via its
  // own `bottom`; an ancestor's paddingBottom can't shrink it.) Collapsed, only
  // the keyboard counts (the launcher is a small corner toggle, left to float
  // over the terminal). Expanded, the full-width bar is added via its measured
  // height. ResizeObserver keeps it correct as the bar grows (compose row, armed
  // Ctrl letter strip, wrapping). useLayoutEffect + the cleanup that clears the
  // var keep the terminal's inset in lockstep with the bar across every change.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const publish = () => {
      const barH = collapsed ? 0 : (containerRef.current?.offsetHeight ?? 0);
      root.style.setProperty('--omniterm-terminal-bottom-inset', `${kbInset + barH}px`);
    };
    publish();
    let ro: ResizeObserver | undefined;
    if (!collapsed && containerRef.current && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(publish);
      ro.observe(containerRef.current);
    }
    return () => ro?.disconnect();
    // composeOpen/ctrl are deps not because the observer needs them (it catches
    // the resulting height change on its own) but so the synchronous publish()
    // above runs in the SAME commit those rows mount — without them the inset
    // would lag the bar's new height by one observer tick (a one-frame occlusion
    // of the bottom row). collapsed gates the observer; kbInset feeds the value.
  }, [collapsed, composeOpen, ctrl, kbInset]);

  // Clear the inset when the bar unmounts (e.g. leaving the terminal tab) so a
  // stale value can't keep padding a terminal that no longer has this bar.
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty('--omniterm-terminal-bottom-inset');
    },
    [],
  );

  useEffect(() => {
    try {
      localStorage.setItem('omniterm.mobileKeys.collapsed', String(collapsed));
    } catch {
      // storage unavailable (private mode) — non-fatal
    }
  }, [collapsed]);

  // Reset transient input when the user switches to a DIFFERENT terminal, so a
  // half-typed line or an armed Ctrl never carries over to another shell. A
  // transient null (session reloading) is ignored, so input survives a brief
  // load gap on the same terminal.
  const lastSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeSessionId == null) return;
    const prev = lastSessionRef.current;
    if (prev != null && prev !== activeSessionId) {
      setComposeOpen(false);
      if (composeRef.current) composeRef.current.value = '';
      dispatchCtrl('clear');
    }
    lastSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  const onCtrlLetter = (letter: string) => {
    sendControlLetter(getWindow(), letter);
    dispatchCtrl('consume');
  };

  const onSend = (run: boolean) => {
    const field = composeRef.current;
    if (!field) return;
    if (sendComposed(getWindow(), field.value, run)) {
      field.value = '';
      field.focus(); // keep the field ready for the next line
    }
  };

  // Collapsed: a single launcher sitting at the same spot as the expanded bar's
  // left edge (same left + safe-area offset), so it toggles in place.
  if (collapsed) {
    // Toggling the bar must not change the soft-keyboard state. When a keyboard
    // is up (kbInset>0 ⇒ the terminal textarea holds focus), suppress focus theft
    // so opening the bar leaves it up. When it's down, allow the normal tap — an
    // unconditional preventDefault here can swallow the first tap, and there's no
    // focus worth keeping. One handler, shared by both pointer- and mouse-down.
    const keepKeyboard = keepFocusIf(kbInset > 0);
    return (
      <div
        style={{
          ...S.launcherWrap,
          bottom: `calc(${kbInset}px + env(safe-area-inset-bottom, 0px) + 6px)`,
          // Dim while the active session is still loading — taps no-op until ready.
          opacity: activeSessionId == null ? 0.4 : 1,
        }}
      >
        <button
          type="button"
          aria-label="Show terminal keys (Esc, Ctrl, arrows, dictate)"
          style={S.collapseBtn}
          onPointerDown={keepKeyboard}
          onMouseDown={keepKeyboard}
          onClick={() => setCollapsed(false)}
        >
          »
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        ...S.container,
        bottom: kbInset,
        // Dim while the active session is still loading — taps no-op until ready.
        opacity: activeSessionId == null ? 0.4 : 1,
      }}
    >
      {composeOpen && (
        <div style={S.composeRow}>
          <textarea
            ref={composeRef}
            // UNCONTROLLED on purpose: the field must own its own value so iOS
            // dictation revises in place (it re-sends the whole cumulative
            // transcription expecting replacement). A controlled `value` would
            // make React own the value and reintroduce the duplication this
            // field exists to fix. Read/clear via the ref in onSend.
            defaultValue=""
            placeholder="Dictate or type a line, then send…"
            rows={1}
            // predictive text off so it can't silently alter commands.
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoComplete="off"
            style={S.compose}
            onKeyDown={(e) => {
              // isComposing guard: the Enter that commits an IME / dictation
              // composition must not submit a half-composed line.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend(true);
              }
            }}
          />
          {/* Send buttons keep focus on the textarea so the soft keyboard stays
              up across consecutive sends (same guard as the keys). */}
          <KeyButton label="Send" ariaLabel="Send to terminal" onClick={() => onSend(false)} style={S.sendBtn} />
          <KeyButton label="⏎" ariaLabel="Send and run" onClick={() => onSend(true)} style={S.sendRunBtn} />
        </div>
      )}

      <div style={S.barWrap}>
        {/* Collapse back to the launcher icon. */}
        <KeyButton
          label="«"
          ariaLabel="Hide terminal keys"
          onClick={() => setCollapsed(true)}
          style={S.collapseBtn}
        />

        {/* Compose/dictate toggle — pinned at the front so it's always visible.
            Intentionally NOT a KeyButton: it must move focus into the textarea
            (KeyButton's preventDefault would block that), and it mounts the field
            synchronously then focuses it within this same tap so iOS raises the
            keyboard on the first tap (a deferred focus won't). */}
        <button
          type="button"
          aria-label="Compose or dictate a line, then send"
          aria-pressed={composeOpen}
          style={composeOpen ? S.accent : S.composeToggle}
          onClick={() => {
            if (composeOpen) {
              setComposeOpen(false);
              return;
            }
            flushSync(() => setComposeOpen(true));
            composeRef.current?.focus();
          }}
        >
          💬
        </button>

        <div style={S.barRow}>
          <KeyButton
            label="Ctrl"
            ariaLabel="Ctrl modifier"
            ariaPressed={ctrl === 'armed'}
            style={ctrl === 'armed' ? S.accent : S.key}
            onClick={() => dispatchCtrl('toggle')}
          />

          {/* While armed, the bar shows an a–z strip; tap a letter to send its
              control byte. Disarm by tapping Ctrl again. */}
          {ctrl === 'armed'
            ? CTRL_LETTERS.map((letter) => (
                <KeyButton
                  key={letter}
                  label={letter}
                  ariaLabel={`Control ${letter}`}
                  onClick={() => onCtrlLetter(letter)}
                />
              ))
            : KEY_BAR.map((descriptor: KeyDescriptor) => (
                <KeyButton
                  key={descriptor.id}
                  label={descriptor.label}
                  ariaLabel={descriptor.ariaLabel}
                  onClick={() => sendDescriptor(getWindow(), descriptor)}
                />
              ))}
        </div>
      </div>
    </div>
  );
}

// 44px min touch target (Apple HIG 44pt / Material 48dp; comfortably ≥ WCAG 2.5.8).
const keyBase: React.CSSProperties = {
  flex: '0 0 auto',
  minWidth: 44,
  height: 44,
  padding: '0 12px',
  fontSize: 16,
  lineHeight: '44px',
  border: '1px solid var(--border, #333)',
  borderRadius: 6,
  background: 'var(--bg-secondary, #2a2a2a)',
  color: 'var(--text, #ddd)',
  cursor: 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  textAlign: 'center',
};

// Filled accent state shared by the armed Ctrl, the active 💬 toggle, and ⏎.
const accentKey: React.CSSProperties = {
  ...keyBase,
  background: 'var(--accent, #094771)',
  borderColor: 'var(--accent, #094771)',
  color: '#fff',
};

// Above the terminal surface, below the app's modal layer (page.tsx uses
// backdrop 50 / workspaces overlay 51 / ConfirmDialog 200) — so the bar sits
// over the terminal but never above a dialog.
const BAR_Z = 100;

const S: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    left: 0,
    right: 0,
    zIndex: BAR_Z,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 6,
    paddingBottom: 'calc(6px + env(safe-area-inset-bottom, 0px))',
    background: 'var(--bg, #1e1e1e)',
    borderTop: '1px solid var(--border, #333)',
  },
  launcherWrap: {
    position: 'fixed',
    left: 6, // matches the expanded bar's inner-content left edge (container padding)
    zIndex: BAR_Z,
  },
  collapseBtn: {
    ...keyBase,
    color: 'var(--text-muted, #888)',
  },
  barWrap: {
    display: 'flex',
    gap: 6,
    alignItems: 'stretch',
    minWidth: 0,
  },
  barRow: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    gap: 6,
    overflowX: 'auto',
    whiteSpace: 'nowrap',
  },
  composeToggle: {
    ...keyBase,
    borderColor: 'var(--accent, #094771)',
    color: 'var(--accent, #6ea8e6)',
  },
  accent: accentKey,
  key: keyBase,
  composeRow: { display: 'flex', gap: 6, alignItems: 'stretch' },
  compose: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    resize: 'none',
    fontSize: 16,
    padding: '8px 10px',
    border: '1px solid var(--border, #333)',
    borderRadius: 6,
    background: 'var(--bg-secondary, #2a2a2a)',
    color: 'var(--text, #ddd)',
    fontFamily: 'inherit',
  },
  sendBtn: { ...keyBase, height: 'auto', lineHeight: '1.2', minWidth: 56 },
  sendRunBtn: { ...accentKey, height: 'auto', lineHeight: '1.2', minWidth: 48 },
};
