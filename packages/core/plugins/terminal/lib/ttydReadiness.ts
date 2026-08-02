import type { Session } from './sessions.js';

export interface SessionTtydReadinessRuntime {
  isTtydAlive(sessionName: string): boolean;
  spawnTtyd(sessionName: string, port: number): void;
  waitForTtydReady(port: number, timeoutMs: number): Promise<void>;
}

export interface SessionTtydReadinessState {
  readySessionNames: Set<string>;
  pendingReadiness: Map<string, Promise<void>>;
  generations: Map<string, number>;
}

export function createSessionTtydReadinessState(): SessionTtydReadinessState {
  return {
    readySessionNames: new Set(),
    pendingReadiness: new Map(),
    generations: new Map(),
  };
}

export function clearSessionTtydReadiness(
  sessionName: string,
  state: SessionTtydReadinessState,
): void {
  state.readySessionNames.delete(sessionName);
  state.pendingReadiness.delete(sessionName);
  state.generations.set(sessionName, (state.generations.get(sessionName) ?? 0) + 1);
}

export async function ensureSessionTtydReadyWithState(
  session: Session,
  timeoutMs: number,
  runtime: SessionTtydReadinessRuntime,
  state: SessionTtydReadinessState,
): Promise<void> {
  const sessionName = session.tmuxName;
  if (state.readySessionNames.has(sessionName)) {
    if (runtime.isTtydAlive(sessionName)) return;
    clearSessionTtydReadiness(sessionName, state);
  }

  const pending = state.pendingReadiness.get(sessionName);
  if (pending) {
    await pending;
    if (state.readySessionNames.has(sessionName) && runtime.isTtydAlive(sessionName)) return;
    throw new Error(`ttyd readiness invalidated for ${sessionName}`);
  }

  let generation = state.generations.get(sessionName) ?? 0;
  if (!runtime.isTtydAlive(sessionName)) {
    clearSessionTtydReadiness(sessionName, state);
    generation = state.generations.get(sessionName) ?? 0;
    runtime.spawnTtyd(sessionName, session.port);
  }

  const readiness = runtime
    .waitForTtydReady(session.port, timeoutMs)
    .then(() => {
      if ((state.generations.get(sessionName) ?? 0) !== generation) {
        throw new Error(`ttyd readiness invalidated for ${sessionName}`);
      }
      if (!runtime.isTtydAlive(sessionName)) {
        clearSessionTtydReadiness(sessionName, state);
        throw new Error(`ttyd exited before readiness completed for ${sessionName}`);
      }
      state.readySessionNames.add(sessionName);
    })
    .finally(() => {
      // A stale readiness promise can settle after the session was cleared
      // and a newer probe was registered; only the current probe may delete.
      if (state.pendingReadiness.get(sessionName) === readiness) {
        state.pendingReadiness.delete(sessionName);
      }
    });
  state.pendingReadiness.set(sessionName, readiness);
  await readiness;
}
