'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './OpenPicker.module.css';
import { defaultCloneDestination } from '../../lib/cloneUrl';
import type { WorkspaceEntry } from './workspaceList';
import { BranchIcon, FolderIcon } from './icons';

interface Props {
  /** Tracked workspaces, offered as quick switches. */
  workspaces: WorkspaceEntry[];
  /** Track (if needed) and switch to a folder; resolves to an error message or null. */
  onOpen: (path: string) => Promise<string | null>;
  /** Clone and switch; resolves to an error message or null. */
  onClone: (url: string, destination: string) => Promise<string | null>;
  onClose: () => void;
}

type Item =
  | { kind: 'open'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'clone' }
  | { kind: 'workspace'; entry: WorkspaceEntry };

const MAX_WORKSPACES = 8;
const COMPLETE_DEBOUNCE_MS = 100;

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/**
 * Accept a completion into the input, keeping the user's spelling of the part
 * they already typed (`~/gi` + /home/me/git → `~/git/`).
 */
function acceptCompletion(query: string, dir: string): string {
  const slash = query.lastIndexOf('/');
  return slash < 0 ? `${dir}/` : `${query.slice(0, slash + 1)}${basename(dir)}/`;
}

/**
 * The "Open…" quick pick: type a path (Tab / arrows complete it from the
 * server), pick a tracked workspace, or clone a repository. Keyboard-first:
 * ↑/↓ move, Tab completes, Enter opens, Esc backs out.
 */
export default function OpenPicker({ workspaces, onOpen, onClone, onClose }: Props) {
  const [mode, setMode] = useState<'path' | 'clone'>('path');
  const [query, setQuery] = useState('~/');
  const [dirs, setDirs] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDest, setCloneDest] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode !== 'path') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/workspaces/complete?prefix=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : { dirs: [] }))
        .then((data: { dirs?: string[] }) => setDirs(data.dirs ?? []))
        .catch(() => {});
    }, COMPLETE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, mode]);

  const items = useMemo<Item[]>(() => {
    const term = query.slice(query.lastIndexOf('/') + 1).toLowerCase();
    const matches = workspaces
      .filter((w) => w.parent === null)
      .filter((w) => !term || w.path.toLowerCase().includes(term))
      .slice(0, MAX_WORKSPACES);
    return [
      ...(query.trim() ? [{ kind: 'open' as const, path: query.trim() }] : []),
      ...dirs.map((path) => ({ kind: 'dir' as const, path })),
      { kind: 'clone' as const },
      ...matches.map((entry) => ({ kind: 'workspace' as const, entry })),
    ];
  }, [query, dirs, workspaces]);

  // A new query re-anchors on the first item ("Open <typed path>").
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const run = useCallback(async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await action().catch(() => 'Could not reach the server.');
    setBusy(false);
    if (err) setError(err);
    else onClose();
  }, [onClose]);

  const activate = (item: Item) => {
    if (busy) return;
    if (item.kind === 'clone') {
      setMode('clone');
      setError(null);
      return;
    }
    const path = item.kind === 'workspace' ? item.entry.path : item.path;
    void run(() => onOpen(path));
  };

  const destination = cloneDest ?? defaultCloneDestination(cloneUrl.trim());
  const startClone = () => {
    if (busy || !cloneUrl.trim() || !destination.trim()) return;
    void run(() => onClone(cloneUrl.trim(), destination.trim()));
  };

  const onPathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((i) => (i + step + items.length) % items.length);
    } else if (e.key === 'Tab') {
      const current = items[selected];
      const dir = current?.kind === 'dir' ? current.path : dirs[0];
      // Nothing to complete: let Tab move focus as usual.
      if (!dir) return;
      e.preventDefault();
      setQuery(acceptCompletion(query, dir));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[selected];
      if (item) activate(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const onCloneKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startClone();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setMode('path');
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const inputProps = {
    autoCapitalize: 'off',
    autoCorrect: 'off',
    autoComplete: 'off',
    spellCheck: false,
    disabled: busy,
  } as const;

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={styles.picker}
        role="dialog"
        aria-label="Open workspace"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {mode === 'path' ? (
          <>
            <input
              ref={inputRef}
              className={styles.input}
              value={query}
              // Typing an absolute path over the `~/` starting point gives `~//x`:
              // read that as `/x`.
              onChange={(e) => setQuery(e.target.value.replace(/^~\/\//, '/'))}
              onKeyDown={onPathKeyDown}
              placeholder="Folder path, e.g. ~/git/project"
              aria-label="Folder path"
              aria-controls="open-picker-list"
              aria-activedescendant={`open-picker-item-${selected}`}
              autoFocus
              {...inputProps}
            />
            <div ref={listRef} id="open-picker-list" role="listbox" className={styles.list}>
              {items.map((item, i) => (
                <div
                  key={item.kind === 'workspace' ? `ws:${item.entry.path}` : `${item.kind}:${'path' in item ? item.path : ''}`}
                  id={`open-picker-item-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === selected}
                  className={`${styles.item} ${i === selected ? styles.selected : ''}`}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => activate(item)}
                >
                  <ItemContent item={item} />
                </div>
              ))}
            </div>
            <div className={styles.hint}>
              <kbd>Tab</kbd> complete · <kbd>↑↓</kbd> select · <kbd>Enter</kbd> open ·{' '}
              <kbd>Esc</kbd> close
            </div>
          </>
        ) : (
          <div className={styles.clone}>
            <label className={styles.label}>
              Repository URL
              <input
                className={styles.input}
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                onKeyDown={onCloneKeyDown}
                placeholder="git@github.com:user/repo.git"
                autoFocus
                {...inputProps}
              />
            </label>
            <label className={styles.label}>
              Destination
              <input
                className={styles.input}
                value={destination}
                onChange={(e) => setCloneDest(e.target.value)}
                onKeyDown={onCloneKeyDown}
                {...inputProps}
              />
            </label>
            <div className={styles.actions}>
              <button
                className={styles.primaryBtn}
                onClick={startClone}
                disabled={busy || !cloneUrl.trim()}
              >
                {busy ? 'Cloning…' : 'Clone'}
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() => {
                  setMode('path');
                  setError(null);
                }}
                disabled={busy}
              >
                Back
              </button>
            </div>
          </div>
        )}
        {busy && mode === 'path' && <div className={styles.status}>Opening…</div>}
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  );
}

function ItemContent({ item }: { item: Item }) {
  switch (item.kind) {
    case 'open':
      return (
        <>
          <FolderIcon size={14} />
          <span className={styles.primary}>Open</span>
          <span className={styles.secondary}>{item.path}</span>
        </>
      );
    case 'dir':
      return (
        <>
          <FolderIcon size={14} />
          <span className={styles.primary}>{basename(item.path)}/</span>
          <span className={styles.secondary}>{item.path}</span>
        </>
      );
    case 'clone':
      return (
        <>
          <BranchIcon size={14} />
          <span className={styles.primary}>Clone repository…</span>
        </>
      );
    case 'workspace':
      return (
        <>
          {item.entry.sessionCount > 0 ? (
            <span className={styles.liveDot} />
          ) : (
            <span className={styles.dotSpacer} />
          )}
          <span className={styles.primary}>{item.entry.name}</span>
          <span className={styles.secondary}>{item.entry.path}</span>
        </>
      );
  }
}
