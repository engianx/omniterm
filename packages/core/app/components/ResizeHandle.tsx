import { useCallback, useEffect, useRef } from 'react';
import styles from './ResizeHandle.module.css';

export interface DragInfo {
  /** Pointer client X. */
  x: number;
  /** Pointer client Y. */
  y: number;
  /** Delta from drag start in client X. */
  dx: number;
  /** Delta from drag start in client Y. */
  dy: number;
}

export interface UseResizeDragOptions {
  axis: 'x' | 'y';
  onStart?: (info: { x: number; y: number }) => void;
  onDrag: (info: DragInfo) => void;
  onEnd?: () => void;
}

/**
 * Pointer-Events-based drag primitive. Handles mouse, touch, and stylus
 * via a single code path; coalesces moves into rAF; sets body cursor +
 * disables text selection while dragging. Caller owns the math from
 * pointer position → panel size.
 */
export function useResizeDrag({ axis, onStart, onDrag, onEnd }: UseResizeDragOptions) {
  const startRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef(0);
  const pendingRef = useRef<DragInfo | null>(null);
  // Holds the active drag's teardown fn while a drag is in progress;
  // null otherwise. Letting the unmount cleanup invoke this guarantees
  // we release pointer capture and remove listeners even if the host
  // unmounts mid-drag — a queued onDrag firing against a torn-down
  // owner is otherwise possible because setPointerCapture keeps
  // dispatching pointer events to the (now-detached) element.
  const endRef = useRef<(() => void) | null>(null);

  useEffect(() => () => endRef.current?.(), []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      startRef.current = { x: e.clientX, y: e.clientY };
      onStart?.({ x: e.clientX, y: e.clientY });
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const move = (ev: PointerEvent) => {
        pendingRef.current = {
          x: ev.clientX,
          y: ev.clientY,
          dx: ev.clientX - startRef.current.x,
          dy: ev.clientY - startRef.current.y,
        };
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          const info = pendingRef.current;
          pendingRef.current = null;
          if (info) onDrag(info);
        });
      };

      const end = () => {
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', end);
        target.removeEventListener('pointercancel', end);
        cancelAnimationFrame(rafRef.current);
        pendingRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        endRef.current = null;
        onEnd?.();
      };
      endRef.current = end;

      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    },
    [axis, onStart, onDrag, onEnd],
  );

  return { onPointerDown };
}

export interface ResizeHandleProps extends UseResizeDragOptions {
  /**
   * `inline` — renders its own 1px line + padding hit area, sits in the
   * flex flow as a sibling of the panes it divides.
   *
   * `edge` — absolutely positioned overlay over a parent's existing
   * border. Parent must be `position: relative`. Pass `style` for
   * placement (`left: -3`, `right: -3`, etc.).
   */
  variant?: 'inline' | 'edge';
  /**
   * Dot-grip indicator visibility.
   *
   * - `none` — never show (default for dividers that already carry a label).
   * - `touch` — show only on touch-primary devices (default).
   * - `hover` — fade in on hover; always visible on touch.
   */
  grip?: 'none' | 'touch' | 'hover';
  /** Inline style overrides — primarily used to position `variant="edge"`. */
  style?: React.CSSProperties;
  className?: string;
}

export function ResizeHandle({
  axis,
  variant = 'inline',
  grip = 'touch',
  style,
  className,
  onStart,
  onDrag,
  onEnd,
}: ResizeHandleProps) {
  const drag = useResizeDrag({ axis, onStart, onDrag, onEnd });

  const cls = [
    styles.handle,
    axis === 'x' ? styles.handleX : styles.handleY,
    variant === 'edge' && styles.handleEdge,
    grip === 'touch' && styles.gripTouch,
    grip === 'hover' && styles.gripHover,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return <div className={cls} style={style} {...drag} />;
}
