// Pure (non-React) reconciliation logic for the manifest-driven plugin client,
// split out of manifestPlugins.tsx so it can be unit-tested without React.

import type { Tab } from './types';
import type { PluginInstance, PluginManifestEntry } from '../plugins/types.js';

/** An instance plus the plugin type that owns it (PluginInstance has no type). */
export type TrackedInstance = PluginInstance & { type: string };

/**
 * Reconcile the known instance map against a fresh set of list-poll results.
 *
 * `fresh` holds ONLY instances from plugins that declare a list endpoint
 * (`typesWithList`); that list is authoritative for those plugins. The function:
 *   - preserves instances of plugins WITHOUT a list endpoint (create/close own them);
 *   - re-applies optimistic creates the list hasn't confirmed yet (any status);
 *   - suppresses locally-closed instances until the backend list stops returning them.
 *
 * Mutates `optimistic`/`closed` (seeds get confirmed, tombstones expire) — these
 * are the caller's refs. Returns the new instance map.
 */
export function reconcileInstances(
  prev: Record<string, TrackedInstance>,
  fresh: Record<string, TrackedInstance>,
  typesWithList: Set<string>,
  optimistic: Set<string>,
  closed: Set<string>,
): Record<string, TrackedInstance> {
  const merged: Record<string, TrackedInstance> = {};
  // Keep instances of plugins without a list endpoint (poll doesn't own them).
  for (const [id, inst] of Object.entries(prev)) {
    if (!typesWithList.has(inst.type)) merged[id] = inst;
  }
  // Authoritative list results for list-backed plugins.
  Object.assign(merged, fresh);
  // Re-apply optimistic creates the list hasn't confirmed yet (any status).
  for (const id of [...optimistic]) {
    if (id in merged) optimistic.delete(id);
    else if (prev[id]) merged[id] = prev[id];
  }
  // Honor local closes until the backend list stops returning them.
  for (const id of [...closed]) {
    if (id in merged) delete merged[id];
    else closed.delete(id);
  }
  return merged;
}

/**
 * Build a plugin iframe's `src` from its manifest `urlTemplate` by substituting
 * the instance placeholders, each URL-encoded:
 *   - `{id}`   → the instance id.
 *   - `{file}` → the instance's bound `file` (empty string when absent).
 * A template that omits a placeholder is left untouched (the `.replace` is a
 * no-op). Kept pure (no React/DOM) so the substitution — the contract the
 * embedded SPA relies on to scope `/api/*` and restore its file — is unit-tested.
 */
export function buildPluginIframeSrc(
  urlTemplate: string,
  id: string,
  file: string | undefined,
): string {
  return urlTemplate
    .replace('{id}', encodeURIComponent(id))
    .replace('{file}', encodeURIComponent(file ?? ''));
}

/**
 * Whether a plugin tab's iframe should be mounted. Plugins without a `list`
 * endpoint give no status, so they are always ready. List-backed plugins are
 * ready only when the instance is present and `running` (or status-less) — an
 * absent instance means it ended or was never confirmed, so we don't mount a
 * zombie iframe against a dead backend id.
 */
export function isTabReady(
  t: Tab,
  entryByType: Map<string, PluginManifestEntry>,
  instances: Record<string, TrackedInstance>,
): boolean {
  const entry = entryByType.get(t.type);
  if (!entry) return false;
  if (!entry.endpoints.list) return true;
  const inst = instances[t.id];
  return !!inst && (inst.status === undefined || inst.status === 'running');
}
