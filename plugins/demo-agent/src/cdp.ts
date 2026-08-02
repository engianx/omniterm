import * as net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Parse a CDP-proxy upgrade URL of the form
 *   /agent/<instanceId>/ws/cdp/<port>[/<cdpPath...>]
 * Returns the target browser debug port + the CDP path to forward, or null if
 * the URL is not a CDP-proxy request for this plugin.
 *
 * Exported for unit testing the matcher in isolation.
 */
export function parseCdpUpgradeUrl(url: string): { port: number; cdpPath: string } | null {
  const m = url.match(/^\/agent\/[^/]+\/ws\/cdp\/(\d+)(\/.*)?$/);
  if (!m) return null;
  const port = parseInt(m[1] ?? '', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, cdpPath: m[2] ?? '/' };
}

/**
 * Direct TCP pipe from the host's `/agent/:id/ws/cdp/:port/*` upgrade to a
 * Chromium DevTools endpoint listening on `127.0.0.1:<port>` (the browser the
 * agent opened via the shiplight MCP). The browser panel uses this both for
 * Target discovery and as the `ws=` backend of the DevTools frontend iframes.
 *
 * Returns true if it claimed the upgrade, false to let other plugins/host try.
 */
export function handleAgentCdpUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const parsed = parseCdpUpgradeUrl(req.url ?? '');
  if (!parsed) return false;
  const { port, cdpPath } = parsed;

  // Chromium's DevTools endpoint is HTTP-on-localhost; replay the upgrade
  // handshake to it byte-for-byte (minus host/origin) and splice the sockets.
  const target = net.createConnection(port, '127.0.0.1');
  target.on('connect', () => {
    let headers = `GET ${cdpPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`;
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (kl !== 'host' && kl !== 'origin') {
        headers += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
      }
    }
    headers += '\r\n';
    target.write(headers);
    if (head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on('error', () => {
    if (!socket.destroyed) socket.destroy();
  });
  socket.on('error', () => {
    if (!target.destroyed) target.destroy();
  });
  socket.on('close', () => {
    if (!target.destroyed) target.destroy();
  });
  return true;
}
