'use client';

/**
 * Data-driven plugin consumer. Reads `GET /api/plugins` and renders every
 * external plugin's `[+]` entry, file-context-menu handlers, persisted iframe
 * tabs, and file indicators from manifest DATA — no plugin-specific code lives
 * in this bundle, which is what lets plugins load with no host-client rebuild.
 *
 * Generalizes the previous build-time per-plugin integration (e.g. testbox's
 * DebuggerSessionsHost): the iframe-persistence + visibility-toggle behavior is
 * the same, driven by the manifest instead of a compiled-in component.
 *
 * Instance state is reconciled against eventually-consistent backends:
 *   - a `list` endpoint is the authoritative source for its plugin's instances;
 *   - locally-created instances are kept (optimistic) until the first list poll
 *     confirms them, so a fresh tab doesn't flicker out for a poll cycle;
 *   - locally-closed instances are suppressed (tombstoned) until the backend
 *     list stops returning them, so a slow DELETE doesn't resurrect them;
 *   - plugins without a `list` endpoint are managed purely by create/close.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostApi, PluginIntegration, Tab } from './types';
import type { PluginManifestEntry, PluginInstance } from '../plugins/types.js';
import { reconcileInstances, isTabReady, buildPluginIframeSrc, type TrackedInstance } from './manifestReconcile';
import { track } from './telemetryClient';

const POLL_MS = 2000;

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

async function fetchManifest(): Promise<PluginManifestEntry[]> {
  try {
    const res = await fetch('/api/plugins');
    if (!res.ok) return [];
    const data = (await res.json()) as { plugins?: PluginManifestEntry[] };
    return Array.isArray(data.plugins) ? data.plugins : [];
  } catch {
    return [];
  }
}

export function useManifestIntegration({ tabs }: { tabs: Tab[] }): {
  integration: PluginIntegration;
} {
  const [entries, setEntries] = useState<PluginManifestEntry[]>([]);
  const [instances, setInstances] = useState<Record<string, TrackedInstance>>({});
  // Ids created locally but not yet confirmed by a list poll.
  const optimisticRef = useRef<Set<string>>(new Set());
  // Ids closed locally; suppressed until the backend list drops them.
  const closedRef = useRef<Set<string>>(new Set());

  // Load the manifest once. Retry a few times so a brief unavailability at first
  // paint doesn't leave plugins permanently invisible.
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const e = await fetchManifest();
      if (cancelled) return;
      if (e.length === 0 && attempts < 5) {
        attempts += 1;
        timer = setTimeout(load, 1000);
        return;
      }
      setEntries(e);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const entryByType = useMemo(() => {
    const m = new Map<string, PluginManifestEntry>();
    for (const e of entries) m.set(e.type, e);
    return m;
  }, [entries]);

  const manifestTypes = useMemo(() => new Set(entries.map((e) => e.type)), [entries]);
  const typesWithList = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) if (e.endpoints.list) s.add(e.type);
    return s;
  }, [entries]);

  // Poll each plugin's list endpoint for instance status + bound files.
  const listSpecs = useMemo(
    () =>
      entries.flatMap((e) => (e.endpoints.list ? [{ type: e.type, url: e.endpoints.list }] : [])),
    [entries],
  );
  useEffect(() => {
    if (listSpecs.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const fresh: Record<string, TrackedInstance> = {};
      await Promise.all(
        listSpecs.map(async ({ type, url }) => {
          try {
            const res = await fetch(url);
            if (!res.ok) return;
            const data = (await res.json()) as { items?: PluginInstance[] };
            for (const it of data.items ?? []) {
              if (it && typeof it.id === 'string') fresh[it.id] = { ...it, type };
            }
          } catch {
            /* a transient poll failure shouldn't wipe known state */
          }
        }),
      );
      if (cancelled) return;
      setInstances((prev) =>
        reconcileInstances(prev, fresh, typesWithList, optimisticRef.current, closedRef.current),
      );
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [listSpecs, typesWithList]);

  const createInstance = useCallback(
    async (entry: PluginManifestEntry, openFile: string | undefined, api: HostApi) => {
      let resp: PluginInstance | undefined;
      try {
        const res = await fetch(entry.endpoints.create, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(openFile ? { openFile } : {}),
        });
        if (!res.ok) {
          console.error(`[plugin:${entry.type}] create failed: ${res.status} ${res.statusText}`);
          return;
        }
        resp = (await res.json()) as PluginInstance;
      } catch (err) {
        console.error(
          `[plugin:${entry.type}] create error:`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      if (!resp || typeof resp.id !== 'string') {
        console.error(`[plugin:${entry.type}] create returned no id`);
        return;
      }
      const created: TrackedInstance = { ...resp, type: entry.type };
      optimisticRef.current.add(created.id);
      closedRef.current.delete(created.id);
      setInstances((prev) => ({ ...prev, [created.id]: created }));
      const name = created.name ?? (openFile ? basename(openFile) : entry.label);
      api.openTab({ type: entry.type, id: created.id, name });
      // Plugin type is intentionally omitted: third-party identifiers can carry
      // organization or project names that do not belong in telemetry.
      track('plugin_tab_opened');
    },
    [],
  );

  const tabTypeChoices = useMemo(
    () =>
      entries
        .filter((e) => e.tabTypeChoice)
        .map((e) => ({
          type: e.type,
          label: e.tabTypeChoice!.label,
          onCreate: (api: HostApi) => createInstance(e, undefined, api),
        })),
    [entries, createInstance],
  );

  const fileHandlers = useMemo(
    () =>
      entries.flatMap((e) =>
        (e.fileHandlers ?? []).map((fh) => ({
          pattern: fh.pattern,
          label: fh.label,
          onSelect: (absPath: string, api: HostApi) => createInstance(e, absPath, api),
        })),
      ),
    [entries, createInstance],
  );

  const ephemeralTabTypes = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) if (e.ephemeral) s.add(e.type);
    return s;
  }, [entries]);

  const fileIndicatorPaths = useMemo(() => {
    const s = new Set<string>();
    for (const inst of Object.values(instances)) if (inst.file) s.add(inst.file);
    return s;
  }, [instances]);

  const onCloseTab = useCallback(
    (tab: Tab) => {
      const entry = entryByType.get(tab.type);
      if (!entry) return;
      optimisticRef.current.delete(tab.id);
      // Tombstone only list-backed instances (the poll could otherwise resurrect
      // them); list-less instances are gone for good once removed locally.
      if (entry.endpoints.list) closedRef.current.add(tab.id);
      setInstances((prev) => {
        const next = { ...prev };
        delete next[tab.id];
        return next;
      });
      if (entry.endpoints.closeTemplate) {
        const url = entry.endpoints.closeTemplate.replace('{id}', encodeURIComponent(tab.id));
        void fetch(url, { method: 'DELETE' }).catch(() => {});
      }
    },
    [entryByType],
  );

  const iframeTabsLayer = useCallback(
    ({ activeTabId }: { activeTabId: string | null }) => (
      <ManifestIframeHost
        tabs={tabs}
        entryByType={entryByType}
        instances={instances}
        activeTabId={activeTabId}
      />
    ),
    [tabs, entryByType, instances],
  );

  const integration = useMemo<PluginIntegration>(
    () => ({
      tabTypeChoices,
      fileHandlers,
      ephemeralTabTypes,
      fileIndicatorPaths,
      onCloseTab,
      iframeTabsLayer,
    }),
    [tabTypeChoices, fileHandlers, ephemeralTabTypes, fileIndicatorPaths, onCloseTab, iframeTabsLayer],
  );

  return { integration };
}

/**
 * Keeps every open plugin tab's iframe mounted (persisted across tab switches),
 * toggling visibility by the active tab. Mounts an iframe only when its instance
 * is ready (see `isTabReady`).
 */
function ManifestIframeHost({
  tabs,
  entryByType,
  instances,
  activeTabId,
}: {
  tabs: Tab[];
  entryByType: Map<string, PluginManifestEntry>;
  instances: Record<string, TrackedInstance>;
  activeTabId: string | null;
}) {
  const pluginTabs = tabs.filter((t) => entryByType.has(t.type));
  const ready = pluginTabs.filter((t) => isTabReady(t, entryByType, instances));
  const activeReady = ready.some((t) => t.id === activeTabId);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: activeReady ? 'auto' : 'none' }}>
      {ready.map((t) => {
        const entry = entryByType.get(t.type)!;
        const src = buildPluginIframeSrc(entry.iframe.urlTemplate, t.id, instances[t.id]?.file);
        return (
          <iframe
            key={t.id}
            src={src}
            title={t.name}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              border: 'none',
              display: t.id === activeTabId ? 'block' : 'none',
            }}
          />
        );
      })}
    </div>
  );
}
