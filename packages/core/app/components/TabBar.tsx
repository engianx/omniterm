'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Tab } from '../types';

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  alertedTabIds?: Set<string>;
  leftAction?: React.ReactNode;
  rightAction?: React.ReactNode;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  /**
   * When two or more entries are present, the [+] becomes a dropdown
   * instead of a single button. The first entry is always created by
   * `onCreate` (the host's default — typically a new terminal); plugins
   * contribute the rest. Each entry's `onSelect` is responsible for
   * spawning backend state and surfacing the tab via the host's API.
   */
  createMenu?: ReadonlyArray<{ label: string; onSelect: () => void }>;
  onRename: (tabId: string, name: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

export default function TabBar({
  tabs,
  activeTabId,
  alertedTabIds,
  leftAction,
  rightAction,
  onSelect,
  onClose,
  onCreate,
  createMenu,
  onRename,
  onReorder,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position the dropdown directly under the [+] button. We portal the
  // menu to document.body to escape the tab bar's `overflow: hidden`,
  // so absolute coordinates are needed.
  useLayoutEffect(() => {
    if (!menuOpen || !addBtnRef.current) {
      setMenuPos(null);
      return;
    }
    const r = addBtnRef.current.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 2, left: r.left });
  }, [menuOpen]);

  // [+] behavior:
  //   - 0 entries (or no createMenu at all): legacy `onCreate` is invoked.
  //   - 1 entry: clicking [+] spawns that single tab type directly (no menu).
  //   - 2+ entries: clicking [+] opens a dropdown listing every entry.
  // The host puts Terminal first in createMenu, so a vanilla install picks
  // Terminal on click; with plugins contributing Agent etc., the user gets
  // a chooser with Terminal at the top.
  const menuLength = createMenu?.length ?? 0;
  const showDropdown = menuLength >= 2;
  const handleAddClick = () => {
    if (showDropdown) {
      setMenuOpen((v) => !v);
      return;
    }
    if (createMenu && menuLength === 1) {
      createMenu[0].onSelect();
      return;
    }
    onCreate();
  };
  const addTitle = showDropdown
    ? 'New tab'
    : menuLength === 1
      ? `New ${createMenu![0].label.toLowerCase()}`
      : 'New terminal';

  // Close the [+] dropdown on outside click / Escape / window resize.
  // The portal'd menu reads the [+] button's position once on open;
  // a resize would leave it positioned stale, so close instead.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addBtnRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onResize = () => setMenuOpen(false);
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);

  const startRename = (tab: Tab) => {
    setEditingId(tab.id);
    setEditValue(tab.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div style={styles.container}>
      {leftAction}
      <div style={styles.tabs} role="tablist">
        {tabs.map((tab, i) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            draggable={editingId !== tab.id}
            onDragStart={(e) => {
              setDragIndex(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropIndex(i);
            }}
            onDragLeave={() => setDropIndex(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null && dragIndex !== i) {
                onReorder(dragIndex, i);
              }
              setDragIndex(null);
              setDropIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setDropIndex(null);
            }}
            style={{
              ...styles.tab,
              background: tab.id === activeTabId ? 'var(--tab-active)' : 'var(--tab-inactive)',
              borderBottom:
                tab.id === activeTabId ? '2px solid var(--link)' : '2px solid transparent',
              opacity: dragIndex === i ? 0.4 : 1,
              borderLeft:
                dropIndex === i && dragIndex !== null && dragIndex !== i
                  ? '2px solid var(--link)'
                  : 'none',
            }}
            onClick={() => onSelect(tab.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename(tab);
            }}
            title={`${tab.name} — drag to reorder, double-click to rename`}
          >
            {editingId === tab.id ? (
              <input
                ref={inputRef}
                style={styles.renameInput}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
              />
            ) : (
              <>
                {alertedTabIds?.has(tab.id) && tab.id !== activeTabId && (
                  <span style={styles.alertDot} />
                )}
                <span style={styles.tabLabel}>{tab.name}</span>
              </>
            )}
            <button
              style={styles.closeBtn}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        ))}
        <div style={{ position: 'relative', marginLeft: '8px' }}>
          <button ref={addBtnRef} style={styles.addBtn} onClick={handleAddClick} title={addTitle}>
            +
          </button>
        </div>
      </div>
      {rightAction}
      {showDropdown &&
        menuOpen &&
        menuPos &&
        createPortal(
          <div ref={menuRef} style={{ ...styles.addMenu, top: menuPos.top, left: menuPos.left }}>
            {createMenu!.map((opt) => (
              <div
                key={opt.label}
                style={styles.addMenuItem}
                onClick={() => {
                  setMenuOpen(false);
                  opt.onSelect();
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'var(--accent, #1f6feb)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                }}
              >
                {opt.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    height: 'var(--tab-height)',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    overflow: 'hidden',
  },
  tabs: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    height: 'var(--tab-height)',
    cursor: 'grab',
    whiteSpace: 'nowrap',
    gap: '6px',
    borderRight: '1px solid var(--border)',
    userSelect: 'none',
    transition: 'opacity 0.15s',
  },
  tabLabel: {
    fontSize: '12px',
  },
  alertDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--warning, #d29922)',
    flexShrink: 0,
  },
  renameInput: {
    fontSize: '12px',
    width: '80px',
    padding: '1px 4px',
    background: 'var(--bg)',
    border: '1px solid var(--link)',
    color: 'var(--text)',
    borderRadius: '2px',
    outline: 'none',
    fontFamily: 'inherit',
  },
  closeBtn: {
    fontSize: '14px',
    lineHeight: 1,
    padding: '0 2px',
    borderRadius: '3px',
    color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  addBtn: {
    padding: '0 14px',
    height: 'var(--tab-height)',
    color: 'var(--text-muted)',
    fontSize: '20px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    cursor: 'pointer',
    lineHeight: 1,
    background: 'none',
    border: 'none',
  },
  addMenu: {
    position: 'fixed',
    minWidth: '140px',
    background: 'var(--bg-secondary, #161b22)',
    border: '1px solid var(--border, #30363d)',
    borderRadius: '4px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    padding: '4px 0',
    zIndex: 1000,
  },
  addMenuItem: {
    padding: '6px 14px',
    fontSize: '13px',
    color: 'var(--text)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};
