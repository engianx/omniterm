'use client';

import { useState } from 'react';

export type FileTabKind = 'source' | 'preview';

export interface FileTabInfo {
  /** Composite tab id: "${kind}::${path}". Stable across renders. */
  id: string;
  path: string;
  kind: FileTabKind;
  isDirty: boolean;
}

interface Props {
  tabs: ReadonlyArray<FileTabInfo>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Open the file-tab context menu at the given client coordinates. */
  onContextMenu?: (clientX: number, clientY: number, tab: FileTabInfo) => void;
}

/**
 * Compute display labels for tabs, mirroring VS Code editor-tab behaviour.
 *
 * If a tab's basename is unique among the open tabs, just the basename is
 * used. When multiple tabs share a basename, each one gets the shortest
 * trailing-ancestor suffix that disambiguates within that group:
 *   - `a/lib/x.ts` vs `b/lib/x.ts`     → `x.ts — a/lib`, `x.ts — b/lib`
 *   - `src/foo/y.ts` vs `src/bar/y.ts` → `y.ts — foo`,   `y.ts — bar`
 * If the path is exhausted before uniqueness is reached (truly identical
 * paths — shouldn't happen for distinct tabs), the basename alone is used.
 *
 * Source/preview pairs of the SAME path are disambiguated separately by the
 * preview-tab marker (eye icon + tooltip), so labels are computed against
 * `path` only — matching pairs collapse to one group of two identical paths
 * and never grow a noisy ancestor suffix.
 */
function computeLabels(tabs: ReadonlyArray<FileTabInfo>): string[] {
  const result: string[] = tabs.map((t) => t.path.split('/').pop() ?? t.path);

  const groups = new Map<string, number[]>();
  tabs.forEach((t, i) => {
    const base = result[i];
    const arr = groups.get(base) ?? [];
    arr.push(i);
    groups.set(base, arr);
  });

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // Skip groups where every tab shares the same path — they're a
    // source/preview pair (or pairs) and the eye icon disambiguates them.
    const paths = idxs.map((i) => tabs[i].path);
    if (new Set(paths).size === 1) continue;
    const partsList = idxs.map((i) => tabs[i].path.split('/'));
    const maxDepth = Math.max(...partsList.map((p) => p.length - 1));
    for (let depth = 1; depth <= maxDepth; depth++) {
      const ancestors = partsList.map((p) =>
        p.slice(Math.max(0, p.length - 1 - depth), p.length - 1).join('/'),
      );
      const allUnique = new Set(ancestors).size === ancestors.length;
      if (allUnique || depth === maxDepth) {
        idxs.forEach((origIdx, k) => {
          const ancestor = ancestors[k];
          if (ancestor) result[origIdx] = `${result[origIdx]} — ${ancestor}`;
        });
        break;
      }
    }
  }

  return result;
}

const PreviewIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export default function FileTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onContextMenu,
}: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const labels = computeLabels(tabs);

  return (
    <div style={S.container} role="tablist">
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeId;
        const isPreview = tab.kind === 'preview';
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            draggable
            onDragStart={(e) => {
              setDragIndex(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropIndex(i);
            }}
            onDragLeave={(e) => {
              // dragleave fires when the pointer crosses into a child element
              // (label span, close button); guard so the drop indicator doesn't
              // flicker as the cursor moves within the tab.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDropIndex(null);
              }
            }}
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
              ...S.tab,
              background: isActive ? 'var(--tab-active)' : 'var(--tab-inactive)',
              borderBottom: isActive ? '2px solid var(--link)' : '2px solid transparent',
              opacity: dragIndex === i ? 0.4 : 1,
              borderLeft:
                dropIndex === i && dragIndex !== null && dragIndex !== i
                  ? '2px solid var(--link)'
                  : '1px solid transparent',
            }}
            onClick={() => onSelect(tab.id)}
            onContextMenu={(e) => {
              if (!onContextMenu) return;
              e.preventDefault();
              onContextMenu(e.clientX, e.clientY, tab);
            }}
            onAuxClick={(e) => {
              // Middle-click closes the tab.
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            title={isPreview ? `Preview: ${tab.path}` : tab.path}
          >
            {isPreview && (
              <span style={S.previewIcon} title="Preview">
                <PreviewIcon />
              </span>
            )}
            <span style={S.tabLabel}>{labels[i]}</span>
            <button
              style={S.closeBtn}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              title={tab.isDirty ? 'Close (unsaved changes)' : 'Close'}
            >
              {tab.isDirty ? <span style={S.dirtyDot} /> : '×'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    height: 'var(--tab-height)',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    overflow: 'auto',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px 0 12px',
    height: 'var(--tab-height)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    gap: '6px',
    borderRight: '1px solid var(--border)',
    userSelect: 'none',
    flexShrink: 0,
    transition: 'opacity 0.15s',
  },
  tabLabel: {
    fontSize: '12px',
    color: 'var(--text)',
  },
  previewIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  closeBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    fontSize: '14px',
    lineHeight: 1,
    padding: 0,
    borderRadius: '3px',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
  },
  dirtyDot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--text)',
  },
};
