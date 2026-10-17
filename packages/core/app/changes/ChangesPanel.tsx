'use client';

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import ConfirmDialog from '../components/ConfirmDialog';
import { emit } from '../events';
import {
  changeGroups,
  rowPaths,
  statusColor,
  statusLetter,
  statusTitle,
  type ChangeRow,
  type GitChanges,
} from './changeRows';
import { gitPost } from './gitStore';
import { CheckIcon, DiscardIcon, MinusIcon, OpenFileIcon, PlusIcon, RevealIcon } from './icons';

interface Props {
  /** The workspace path (any path inside the repo). */
  cwd: string;
  changes: GitChanges | null;
  isMobile: boolean;
  closeSidebar: () => void;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Source-control-lite: a commit box plus "Staged" and "Changes" groups.
 * Push/pull/fetch are left to the terminal.
 */
export default function ChangesPanel({ cwd, changes, isMobile, closeSidebar }: Props) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<ChangeRow | null>(null);

  const groups = useMemo(() => (changes ? changeGroups(changes) : null), [changes]);
  const canCommit = !busy && message.trim() !== '' && (groups?.staged.length ?? 0) > 0;

  async function mutate(route: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await gitPost(route, cwd, body);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!canCommit) return;
    if (await mutate('commit', { message })) setMessage('');
  }

  function open(r: ChangeRow) {
    if (!changes) return;
    emit('omniterm:open-file', {
      path: `${changes.root}/${r.path}`,
      diff: r.staged ? 'staged' : 'worktree',
    });
    if (isMobile) closeSidebar();
  }

  function openSource(r: ChangeRow) {
    if (!changes) return;
    emit('omniterm:open-file', { path: `${changes.root}/${r.path}` });
    if (isMobile) closeSidebar();
  }

  function reveal(r: ChangeRow) {
    if (!changes) return;
    emit('omniterm:reveal-file', { path: `${changes.root}/${r.path}` });
  }

  const stageAll = (rows: ChangeRow[]) => void mutate('stage', { paths: rows.flatMap(rowPaths) });
  const unstageAll = (rows: ChangeRow[]) => void mutate('unstage', { paths: rows.flatMap(rowPaths) });

  const renderRow = (r: ChangeRow) => (
    <div
      key={r.key}
      className="ot-change-row"
      role="button"
      tabIndex={0}
      title={`${r.path}\n${statusTitle(r)}`}
      onClick={() => open(r)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(r);
      }}
    >
      <span style={S.name}>{r.name}</span>
      {r.dir && <span style={S.dir}>{r.dir}</span>}
      <span className="ot-change-actions" onClick={(e) => e.stopPropagation()}>
        {/* A deleted file has nothing on disk to open or reveal. */}
        {r.status !== 'D' && (
          <>
            <button className="ot-change-act" title="Open file" aria-label="Open file" onClick={() => openSource(r)}>
              <OpenFileIcon size={14} />
            </button>
            <button className="ot-change-act" title="Reveal in Files" aria-label="Reveal in Files" onClick={() => reveal(r)}>
              <RevealIcon size={14} />
            </button>
          </>
        )}
        {r.staged ? (
          <button className="ot-change-act" title="Unstage" aria-label="Unstage" disabled={busy} onClick={() => unstageAll([r])}>
            <MinusIcon size={14} />
          </button>
        ) : (
          <>
            <button
              className="ot-change-act"
              title={r.status === '?' ? 'Delete file' : 'Discard changes'}
              aria-label="Discard"
              disabled={busy}
              onClick={() => setConfirmDiscard(r)}
            >
              <DiscardIcon size={14} />
            </button>
            <button className="ot-change-act" title="Stage" aria-label="Stage" disabled={busy} onClick={() => stageAll([r])}>
              <PlusIcon size={14} />
            </button>
          </>
        )}
      </span>
      <span style={{ ...S.letter, color: statusColor(r.status) }}>{statusLetter(r.status)}</span>
    </div>
  );

  const renderGroup = (title: string, rows: ChangeRow[], staged: boolean) =>
    rows.length === 0 ? null : (
      <div style={S.group}>
        <div className="ot-change-row ot-change-group">
          <span style={S.groupTitle}>{title}</span>
          <span className="ot-change-actions">
            <button
              className="ot-change-act"
              title={staged ? 'Unstage all' : 'Stage all'}
              aria-label={staged ? 'Unstage all' : 'Stage all'}
              disabled={busy}
              onClick={() => (staged ? unstageAll(rows) : stageAll(rows))}
            >
              {staged ? <MinusIcon size={14} /> : <PlusIcon size={14} />}
            </button>
          </span>
          <span style={S.count}>{rows.length}</span>
        </div>
        {rows.map(renderRow)}
      </div>
    );

  return (
    <div style={S.container}>
      <div style={S.commitBox}>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
          placeholder={`Message (${IS_MAC ? '⌘' : 'Ctrl'}+Enter to commit)`}
          rows={message.includes('\n') ? 4 : 2}
          style={S.textarea}
          aria-label="Commit message"
        />
        <button
          className="ot-commit-btn"
          disabled={!canCommit}
          onClick={() => void commit()}
          title={groups && groups.staged.length === 0 ? 'Stage changes to commit' : 'Commit staged changes'}
        >
          <CheckIcon size={14} />
          Commit
        </button>
        {error && <div style={S.error}>{error}</div>}
      </div>
      <div style={S.list}>
        {!groups ? null : groups.staged.length === 0 && groups.changes.length === 0 ? (
          <div style={S.empty}>No changes</div>
        ) : (
          <>
            {renderGroup('Staged', groups.staged, true)}
            {renderGroup('Changes', groups.changes, false)}
          </>
        )}
      </div>
      {confirmDiscard &&
        createPortal(
          <ConfirmDialog
            title={confirmDiscard.status === '?' ? 'Delete File' : 'Discard Changes'}
            message={
              confirmDiscard.status === '?'
                ? `Delete untracked file "${confirmDiscard.path}"? This cannot be undone.`
                : `Discard unstaged changes to "${confirmDiscard.path}"? This cannot be undone.`
            }
            buttons={[
              {
                label: confirmDiscard.status === '?' ? 'Delete' : 'Discard',
                danger: true,
                action: async () => {
                  await mutate('discard', { paths: [confirmDiscard.path] });
                },
              },
              { label: 'Cancel', action: () => {} },
            ]}
            onClose={() => setConfirmDiscard(null)}
          />,
          document.body,
        )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  commitBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  textarea: {
    width: '100%',
    resize: 'vertical',
    minHeight: 40,
    padding: '4px 8px',
    border: '1px solid var(--border)',
    borderRadius: 3,
    background: 'var(--bg)',
    color: 'var(--text)',
    font: 'inherit',
    fontSize: '12px',
    outline: 'none',
  },
  error: {
    color: 'var(--danger-hover)',
    fontSize: '11px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 120,
    overflow: 'auto',
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '4px 0',
  },
  group: {
    marginBottom: 4,
  },
  groupTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  count: {
    minWidth: 16,
    padding: '0 4px',
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    fontSize: '10px',
    lineHeight: '16px',
    textAlign: 'center',
    color: 'var(--text)',
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  dir: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'var(--text-muted)',
    fontSize: '11px',
  },
  letter: {
    width: 14,
    marginLeft: 'auto',
    flexShrink: 0,
    textAlign: 'center',
    fontSize: '11px',
    fontWeight: 600,
  },
  empty: {
    padding: '12px 16px',
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
};
