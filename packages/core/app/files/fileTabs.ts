/**
 * Pure logic behind the files integration: the host-tab id scheme, tab-label
 * disambiguation, per-workspace persistence (de)serialisation, and the
 * reconcile plan that keeps the host tab strip in step with the file store.
 *
 * No React, no fetch — everything here is unit-tested in fileTabs.test.ts.
 */

import type { Tab } from '../types';

/** `diff` tabs are read-only views of a file's git changes (never persisted). */
export type FileTabKind = 'source' | 'preview' | 'diff';

/** The host tab `type` every file tab carries. */
export const FILE_TAB_TYPE = 'file';

/** One open file, as far as identity is concerned. `path` is workspace-relative. */
export interface FileRef {
  path: string;
  kind: FileTabKind;
}

const ID_PREFIX = 'file:';

/**
 * Host tab id for a file: `file:${kind}:${absPath}`. Absolute, so ids from two
 * workspaces never collide (a stale tab from the previous workspace is
 * recognisably not one of ours).
 */
export function fileTabId(root: string, kind: FileTabKind, relPath: string): string {
  return `${ID_PREFIX}${kind}:${root}/${relPath}`;
}

export function isFileTabId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/** Inverse of `fileTabId`. `null` for ids that are not file tabs. */
export function parseFileTabId(id: string): { kind: FileTabKind; absPath: string } | null {
  if (!isFileTabId(id)) return null;
  const rest = id.slice(ID_PREFIX.length);
  for (const kind of ['source', 'preview', 'diff'] as const) {
    if (rest.startsWith(`${kind}:`)) return { kind, absPath: rest.slice(kind.length + 1) };
  }
  return null;
}

/**
 * Display labels for file tabs, mirroring VS Code editor-tab behaviour.
 *
 * If a tab's basename is unique among the open tabs, just the basename is
 * used. When multiple tabs share a basename, each one gets the shortest
 * trailing-ancestor suffix that disambiguates within that group:
 *   - `a/lib/x.ts` vs `b/lib/x.ts`     → `x.ts — a/lib`, `x.ts — b/lib`
 *   - `src/foo/y.ts` vs `src/bar/y.ts` → `y.ts — foo`,   `y.ts — bar`
 * Tabs of the SAME path (source / preview / diff) are told apart by their tab
 * icon, so a group whose paths are all identical never grows a noisy suffix.
 */
