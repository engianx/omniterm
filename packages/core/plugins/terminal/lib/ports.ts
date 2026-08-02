import { execFileSync } from 'child_process';

const PORT_MIN = parseInt(process.env.OMNITERM_TTYD_PORT_MIN || '7700', 10);
const PORT_MAX = parseInt(process.env.OMNITERM_TTYD_PORT_MAX || '7799', 10);

// Persist across hot reloads in dev mode
const g = globalThis as Record<string, unknown>;
const allocated: Set<number> = (g.__omniterm_ports as Set<number>) || new Set();
g.__omniterm_ports = allocated;

/** Get all listening ports in our range with a single lsof call */
function getOccupiedPorts(): Set<number> {
  try {
    const out = execFileSync(
      'lsof',
      [`-iTCP:${PORT_MIN}-${PORT_MAX}`, '-sTCP:LISTEN', '-P', '-n', '-Fn'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const ports = new Set<number>();
    for (const line of out.split('\n')) {
      // Lines look like "n127.0.0.1:7700" or "n*:7700"
      if (!line.startsWith('n')) continue;
      const match = line.match(/:(\d+)$/);
      if (match) ports.add(parseInt(match[1], 10));
    }
    return ports;
  } catch {
    return new Set();
  }
}

export function allocatePort(): number {
  const occupied = getOccupiedPorts();
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (!allocated.has(port) && !occupied.has(port)) {
      allocated.add(port);
      return port;
    }
  }
  throw new Error(`No free ports available in range ${PORT_MIN}-${PORT_MAX}`);
}

export function freePort(port: number): void {
  allocated.delete(port);
}

export function markPortUsed(port: number): void {
  allocated.add(port);
}

export function getAllocatedPorts(): Set<number> {
  return allocated;
}
