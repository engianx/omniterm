'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SidebarPanel } from '../types';
import { ResizeHandle, type DragInfo } from './ResizeHandle';
import { BranchIcon, CloseIcon } from './icons';

export const WORKSPACES_SECTION = 'workspaces';

interface Props {
  /** Effective mode: narrow viewports always pass 'overlay'. */
  mode: 'docked' | 'overlay';
  open: boolean;
  isMobile: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /** Hide the sidebar (docked: collapse; overlay: dismiss). */
  onClose: () => void;
  /** Selected section id; an unknown id (plugin not loaded) shows Workspaces. */
  section: string;
  onSectionChange: (id: string) => void;
  /** The built-in Workspaces section. */
  workspaces: ReactNode;
  /** Header actions shown while Workspaces is selected. */
  workspacesActions?: ReactNode;
  /** Integration-contributed sections (e.g. the file tree). */
  panels: ReadonlyArray<SidebarPanel>;
}

const MIN_WIDTH = 200;

/**
 * The left sidebar: a section switcher ([Workspaces] [Files] …), the selected
 * section's body, and the docked / overlay / mobile-full-screen chrome around
 * it. Sections stay mounted once visited (and while the sidebar is hidden) so
 * a file tree keeps its expansion and scroll state.
 */
export default function Sidebar({
  mode,
  open,
  isMobile,
  width,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
  onClose,
  section,
  onSectionChange,
  workspaces,
  workspacesActions,
  panels,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const activeId =
    section === WORKSPACES_SECTION || !panels.some((p) => p.id === section)
      ? WORKSPACES_SECTION
      : section;

  // Mount lazily, then keep alive.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([activeId]));
  useEffect(() => {
    if (!open) return;
    setVisited((prev) => (prev.has(activeId) ? prev : new Set(prev).add(activeId)));
  }, [activeId, open]);

  const handleDrag = useCallback(
    ({ x }: DragInfo) => {
      const el = rootRef.current;
      if (!el) return;
      const left = el.getBoundingClientRect().left;
      const max = window.innerWidth - left - 200;
      onWidthChange(Math.min(max, Math.max(MIN_WIDTH, x - left)));
    },
    [onWidthChange],
  );

  // Docked: closing hides the column. Overlay/mobile: the panel asked to get
  // out of the way (e.g. a file was opened), so dismiss.
  const closeSidebar = useCallback(() => {
    if (mode === 'overlay') onClose();
  }, [mode, onClose]);

  const sections: Array<{ id: string; label: string; icon: ReactNode; badge?: number }> = [
    { id: WORKSPACES_SECTION, label: 'Workspaces', icon: <BranchIcon size={16} /> },
    ...panels.map((p) => ({ id: p.id, label: p.label, icon: p.icon, badge: p.badge })),
  ];

  const header = (
    <div style={S.header}>
      <div role="tablist" aria-label="Sidebar sections" style={S.switcher}>
        {sections.map((s) => {
          const selected = s.id === activeId;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={selected}
              className="ot-section-btn"
              title={s.label}
              onClick={() => onSectionChange(s.id)}
            >
              <span style={S.sectionIcon}>{s.icon}</span>
              {/* Inactive sections collapse to their icon to keep the row short. */}
              {(selected || isMobile) && <span style={S.sectionLabel}>{s.label}</span>}
              {s.badge !== undefined && s.badge > 0 && (
                <span style={S.badge} aria-label={`${s.badge} pending`}>
                  {s.badge > 999 ? '999+' : s.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div style={S.actions}>{activeId === WORKSPACES_SECTION && workspacesActions}</div>
      <button
        className="ot-icon-btn"
        onClick={onClose}
        // Docked on desktop, the top bar's sidebar toggle sits right beside
        // this; one control per action.
        style={mode === 'docked' && !isMobile ? { display: 'none' } : undefined}
        title={mode === 'docked' ? 'Hide sidebar' : 'Close sidebar'}
        aria-label={mode === 'docked' ? 'Hide sidebar' : 'Close sidebar'}
      >
        {isMobile ? (
          <CloseIcon size={16} />
        ) : (
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        )}
      </button>
    </div>
  );

  const body = (
    <div style={S.body}>
      {(visited.has(WORKSPACES_SECTION) || activeId === WORKSPACES_SECTION) && (
        <div style={{ ...S.section, display: activeId === WORKSPACES_SECTION ? 'flex' : 'none' }}>
          {workspaces}
        </div>
      )}
      {panels.map((p) =>
        visited.has(p.id) || activeId === p.id ? (
          <div key={p.id} style={{ ...S.section, display: activeId === p.id ? 'flex' : 'none' }}>
            {p.render({ isMobile, closeSidebar })}
          </div>
        ) : null,
      )}
    </div>
  );

  const content = (
    <>
      {header}
      {body}
    </>
  );

  if (mode === 'docked') {
    return (
      <div
        ref={rootRef}
        style={{ ...S.docked, width: `${width}px`, display: open ? 'flex' : 'none' }}
        aria-label="Sidebar"
      >
        {content}
        <ResizeHandle
          axis="x"
          variant="edge"
          style={{ right: -3 }}
          onStart={onResizeStart}
          onDrag={handleDrag}
          onEnd={onResizeEnd}
        />
      </div>
    );
  }

  return (
    <>
      {open && !isMobile && <div style={S.backdrop} onClick={onClose} />}
      <div
        ref={rootRef}
        style={{
          ...(isMobile ? S.overlayMobile : { ...S.overlay, width: `${width}px` }),
          display: open ? 'flex' : 'none',
        }}
        aria-label="Sidebar"
      >
        {content}
        {!isMobile && (
          <ResizeHandle
            axis="x"
            variant="edge"
            style={{ right: -3 }}
            onStart={onResizeStart}
            onDrag={handleDrag}
            onEnd={onResizeEnd}
          />
        )}
      </div>
    </>
  );
}

const column: React.CSSProperties = {
  flexDirection: 'column',
  background: 'var(--bg-secondary)',
  minWidth: 0,
};

const S: Record<string, React.CSSProperties> = {
  docked: {
    ...column,
    position: 'relative',
    flexShrink: 0,
    height: '100%',
    borderRight: '1px solid var(--border)',
  },
  overlay: {
    ...column,
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    zIndex: 51,
    borderRight: '1px solid var(--border)',
    boxShadow: '4px 0 16px rgba(0,0,0,0.5)',
  },
  overlayMobile: {
    ...column,
    position: 'fixed',
    inset: 0,
    zIndex: 51,
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    zIndex: 50,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    height: 'var(--tab-height)',
    flexShrink: 0,
    borderBottom: '1px solid var(--border)',
    overflow: 'hidden',
  },
  switcher: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    overflow: 'hidden',
  },
  sectionIcon: {
    display: 'flex',
    width: '16px',
    height: '16px',
  },
  sectionLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  badge: {
    minWidth: '16px',
    height: '16px',
    padding: '0 4px',
    borderRadius: '8px',
    background: 'var(--bg-tertiary)',
    color: 'var(--text)',
    fontSize: '10px',
    fontWeight: 600,
    lineHeight: '16px',
    letterSpacing: 0,
    textAlign: 'center',
    flexShrink: 0,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    marginLeft: 'auto',
    flexShrink: 0,
  },
  body: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  section: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'column',
    overflow: 'hidden',
  },
};
