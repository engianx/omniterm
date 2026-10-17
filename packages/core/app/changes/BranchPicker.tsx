'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { emit } from '../events';
import { filterBranches } from './changeRows';
import { gitPost } from './gitStore';
import { CheckIcon, PlusIcon } from './icons';

interface LocalBranch {
  name: string;
  /** Checked out in another worktree. */
  worktreePath: string | null;
}

interface Branches {
  current: string;
  local: LocalBranch[];
  remote: string[];
}

interface Props {
  cwd: string;
  /** Repo root (`/api/git/info` root): the worktree a new one is made from. */
  root: string;
  /** Viewport rect of the status-bar item the popover opens above. */
  anchor: DOMRect;
  onClose: () => void;
}

type Mode = 'switch' | 'create' | 'worktree';

const PLACEHOLDER: Record<Mode, string> = {
  switch: 'Switch to branch…',
  create: 'New branch name',
  worktree: 'Branch for the new worktree…',
};

/**
 * Popover over the status bar's branch item: filter + switch local branches,
 * jump to a branch's worktree, create a branch, or open a branch as a new
 * worktree workspace.
 */
export default function BranchPicker({ cwd, root, anchor, onClose }: Props) {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('switch');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (res.ok) setBranches(data as Branches);
        else setError((data as { error?: string }).error ?? 'Could not list branches');
      })
      .catch(() => !cancelled && setError('Could not list branches'));
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => inputRef.current?.focus(), [mode]);

  const visible = useMemo(() => {
    if (!branches) return [];
    // A worktree can only be made from a branch nobody has checked out.
    const pool =
      mode === 'worktree'
        ? branches.local.filter((b) => b.name !== branches.current && !b.worktreePath)
        : branches.local;
    return mode === 'create' ? [] : filterBranches(pool, query);
  }, [branches, mode, query]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function pick(b: LocalBranch) {
    if (busy) return;
    if (mode === 'worktree') {
      void run(async () => {
        const res = await fetch('/api/workspaces/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: root, branch: b.name, newBranch: false }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data as { error?: string }).error ?? `Could not create worktree (${res.status})`);
        emit('omniterm:open-workspace', { path: (data as { path: string }).path });
      });
    } else if (b.worktreePath) {
      emit('omniterm:open-workspace', { path: b.worktreePath });
      onClose();
    } else if (b.name === branches?.current) {
      onClose();
    } else {
      void run(() => gitPost('checkout', cwd, { branch: b.name }).then(() => {}));
    }
  }

  function submit() {
    if (mode === 'create') {
      const name = query.trim();
      if (name) void run(() => gitPost('checkout', cwd, { branch: name, create: true }).then(() => {}));
    } else if (visible.length > 0) {
      pick(visible[0]);
    }
  }

  return createPortal(
    <>
      <div style={S.backdrop} onClick={onClose} />
      <div
        role="dialog"
        aria-label="Branches"
        style={{
          ...S.popover,
          left: Math.max(4, Math.min(anchor.left, window.innerWidth - 324)),
          bottom: window.innerHeight - anchor.top + 4,
        }}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder={PLACEHOLDER[mode]}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') {
              if (mode === 'switch') onClose();
              else setMode('switch');
            }
          }}
          style={S.input}
          aria-label={PLACEHOLDER[mode]}
        />
        {error && <div style={S.error}>{error}</div>}
        <div style={S.list}>
          {!branches && !error && <div style={S.hint}>Loading…</div>}
          {mode === 'create' && <div style={S.hint}>Enter to create and switch.</div>}
          {visible.map((b) => (
            <button key={b.name} className="ot-menu-item" disabled={busy} onClick={() => pick(b)} style={S.item}>
              <span style={S.mark}>{b.name === branches?.current && mode === 'switch' && <CheckIcon size={12} />}</span>
              <span style={S.branchName}>{b.name}</span>
              {b.worktreePath && mode === 'switch' && (
                <span style={S.dim} title={b.worktreePath}>
                  worktree
                </span>
              )}
            </button>
          ))}
          {branches && mode !== 'create' && visible.length === 0 && <div style={S.hint}>No matching branches</div>}
        </div>
        {mode === 'switch' && (
          <div style={S.actions}>
            <button className="ot-menu-item" onClick={() => setMode('create')} style={S.item}>
              <span style={S.mark}>
                <PlusIcon size={12} />
              </span>
              Create branch…
            </button>
            <button className="ot-menu-item" onClick={() => setMode('worktree')} style={S.item}>
              <span style={S.mark}>
                <PlusIcon size={12} />
              </span>
              New worktree from branch…
            </button>
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
  },
  popover: {
    position: 'fixed',
    zIndex: 1001,
    width: 320,
    maxWidth: 'calc(100vw - 8px)',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    padding: '6px 0',
    fontSize: '12px',
  },
  input: {
    margin: '0 6px 6px',
    fontSize: '12px',
  },
  list: {
    maxHeight: 260,
    overflowY: 'auto',
  },
  item: {
    padding: '4px 10px',
  },
  mark: {
    display: 'inline-flex',
    width: 12,
    flexShrink: 0,
  },
  branchName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  dim: {
    color: 'var(--text-muted)',
    fontSize: '11px',
  },
  hint: {
    padding: '4px 10px',
    color: 'var(--text-muted)',
  },
  error: {
    padding: '0 10px 6px',
    color: 'var(--danger-hover)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  actions: {
    borderTop: '1px solid var(--border)',
    marginTop: 4,
    paddingTop: 4,
  },
};
