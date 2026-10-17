/**
 * Browser pages as top-level host tabs.
 *
 * Data flow: every terminal tab of the current workspace is an "owner" — its
 * tmux env points `OMNITERM_BROWSER_REGISTRY_URL` at `/t/<tabId>/registry`, so
 * a Chrome launched from it (xdg-open, $BROWSER, the [+] Browser action)
 * registers there. `BrowserPagesStore` watches each owner's registry and each
 * registered browser's CDP targets; `reconcileBrowserTabs` (pure) turns that
 * into host tab opens / updates / removes; each VISIBLE browser tab (one, or
 * two in a split view) renders its own `BrowserPageView` through
 * `mainContent`, which the host calls once per pane.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { HostApi, MainContentContext, PluginIntegration, Tab } from '../app/types';
import ConfirmDialog from '../app/components/ConfirmDialog';
import { GlobeIcon } from '../app/components/icons';
import type { BrowserInspectorPosition } from '../lib/settings';
import BrowserPageView from './BrowserPageView';
import { BrowserPagesStore } from './browserPagesStore';
import {
  BROWSER_TAB_TYPE,
  parseBrowserTabId,
  pickOwnerForNewPage,
  reconcileBrowserTabs,
  type DesiredPage,
  type OwnerState,
  type PageAssignment,
} from './browserTabs';

export interface UseBrowserIntegrationArgs {
  activePath: string | null;
  tabs: ReadonlyArray<Tab>;
  activeTabId: string | null;
  host: HostApi;
  isMobile: boolean;
  browserInspectorPosition: BrowserInspectorPosition;
}

/** How long a user-closed tab stays suppressed waiting for its target to die.
 *  A page Chrome refuses to close reappears after this, which is the truth. */
const CLOSE_SUPPRESS_MS = 5000;
/** Cap on remembered page → owner assignments (oldest dropped first). */
const MAX_ASSIGNMENTS = 1000;

type Dialog =
  | { kind: 'confirm-close'; tab: Tab; count: number; resolve: (ok: boolean) => void }
  | { kind: 'info'; title: string; message: string };

