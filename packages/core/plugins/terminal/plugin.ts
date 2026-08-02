/**
 * Terminal plugin — the first concrete `TabTypePlugin`.
 *
 * Wraps terminal-specific behavior (tmux + ttyd spawn, tab-local browser
 * registry, CDP proxies, React UI) behind the uniform plugin interface.
 * The host treats this the same way it will treat the debugger and future
 * agent plugins — no special casing.
 *
 * Commit B scope: expose the plugin object + router, preserve current
 * spawn paths. Physical file moves happen in Commit C.
 */

import type { Router } from 'express';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

import type { HostContext, SpawnArgs, TabInstance, TabTypePlugin } from '../types.js';
import {
  createTabRegistryRouter,
  handleCdpUpgrade,
  cleanupTab as cleanupTabRegistry,
} from '../../browserRegistry/tabRegistry.js';

// ------------------------------------------------------------------------
// Terminal-specific instance shape — carries state the terminal UI reads.
// ------------------------------------------------------------------------

export interface TerminalTabInstance extends TabInstance {
  readonly type: 'terminal';
  /** tmux session / ttyd allocation; owned by lib/sessions.ts for now. */
  readonly sessionId: string;
}

// ------------------------------------------------------------------------
// Plugin
// ------------------------------------------------------------------------

export function createTerminalPlugin(
  opts: {
    /**
     * Optional override for the embedded DevTools frontend URL. When unset,
     * the registry proxy targets the registered Chromium's own /devtools/
     * endpoint (so consumers don't need to ship a bundle). Set this to use
     * a customized DevTools bundle (e.g. testbox's locator-picker version).
     */
    devtoolsFrontendUrl?: string;
  } = {},
): TabTypePlugin<TerminalTabInstance> {
  return {
    type: 'terminal',
    label: 'Terminal',
    proxyPrefix: '/t/:tabId',

    createRouter(_host: HostContext): Router {
      // Everything under /t/:tabId/* that isn't a ttyd passthrough lives
      // in the tab-registry router: registrations, SSE events, devtools
      // iframe proxy. Unmatched paths (e.g. /t/:tabId/ws for ttyd) fall
      // through to the host's ttyd catch-all.
      return createTabRegistryRouter({ devtoolsFrontendUrl: opts.devtoolsFrontendUrl });
    },

    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      // Only match the tab-scoped CDP WS paths. ttyd WS upgrades
      // (/t/:tabId/ws etc.) are NOT handled here — the host dispatches
      // those to the ttyd port for the terminal's session.
      return handleCdpUpgrade(req, socket, head, { basePath: '/t' });
    },

    async spawn(_args: SpawnArgs): Promise<TerminalTabInstance> {
      // Commit B leaves the spawn path routed through the existing
      // /api/create-session HTTP endpoint (consumed by page.tsx's
      // handleCreateTab). Commit C will consolidate here.
      throw new Error(
        'Terminal spawn not yet routed through the plugin — ' +
          'page.tsx currently calls /api/create-session directly. ' +
          'Commit C will migrate.',
      );
    },

    cleanupTab(tabId: string): void | Promise<void> {
      cleanupTabRegistry(tabId);
    },

    render: {
      type: 'component',
      // The component path is interpreted by the host's dynamic import.
      // Commit C physically moves the component into this folder; for
      // now the path still resolves against the current component
      // location.
      componentPath: './components/TerminalTabView',
    },
  };
}
