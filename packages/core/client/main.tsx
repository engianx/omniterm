/**
 * omniterm shell — built-in terminal plugin plus any external plugins loaded
 * at runtime via `--plugin`, rendered generically from the GET /api/plugins
 * manifest (no plugin code compiled into this bundle).
 *
 * Consumers that need a *compiled-in* component plugin (rather than a runtime
 * iframe plugin) can still write their own client entry importing
 * `useHomeState`, `composeIntegrations`, and `useTerminalIntegration`.
 */

import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../app/globals.css';
import Home, { composeIntegrations, useHomeState } from '../app/page';
import { useTerminalIntegration } from '../plugins/terminal/integration';
import { useManifestIntegration } from '../app/manifestPlugins';

function App() {
  // See apps/testbox/client/main.tsx for why we route through a ref:
  // useHomeState → terminal hook → composeIntegrations is a cycle that
  // we close by writing the composed refresh into a ref each render.
  const composedRefreshRef = useRef<() => void | Promise<void>>(() => {});
  const homeState = useHomeState({
    onRefreshWorkspaces: () => composedRefreshRef.current(),
  });
  const terminal = useTerminalIntegration({
    activePath: homeState.activePath,
    activeTabId: homeState.activeTabId,
    tabs: homeState.tabs,
    setTabs: homeState.setTabs,
    setActiveTabId: homeState.setActiveTabId,
    browserPanelOpen: homeState.browserPanelOpen,
    setBrowserPanelOpen: homeState.setBrowserPanelOpen,
    isMobile: homeState.isMobile,
    filesPanelOpen: homeState.filesPanelOpen,
    settingsHydrated: homeState.settingsHydrated,
    refreshWorkspaces: homeState.refreshWorkspaces,
  });

  // External plugins (loaded via `--plugin`) render from the GET /api/plugins
  // manifest — no plugin code is compiled into this bundle. With no plugins the
  // integration is empty and the shell is the plain terminal host.
  const manifest = useManifestIntegration({ tabs: homeState.tabs });

  const composed = composeIntegrations(terminal.integration, manifest.integration);
  composedRefreshRef.current = composed.onWorkspaceRefresh;

  return <Home state={homeState} {...composed} workspaceOrphans={terminal.orphanSessions} />;
}

createRoot(document.getElementById('root')!).render(<App />);
