'use client';

import { useState } from 'react';
import BranchPicker from '../changes/BranchPicker';
import { changeCount } from '../changes/changeRows';
import { useGitState } from '../changes/gitStore';
import { emit } from '../events';
import { BranchIcon } from './icons';

interface Props {
  /** Active workspace path; the bar shows nothing without one. */
  cwd: string | null;
  isMobile: boolean;
}

/**
 * Thin bottom bar: `workspace · ⎇ branch · ↑a ↓b · ±N`. The git parts only
 * appear inside a repo; the branch opens a branch picker and ±N opens the
 * Changes section. Hidden on mobile, where every row of height counts (the
 * sidebar's Changes badge carries the same signal there).
 */
export default function StatusBar({ cwd, isMobile }: Props) {
  const { info, changes } = useGitState(isMobile ? null : cwd);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (isMobile || !cwd) return null;

  const name = cwd.replace(/\/+$/, '').split('/').pop() || cwd;
  const count = changeCount(changes);
  const sep = <span style={S.sep}>·</span>;

  return (
    <div style={S.bar} role="status" aria-label="Status bar">
      <span style={S.item} title={cwd}>
        {name}
      </span>
      {info?.isRepo && info.root && (
        <>
          {sep}
          <button
            className="ot-status-item"
            title={info.detached ? 'Detached HEAD — switch branch' : 'Switch branch'}
            onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
          >
            <BranchIcon size={12} />
            <span style={S.text}>{info.detached ? 'detached' : info.branch}</span>
          </button>
          {(info.ahead > 0 || info.behind > 0) && (
            <>
              {sep}
              <span style={S.item} title={`${info.ahead} ahead, ${info.behind} behind ${info.upstream}`}>
                ↑{info.ahead} ↓{info.behind}
              </span>
            </>
          )}
          {sep}
          <button
            className="ot-status-item"
            title={`${count} changed file${count === 1 ? '' : 's'}`}
            onClick={() => emit('omniterm:show-sidebar', { section: 'changes' })}
          >
            ±{count}
          </button>
          {anchor && (
            <BranchPicker cwd={cwd} root={info.root} anchor={anchor} onClose={() => setAnchor(null)} />
          )}
        </>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    height: 22,
    flexShrink: 0,
    padding: '0 6px',
    gap: 2,
    borderTop: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-muted)',
    fontSize: '11px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  item: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
    padding: '0 4px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  text: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  sep: {
    opacity: 0.6,
  },
};
