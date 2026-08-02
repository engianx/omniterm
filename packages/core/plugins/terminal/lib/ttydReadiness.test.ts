import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSessionTtydReadiness,
  createSessionTtydReadinessState,
  ensureSessionTtydReadyWithState,
  type SessionTtydReadinessRuntime,
} from './ttydReadiness.js';
import type { Session } from './sessions.js';

function testSession(name: string): Session {
  return {
    id: name,
    worktreeId: '_orphan',
    tmuxName: name,
    port: 7700,
    createdAt: new Date(0).toISOString(),
  };
}

test('ensureSessionTtydReady skips TCP probes after a session is marked ready', async () => {
  const session = testSession('ready-session');
  const state = createSessionTtydReadinessState();
  let waitCalls = 0;
  const runtime: SessionTtydReadinessRuntime = {
    isTtydAlive: () => true,
    spawnTtyd: () => {
      throw new Error('spawn should not be called for an alive ttyd process');
    },
    waitForTtydReady: async () => {
      waitCalls++;
    },
  };

  await ensureSessionTtydReadyWithState(session, 3000, runtime, state);
  await ensureSessionTtydReadyWithState(session, 3000, runtime, state);

  assert.equal(waitCalls, 1);
});

test('ensureSessionTtydReady shares one in-flight readiness probe for concurrent callers', async () => {
  const session = testSession('concurrent-session');
  const state = createSessionTtydReadinessState();
  let alive = false;
  let spawnCalls = 0;
  let waitCalls = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const runtime: SessionTtydReadinessRuntime = {
    isTtydAlive: () => alive,
    spawnTtyd: () => {
      spawnCalls++;
      alive = true;
    },
    waitForTtydReady: async () => {
      waitCalls++;
      await ready;
    },
  };

  const first = ensureSessionTtydReadyWithState(session, 3000, runtime, state);
  const second = ensureSessionTtydReadyWithState(session, 3000, runtime, state);

  assert.equal(spawnCalls, 1);
  assert.equal(waitCalls, 1);

  resolveReady();
  await Promise.all([first, second]);
  await ensureSessionTtydReadyWithState(session, 3000, runtime, state);

  assert.equal(spawnCalls, 1);
  assert.equal(waitCalls, 1);
});

test('ensureSessionTtydReady rejects concurrent callers when pending readiness is invalidated', async () => {
  const session = testSession('invalidated-session');
  const state = createSessionTtydReadinessState();
  let waitCalls = 0;
  const readyResolvers: Array<() => void> = [];
  const runtime: SessionTtydReadinessRuntime = {
    isTtydAlive: () => true,
    spawnTtyd: () => {
      throw new Error('spawn should not be called for an alive ttyd process');
    },
    waitForTtydReady: async () => {
      waitCalls++;
      await new Promise<void>((resolve) => readyResolvers.push(resolve));
    },
  };

  const first = ensureSessionTtydReadyWithState(session, 3000, runtime, state);
  const second = ensureSessionTtydReadyWithState(session, 3000, runtime, state);

  assert.equal(waitCalls, 1);
  clearSessionTtydReadiness(session.tmuxName, state);
  readyResolvers.shift()?.();

  await assert.rejects(first, /ttyd readiness invalidated for invalidated-session/);
  await assert.rejects(second, /ttyd readiness invalidated for invalidated-session/);
  assert.equal(state.readySessionNames.has(session.tmuxName), false);

  const third = ensureSessionTtydReadyWithState(session, 3000, runtime, state);
  assert.equal(waitCalls, 2);
  readyResolvers.shift()?.();
  await third;

  assert.equal(state.readySessionNames.has(session.tmuxName), true);
});

test('clearSessionTtydReadiness forces the next readiness check to probe again', async () => {
  const session = testSession('cleared-session');
  const state = createSessionTtydReadinessState();
  let waitCalls = 0;
  const runtime: SessionTtydReadinessRuntime = {
    isTtydAlive: () => true,
    spawnTtyd: () => {
      throw new Error('spawn should not be called for an alive ttyd process');
    },
    waitForTtydReady: async () => {
      waitCalls++;
    },
  };

  await ensureSessionTtydReadyWithState(session, 3000, runtime, state);
  clearSessionTtydReadiness(session.tmuxName, state);
  await ensureSessionTtydReadyWithState(session, 3000, runtime, state);

  assert.equal(waitCalls, 2);
});