const EMPTY: OwnerState[] = [];
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function useBrowserIntegration(args: UseBrowserIntegrationArgs): {
  integration: PluginIntegration;
} {
  const { activePath, tabs, activeTabId, host, browserInspectorPosition } = args;

  // Created in an effect (not during render) so a StrictMode mount/unmount
  // cycle can never leave us holding a disposed store.
  const [store, setStore] = useState<BrowserPagesStore | null>(null);
  useEffect(() => {
    const s = new BrowserPagesStore();
    setStore(s);
    return () => s.dispose();
  }, []);

  const snapshot = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptySnapshot,
  );

  const hostRef = useRef(host);
  hostRef.current = host;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // ----- owners = this workspace's terminal tabs -----
  const ownerKey = tabs
    .filter((t) => t.type === 'terminal')
    .map((t) => t.id)
    .join('\n');
  const ownerIds = useMemo(() => (ownerKey ? ownerKey.split('\n') : []), [ownerKey]);
  useEffect(() => {
    store?.setOwners(ownerIds);
  }, [store, ownerIds]);

  // ----- reconcile pages ⇄ host tabs -----
  const assignmentsRef = useRef(new Map<string, PageAssignment>());
  const announcedRef = useRef(new Set<string>());
  const suppressedRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastPatchRef = useRef(new Map<string, string>());
  const desiredRef = useRef(new Map<string, DesiredPage>());
  const [suppressTick, setSuppressTick] = useState(0);

  useEffect(() => {
    // Owners come from the host's tabs, not the store: the store lags a
    // workspace switch by a microtask, and an owner it has not caught up on
    // must read as "still loading", never as "gone".
    const byOwner = new Map(snapshot.map((o) => [o.ownerTabId, o] as const));
    const owners: OwnerState[] = ownerIds.map(
      (id) => byOwner.get(id) ?? { ownerTabId: id, browsersLoaded: false, browsers: [] },
    );
    const result = reconcileBrowserTabs({
      owners,
      tabs,
      activeTabId,
      activePath,
      assignments: assignmentsRef.current,
      announced: announcedRef.current,
      suppressed: new Set(suppressedRef.current.keys()),
    });
    const assignments = result.assignments;
    while (assignments.size > MAX_ASSIGNMENTS) {
      assignments.delete(assignments.keys().next().value as string);
    }
    assignmentsRef.current = assignments;
    desiredRef.current = result.desired;

    const api = hostRef.current;
    for (const action of result.actions) {
      if (action.kind === 'open') {
        announcedRef.current.add(action.tab.id);
        api.openTab(action.tab, { activate: action.activate, after: action.after });
      } else if (action.kind === 'update') {
        // Guard against a host that normalises a patch: never re-send the same
        // one, or a mismatch would loop update → render → update.
        const sig = JSON.stringify(action.patch);
        if (lastPatchRef.current.get(action.id) === sig) continue;
        lastPatchRef.current.set(action.id, sig);
        api.updateTab(action.id, action.patch);
      } else {
        lastPatchRef.current.delete(action.id);
        api.removeTab(action.id);
      }
    }
  }, [snapshot, ownerIds, tabs, activeTabId, activePath, suppressTick]);

  useEffect(() => {
    const timers = suppressedRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const suppress = useCallback((tabId: string) => {
    const timers = suppressedRef.current;
    const prev = timers.get(tabId);
    if (prev) clearTimeout(prev);
    timers.set(
      tabId,
      setTimeout(() => {
        timers.delete(tabId);
        setSuppressTick((n) => n + 1);
      }, CLOSE_SUPPRESS_MS),
    );
  }, []);

  /** Open pages owned by a terminal that are currently tabs. */
  const pagesOwnedBy = useCallback((ownerTabId: string): DesiredPage[] => {
    const present = new Set(tabsRef.current.map((t) => t.id));
    return [...desiredRef.current.values()].filter(
      (d) => d.ref.ownerTabId === ownerTabId && present.has(d.tab.id),
    );
  }, []);

  // ----- close -----
  const onCloseTab = useCallback(
    (tab: Tab) => {
      if (!store) return;
      if (tab.type === BROWSER_TAB_TYPE) {
        const ref = parseBrowserTabId(tab.id);
        if (!ref) return;
        suppress(tab.id);
        void store.send(ref.ownerTabId, ref.browserId, 'Target.closeTarget', {
          targetId: ref.targetId,
        });
      } else if (tab.type === 'terminal') {
        // Confirmed in beforeCloseTab: the terminal takes its pages with it.
        // Sent before the terminal's own DELETE can tear the registry down;
        // the proxied socket outlives the registry entry anyway.
        for (const d of pagesOwnedBy(tab.id)) {
          suppress(d.tab.id);
          void store.send(d.ref.ownerTabId, d.ref.browserId, 'Target.closeTarget', {
            targetId: d.ref.targetId,
          });
        }
      }
    },
    [store, suppress, pagesOwnedBy],
  );

  const [dialog, setDialog] = useState<Dialog | null>(null);

  const beforeCloseTab = useCallback(
    (tab: Tab): boolean | Promise<boolean> => {
      if (tab.type !== 'terminal') return true;
      const count = pagesOwnedBy(tab.id).length;
      if (count === 0) return true;
      return new Promise<boolean>((resolve) => {
        setDialog((prev) => {
          // One prompt at a time; a second close while one is open is a no.
          if (prev) {
            resolve(false);
            return prev;
          }
          return { kind: 'confirm-close', tab, count, resolve };
        });
      });
    },
    [pagesOwnedBy],
  );

  // ----- new browser tab -----
  const onCreate = useCallback(
    async () => {
      if (!store) return;
      const owner = pickOwnerForNewPage(tabsRef.current, activeTabIdRef.current);
      if (!owner) {
        setDialog({
          kind: 'info',
          title: 'Open a terminal first',
          message:
            "Browser tabs run in a terminal's browser. Open a terminal in this workspace, then add a browser tab.",
        });
        return;
      }
      const liveBrowser = store.liveBrowserId(owner);
      if (liveBrowser) {
        // The page arrives through target discovery as a fresh page and is
        // opened + focused by the reconcile pass like any other new page —
        // once it is claimed. No shim saw this one, so claim it here: without
        // it the shared Chrome's page could be placed by guesswork (another
        // workspace viewing the same Chrome would see it unowned).
        const result = (await store.send(owner, liveBrowser, 'Target.createTarget', {
          url: 'about:blank',
        })) as { targetId?: string } | undefined;
        if (result?.targetId) {
          await store.claimPage(owner, liveBrowser, result.targetId);
          return;
        }
      }
      // No live browser: have the server start the omniterm-browser shim under
      // this terminal's registry. The page then flows in like an xdg-open.
      try {
        const res = await fetch(`/t/${encodeURIComponent(owner)}/browsers/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'about:blank' }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
        }
      } catch (err) {
        setDialog({
          kind: 'info',
          title: 'Could not start a browser',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [store],
  );

  const tabTypeChoice = useMemo(
    () => ({
      type: BROWSER_TAB_TYPE,
      label: 'Browser',
      // Tabs are opened by the reconcile pass when the page appears, so the
      // host api is not needed here.
      onCreate: () => {
        void onCreate();
      },
    }),
    [onCreate],
  );

  // ----- content -----
  const mainContent = useCallback(
    (ctx: MainContentContext): ReactNode => {
      if (ctx.activeTab.type !== BROWSER_TAB_TYPE || !store) return null;
      const ref = parseBrowserTabId(ctx.activeTab.id);
      if (!ref) return null;
      const status = store.browser(ref.ownerTabId, ref.browserId);
      return (
        <BrowserPageView
          key={ctx.activeTab.id}
          ownerTabId={ref.ownerTabId}
          browserId={ref.browserId}
          targetId={ref.targetId}
          browserAvailable={status != null}
          connected={status?.connected ?? false}
          error={status?.error ?? null}
          inspectorPosition={browserInspectorPosition}
          label={ctx.activeTab.name}
          focused={ctx.focused !== false}
          resizing={ctx.resizing === true}
          onActivate={() => {
            void store.send(ref.ownerTabId, ref.browserId, 'Target.activateTarget', {
              targetId: ref.targetId,
            });
          }}
        />
      );
    },
    // `snapshot` re-creates this when connection status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, snapshot, browserInspectorPosition],
  );

  const layer = useCallback((): ReactNode => {
    if (!dialog) return null;
    if (dialog.kind === 'info') {
      return (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          buttons={[{ label: 'OK', primary: true, action: () => {} }]}
          onClose={() => setDialog(null)}
        />
      );
    }
    let decided = false;
    const decide = (ok: boolean) => {
      if (decided) return;
      decided = true;
      dialog.resolve(ok);
    };
    const n = dialog.count;
    return (
      <ConfirmDialog
        title={`Close ${dialog.tab.name}?`}
        message={`Closing this terminal also closes its ${n} browser tab${n === 1 ? '' : 's'}.`}
        buttons={[
          { label: 'Cancel', action: () => decide(false) },
          { label: 'Close', danger: true, action: () => decide(true) },
        ]}
        onClose={() => {
          // Overlay click / after a button: anything undecided is a cancel.
          decide(false);
          setDialog(null);
        }}
      />
    );
  }, [dialog]);

  const tabIcon = useCallback(
    (tab: Tab): ReactNode | null =>
      tab.type === BROWSER_TAB_TYPE ? <GlobeIcon size={14} /> : null,
    [],
  );

  const integration: PluginIntegration = useMemo(
    () => ({
      tabTypeChoice,
      onCloseTab,
      beforeCloseTab,
      tabIcon,
      mainContent,
      iframeTabsLayer: layer,
      paneAware: true,
      // Pages are process-bound; they come back from the live registry, never
      // from saved settings.
      ephemeralTabTypes: new Set([BROWSER_TAB_TYPE]),
    }),
    [tabTypeChoice, onCloseTab, beforeCloseTab, tabIcon, mainContent, layer],
  );

  return { integration };
}
