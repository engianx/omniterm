import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as net from 'net';
import { loadSettings } from '../../../lib/settings.js';
import { trackCleanup } from '../../../lib/telemetry.js';

// Persist across hot reloads in dev mode
const g = globalThis as Record<string, unknown>;
const ttydProcesses: Map<string, ChildProcess> =
  (g.__omniterm_ttyd as Map<string, ChildProcess>) || new Map();
const ttydStoppedListeners: Set<(sessionName: string) => void> =
  (g.__omniterm_ttyd_stopped_listeners as Set<(sessionName: string) => void>) || new Set();
g.__omniterm_ttyd = ttydProcesses;
g.__omniterm_ttyd_stopped_listeners = ttydStoppedListeners;

function notifyTtydStopped(sessionName: string): void {
  for (const listener of ttydStoppedListeners) {
    try {
      listener(sessionName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ttyd] stopped listener failed for ${sessionName}: ${message}`);
    }
  }
}

export function onTtydStopped(listener: (sessionName: string) => void): () => void {
  ttydStoppedListeners.add(listener);
  return () => {
    ttydStoppedListeners.delete(listener);
  };
}

/**
 * Build the ttyd CLI args (pure, so the renderer/fontSize → flag mapping is
 * unit-testable). renderer defaults to 'webgl' (GPU, fast for large scrollback)
 * and any non-'dom' value coerces to 'webgl' — matching the Settings UI, so a
 * stale/hand-edited settings value can't pass a bogus rendererType to ttyd.
 */
export function buildTtydArgs(
  sessionName: string,
  port: number,
  settings: { terminalFontSize?: number; terminalRenderer?: string },
): string[] {
  const fontSize = settings.terminalFontSize || 18;
  const renderer = settings.terminalRenderer === 'dom' ? 'dom' : 'webgl';
  return [
    '--writable',
    '-i',
    '127.0.0.1',
    '-b',
    `/t/${sessionName}/`,
    '-t',
    `rendererType=${renderer}`,
    '-t',
    `fontSize=${fontSize}`,
    '-p',
    String(port),
    '--',
    'bash',
    '-c',
    `exec tmux attach-session -t ${sessionName}`,
  ];
}

export function spawnTtyd(sessionName: string, port: number): ChildProcess {
  const args = buildTtydArgs(sessionName, port, loadSettings());

  const proc = spawn('ttyd', args, {
    stdio: 'ignore',
    detached: true,
  });
  proc.once('error', (err) => {
    console.error(`[ttyd] failed to spawn for ${sessionName} on port ${port}: ${err.message}`);
    if (ttydProcesses.get(sessionName) === proc) {
      ttydProcesses.delete(sessionName);
      notifyTtydStopped(sessionName);
    }
  });
  proc.once('exit', (code, signal) => {
    if (ttydProcesses.get(sessionName) === proc) {
      ttydProcesses.delete(sessionName);
      notifyTtydStopped(sessionName);
    }
    if (code !== 0 || signal) {
      console.error(
        `[ttyd] exited for ${sessionName} on port ${port}: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      );
    }
  });
  proc.unref();
  ttydProcesses.set(sessionName, proc);
  return proc;
}

/**
 * Poll until ttyd is accepting TCP connections on the given port.
 * The API response is held until this resolves so the browser never hits a
 * "nothing listening" race when it loads the terminal iframe.
 */
export function waitForTtydReady(port: number, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const socket = new net.Socket();
      socket.setTimeout(100);
      socket.connect(port, '127.0.0.1', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`ttyd not ready on port ${port} after ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 30);
        }
      });
      socket.on('timeout', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`ttyd not ready on port ${port} after ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 30);
        }
      });
    }
    attempt();
  });
}

export function stopTtyd(sessionName: string): void {
  const proc = ttydProcesses.get(sessionName);
  if (proc && proc.pid) {
    try {
      process.kill(proc.pid, 'SIGTERM');
    } catch {
      // Already dead
    }
  }
  if (ttydProcesses.delete(sessionName)) notifyTtydStopped(sessionName);
}

export function isTtydAlive(sessionName: string): boolean {
  const proc = ttydProcesses.get(sessionName);
  if (!proc || !proc.pid) return false;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getTtydPid(sessionName: string): number | undefined {
  return ttydProcesses.get(sessionName)?.pid ?? undefined;
}

export function setTtydProcess(sessionName: string, proc: ChildProcess): void {
  ttydProcesses.set(sessionName, proc);
}

export function getTtydPidsToKill(psOutput: string, liveSessions: Set<string>): number[] {
  if (!psOutput.trim()) return [];

  const pidsToKill: number[] = [];
  for (const line of psOutput.split('\n')) {
    if (!line.includes('ttyd') || !line.includes('--writable')) continue;
    const pidMatch = line.match(/^\s*(\d+)/);
    const sessionMatch = line.match(/-b \/t\/([^/]+)\//);
    if (!pidMatch || !sessionMatch) continue;
    const pid = Number(pidMatch[1]);
    const sessionName = sessionMatch[1];
    if (!liveSessions.has(sessionName)) {
      pidsToKill.push(pid);
    }
  }

  return pidsToKill.sort((a, b) => a - b);
}

export function killOrphanedTtydProcesses(): void {
  // Get live tmux sessions
  let liveSessions: Set<string>;
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    liveSessions = new Set(out ? out.split('\n') : []);
  } catch {
    liveSessions = new Set();
  }

  // Find all ttyd processes. Only kill those whose tmux session no longer
  // exists. Duplicate live-session listeners may belong to another omniterm
  // server, so killing them can disconnect active browser terminals.
  try {
    const output = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf-8' }).trim();
    if (!output) return;

    let killed = 0;
    for (const pid of getTtydPidsToKill(output, liveSessions)) {
      try {
        process.kill(pid, 'SIGTERM');
        killed++;
      } catch {}
    }
    if (killed > 0) {
      console.log(`[cleanup] killed ${killed} stale ttyd processes`);
      trackCleanup(killed);
    }
  } catch {
    // No matching processes
  }
}
