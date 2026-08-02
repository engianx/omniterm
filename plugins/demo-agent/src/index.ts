import express, { type Router } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HostContext, TabTypePlugin } from '@omniterm/plugin-types';
import { AgentRegistry } from './agentInstance.js';
import { handleAgentCdpUpgrade } from './cdp.js';
import { resolveClientDir } from './clientDir.js';

/**
 * @omniterm/demo-agent-plugin — a coding-agent panel as an omniterm plugin.
 *
 * Each tab is one conversation (conversation-per-tab): the [+] dropdown's "Agent"
 * entry POSTs `/demo-agent/instances` to mint a conversation id, and the host mounts
 * an iframe at `/agent/<id>/`. Inside, the SPA streams the Claude Agent SDK over
 * SSE and, when the agent opens a browser via the shiplight MCP, shows it live in
 * a split DevTools panel (CDP proxied through `handleUpgrade`; the DevTools
 * frontend is the host's vendored bundle at `/devtools/`).
 *
 * No-arg factory (default export); HostContext arrives via createRouter.
 */
export default function createDemoAgentPlugin(): TabTypePlugin {
  const registry = new AgentRegistry();
  const clientDir = resolveClientDir();

  // express type identity differs across the plugin's express and @omniterm/core's
  // — bridge with a structural cast at the seam (same pattern as the debugger).
  type AnyRouter = ReturnType<TabTypePlugin['createRouter']>;

  return {
    type: 'demo-agent',
    label: 'Demo Agent',
    proxyPrefix: '', // router carries its own /demo-agent/* + /agent/* + /agent-assets paths

    manifest: {
      type: 'demo-agent',
      label: 'Demo Agent',
      ephemeral: true,
      tabTypeChoice: { label: 'Demo Agent' },
      endpoints: {
        create: '/demo-agent/instances',
        list: '/demo-agent/instances',
        closeTemplate: '/demo-agent/instances/{id}',
      },
      iframe: { urlTemplate: '/agent/{id}/' },
    },

    createRouter(host: HostContext): AnyRouter {
      const router: Router = express.Router();
      router.use(registry.createRoutes(host, clientDir));
      return router as unknown as AnyRouter;
    },

    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      return handleAgentCdpUpgrade(req, socket, head);
    },
  };
}
