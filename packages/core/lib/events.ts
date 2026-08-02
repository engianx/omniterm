import { Response } from 'express';

// Persist across hot reloads in dev mode
const g = globalThis as Record<string, unknown>;
const clients: Set<Response> = (g.__omniterm_sse_clients as Set<Response>) || new Set();
g.__omniterm_sse_clients = clients;

export type EventType =
  | 'files-changed'
  | 'session-silence'
  | 'session-created'
  | 'session-closed'
  | 'session-adopted'
  | 'browser-panel:added'
  | 'browser-panel:removed'
  | 'browser-panel:disconnected'
  | 'browser-panel:reconnected';

export function addClient(res: Response): void {
  clients.add(res);
  console.log(`[events] SSE client connected; clients=${clients.size}`);
  res.on('close', () => {
    clients.delete(res);
    console.log(`[events] SSE client disconnected; clients=${clients.size}`);
  });
  startHeartbeat();
}

// Send a keep-alive comment every 30s to prevent idle connection drops
const HEARTBEAT_INTERVAL = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null =
  (g.__omniterm_sse_heartbeat as ReturnType<typeof setInterval>) ?? null;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (clients.size === 0) {
      clearInterval(heartbeatTimer!);
      heartbeatTimer = null;
      g.__omniterm_sse_heartbeat = null;
      return;
    }
    for (const client of clients) {
      try {
        client.write(': heartbeat\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, HEARTBEAT_INTERVAL);
  g.__omniterm_sse_heartbeat = heartbeatTimer;
}

export function broadcast(type: EventType, data?: Record<string, unknown>): void {
  const payload = JSON.stringify({ type, ...data });
  console.log(`[events] broadcast type=${type} clients=${clients.size} payload=${payload}`);
  for (const client of clients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

export function getClientCount(): number {
  return clients.size;
}
