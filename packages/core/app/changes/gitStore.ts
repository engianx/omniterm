/**
 * One shared, refcounted cache of `/api/git/info` + `/api/git/changes` per
 * workspace path, so the Changes panel and the status bar render the same
 * snapshot from one poll. Refreshes on 'omniterm:git-changed', window focus,
 * tab becoming visible, and a modest poll while the page is visible.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { emit, on } from '../events';
import type { GitChanges, GitInfo } from './changeRows';

export interface GitState {
  info: GitInfo | null;
  changes: GitChanges | null;
}

const POLL_MS = 5000;
const EMPTY: GitState = { info: null, changes: null };

interface Entry {
  state: GitState;
  /** JSON of `state`, so an unchanged poll doesn't re-render. */
  key: string;
  listeners: Set<() => void>;
  inflight: Promise<void> | null;
}

const entries = new Map<string, Entry>();
let teardown: (() => void) | null = null;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Re-fetch one workspace's git state (coalesces concurrent calls). */
export function refreshGit(cwd: string): Promise<void> {
  const e = entries.get(cwd);
  if (!e) return Promise.resolve();
  if (e.inflight) return e.inflight;
  e.inflight = (async () => {
    const q = `cwd=${encodeURIComponent(cwd)}`;
    const info = await getJson<GitInfo>(`/api/git/info?${q}`);
    const changes = info?.isRepo ? await getJson<GitChanges>(`/api/git/changes?${q}`) : null;
    const state = { info, changes };
    const key = JSON.stringify(state);
    if (key !== e.key) {
      e.state = state;
      e.key = key;
      for (const l of e.listeners) l();
    }
  })().finally(() => {
    e.inflight = null;
  });
  return e.inflight;
}

function refreshAll() {
  for (const [cwd, e] of entries) if (e.listeners.size > 0) void refreshGit(cwd);
}

/** Window-level triggers, installed while anything is subscribed. */
function installTriggers(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') refreshAll();
  };
  const offChanged = on('omniterm:git-changed', refreshAll);
  window.addEventListener('focus', refreshAll);
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshAll();
  }, POLL_MS);
  return () => {
    offChanged();
    window.removeEventListener('focus', refreshAll);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  };
}

function subscribe(cwd: string, listener: () => void): () => void {
  let e = entries.get(cwd);
  if (!e) {
    e = { state: EMPTY, key: JSON.stringify(EMPTY), listeners: new Set(), inflight: null };
    entries.set(cwd, e);
  }
  e.listeners.add(listener);
  teardown ??= installTriggers();
  void refreshGit(cwd);
  return () => {
    e.listeners.delete(listener);
    if ([...entries.values()].every((x) => x.listeners.size === 0)) {
      teardown?.();
      teardown = null;
    }
  };
}

/** Git info + changes for `cwd` (null fields while loading or for no workspace). */
export function useGitState(cwd: string | null): GitState {
  const sub = useCallback((l: () => void) => (cwd ? subscribe(cwd, l) : () => {}), [cwd]);
  const get = useCallback(() => (cwd ? (entries.get(cwd)?.state ?? EMPTY) : EMPTY), [cwd]);
  return useSyncExternalStore(sub, get);
}

/**
 * POST a git mutation; throws with the server's message on failure. Announces
 * 'omniterm:git-changed' afterwards either way (a failed checkout or commit
 * may still have changed the tree), which also refreshes this store.
 */
export async function gitPost<T = unknown>(route: string, cwd: string, body: Record<string, unknown>): Promise<T> {
  try {
    const res = await fetch(`/api/git/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `git ${route} failed (${res.status})`);
    return data as T;
  } finally {
    emit('omniterm:git-changed', { cwd });
  }
}