export function computeLabels(tabs: ReadonlyArray<{ path: string }>): string[] {
  const result: string[] = tabs.map((t) => t.path.split('/').pop() ?? t.path);

  const groups = new Map<string, number[]>();
  tabs.forEach((_, i) => {
    const arr = groups.get(result[i]) ?? [];
    arr.push(i);
    groups.set(result[i], arr);
  });

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
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

/** The host tabs the store wants to see, in store order. */
export function desiredHostTabs(
  root: string,
  files: ReadonlyArray<FileRef & { isDirty: boolean }>,
): Tab[] {
  const labels = computeLabels(files);
  return files.map((f, i) => ({
    type: FILE_TAB_TYPE,
    id: fileTabId(root, f.kind, f.path),
    name: f.kind === 'diff' ? `${labels[i]} (diff)` : labels[i],
    title: f.kind === 'preview' ? `Preview: ${f.path}` : f.kind === 'diff' ? `Changes: ${f.path}` : f.path,
    dirty: f.isDirty,
    renamable: false,
  }));
}

// ----- persistence -----

/** Legacy (pre-unified-strip) id stored as `filePanelTabs[dir].active`. */
export function legacyActiveKey(ref: FileRef): string {
  return `${ref.kind}::${ref.path}`;
}

export interface PersistedFileTabs {
  open: FileRef[];
  active: string | null;
}

/**
 * Read one `filePanelTabs[dirPath]` entry. Tolerates the legacy plain-string
 * entries (`"src/a.ts"` → source tab), missing kinds, junk, and duplicates.
 */
export function parsePersisted(raw: unknown): PersistedFileTabs {
  const empty: PersistedFileTabs = { open: [], active: null };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as { open?: unknown; active?: unknown };
  if (!Array.isArray(r.open)) return empty;
  const seen = new Set<string>();
  const open: FileRef[] = [];
  for (const e of r.open) {
    let ref: FileRef | null = null;
    if (typeof e === 'string') ref = { path: e, kind: 'source' };
    else if (e && typeof e === 'object' && typeof (e as { path?: unknown }).path === 'string') {
      const k = (e as { kind?: unknown }).kind;
      ref = { path: (e as { path: string }).path, kind: k === 'preview' ? 'preview' : 'source' };
    }
    if (!ref || !ref.path) continue;
    const key = legacyActiveKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    open.push(ref);
  }
  const active =
    typeof r.active === 'string' && open.some((o) => legacyActiveKey(o) === r.active)
      ? r.active
      : null;
  return { open, active };
}

/** Diff tabs are dropped: they show git state at one moment, not a file to restore. */
export function serializePersisted(
  allOpen: ReadonlyArray<FileRef>,
  active: FileRef | null,
): PersistedFileTabs {
  const open = allOpen.filter((o) => o.kind !== 'diff');
  const stillOpen =
    active && open.some((o) => o.kind === active.kind && o.path === active.path) ? active : null;
  return {
    open: open.map((o) => ({ path: o.path, kind: o.kind })),
    active: stillOpen ? legacyActiveKey(stillOpen) : null,
  };
}

/**
 * Order store items by where the host shows them (the user may drag tabs);
 * items the host doesn't show keep their store order, after the shown ones.
 */
export function orderByHost<T>(
  items: ReadonlyArray<T>,
  idOf: (t: T) => string,
  hostTabs: ReadonlyArray<Tab>,
): T[] {
  const pos = new Map<string, number>();
  hostTabs.forEach((t, i) => pos.set(t.id, i));
  return items
    .map((item, i) => ({ item, i, p: pos.get(idOf(item)) }))
    .sort((a, b) => {
      if (a.p !== undefined && b.p !== undefined) return a.p - b.p;
      if (a.p !== undefined) return -1;
      if (b.p !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.item);
}

// ----- reconcile -----

export interface ReconcilePlan {
  open: Array<{ tab: Tab; after?: string }>;
  update: Array<{ id: string; patch: Partial<Omit<Tab, 'id' | 'type'>> }>;
  remove: string[];
}

/**
 * Diff the store's desired tabs against the host's list.
 *
 * - desired + missing from host + not suppressed → open (a preview or diff goes
 *   after its source tab when that is shown or opened earlier in the same plan).
 * - desired + present with stale name/title/dirty → update.
 * - a file-id tab in the host that the store doesn't hold → remove, but only
 *   when `pruneStale` (the store is hydrated for the current workspace).
 *
 * Applying the plan converges: afterwards every desired tab is present with
 * matching fields, so the next run yields an empty plan (no render loop), and
 * the host's openTab is idempotent on id, so a repeated plan can't duplicate.
 */
export function planReconcile(args: {
  desired: ReadonlyArray<Tab>;
  hostTabs: ReadonlyArray<Tab>;
  suppressed?: ReadonlySet<string>;
  pruneStale: boolean;
}): ReconcilePlan {
  const { desired, hostTabs, suppressed, pruneStale } = args;
  const hostById = new Map(hostTabs.map((t) => [t.id, t]));
  const shown = new Set(hostTabs.map((t) => t.id));
  const plan: ReconcilePlan = { open: [], update: [], remove: [] };

  for (const d of desired) {
    const h = hostById.get(d.id);
    if (!h) {
      if (suppressed?.has(d.id)) continue;
      let after: string | undefined;
      const parsed = parseFileTabId(d.id);
      if (parsed && parsed.kind !== 'source') {
        const sourceId = `${ID_PREFIX}source:${parsed.absPath}`;
        if (shown.has(sourceId)) after = sourceId;
      }
      plan.open.push(after ? { tab: d, after } : { tab: d });
      shown.add(d.id);
      continue;
    }
    const patch: Partial<Omit<Tab, 'id' | 'type'>> = {};
    if (h.name !== d.name) patch.name = d.name;
    if (h.title !== d.title) patch.title = d.title;
    if (Boolean(h.dirty) !== Boolean(d.dirty)) patch.dirty = d.dirty;
    if (Object.keys(patch).length > 0) plan.update.push({ id: d.id, patch });
  }

  if (pruneStale) {
    const wanted = new Set(desired.map((d) => d.id));
    for (const h of hostTabs) {
      if (h.type === FILE_TAB_TYPE && isFileTabId(h.id) && !wanted.has(h.id)) plan.remove.push(h.id);
    }
  }
  return plan;
}

// ----- tree helpers -----

/** Basename glob match for plugin file handlers. Only `*` is special. */
export function matchesGlob(pattern: string, basename: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(basename);
}

export function gitStatusColor(xy: string | undefined): string | undefined {
  if (!xy) return undefined;
  if (xy === '??') return 'var(--success, #3fb950)';
  if (xy[0] === 'A' || xy[1] === 'A') return 'var(--success, #3fb950)';
  if (xy[0] === 'D' || xy[1] === 'D') return 'var(--danger, #f85149)';
  if (xy[0] === 'M' || xy[1] === 'M') return 'var(--warning, #d29922)';
  if (xy[0] === 'R') return 'var(--warning, #d29922)';
  return undefined;
}

/** Colour each ancestor directory of a changed file by its first changed child. */
export function buildDirStatus(gitStatus: Record<string, string>): Record<string, string> {
  const dirColors: Record<string, string> = {};
  for (const [filePath, xy] of Object.entries(gitStatus)) {
    const color = gitStatusColor(xy);
    if (!color) continue;
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirColors[dir]) dirColors[dir] = color;
    }
  }
  return dirColors;
}

/** Changed files and every ancestor directory of one (changes-only filter). */
export function changedSets(gitStatus: Record<string, string>): {
  files: Set<string>;
  dirs: Set<string>;
} {
  const files = new Set(Object.keys(gitStatus));
  const dirs = new Set<string>();
  for (const filePath of files) {
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files, dirs };
}
