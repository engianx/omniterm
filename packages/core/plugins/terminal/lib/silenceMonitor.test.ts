import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTmuxActivitySnapshots,
  updateSilenceStates,
  type SilenceEvent,
  type SilenceSessionState,
  type TmuxActivitySnapshot,
} from './silenceMonitor.js';

test('parseTmuxActivitySnapshots keeps latest activity and active pane cwd', () => {
  const snapshots = parseTmuxActivitySnapshots(
    [
      'tracked\t100\t1\t0\t/workspace/inactive-pane',
      'ignored\t150\t1\t1\t/other',
      'tracked\t120\t0\t1\t/workspace/background-window',
      'tracked\t130\t0\t0\t/workspace/latest-background',
      'tracked\t110\t1\t1\t/workspace/active-pane',
      'bad\tnot-a-number\t1\t1\t/nope',
      'blank\t\t1\t1\t/nope',
    ].join('\n'),
    new Set(['tracked', 'bad', 'blank']),
  );

  assert.deepEqual(
    [...snapshots.entries()],
    [['tracked', { activitySeconds: 130, path: '/workspace/active-pane' }]],
  );
});

test('updateSilenceStates emits once after a long active burst goes quiet', () => {
  const states = new Map<string, SilenceSessionState>([
    ['session-a', { lastActivitySeconds: null, activeSinceSeconds: null, path: '' }],
  ]);
  const emitted: SilenceEvent[] = [];

  update(states, new Map([['session-a', { activitySeconds: 100, path: '/repo' }]]), 100, emitted);
  assert.deepEqual(emitted, []);

  update(states, new Map([['session-a', { activitySeconds: 105, path: '/repo' }]]), 105, emitted);
  assert.deepEqual(emitted, []);

  update(states, new Map([['session-a', { activitySeconds: 130, path: '/repo' }]]), 130, emitted);
  assert.deepEqual(emitted, []);

  update(states, new Map([['session-a', { activitySeconds: 130, path: '/repo' }]]), 144, emitted);
  assert.deepEqual(emitted, []);

  update(states, new Map([['session-a', { activitySeconds: 130, path: '/repo' }]]), 145, emitted);
  assert.deepEqual(emitted, [{ sessionId: 'session-a', path: '/repo' }]);

  update(states, new Map([['session-a', { activitySeconds: 130, path: '/repo' }]]), 160, emitted);
  assert.deepEqual(emitted, [{ sessionId: 'session-a', path: '/repo' }]);
});

test('updateSilenceStates suppresses short active bursts', () => {
  const states = new Map<string, SilenceSessionState>([
    ['session-a', { lastActivitySeconds: null, activeSinceSeconds: null, path: '' }],
  ]);
  const emitted: SilenceEvent[] = [];

  update(states, new Map([['session-a', { activitySeconds: 100, path: '/repo' }]]), 100, emitted);
  update(states, new Map([['session-a', { activitySeconds: 105, path: '/repo' }]]), 105, emitted);
  update(states, new Map([['session-a', { activitySeconds: 105, path: '/repo' }]]), 120, emitted);

  assert.deepEqual(emitted, []);
  assert.equal(states.get('session-a')?.activeSinceSeconds, null);
});

test('updateSilenceStates does not count quiet time toward active cooldown', () => {
  const states = new Map<string, SilenceSessionState>([
    ['session-a', { lastActivitySeconds: null, activeSinceSeconds: null, path: '' }],
  ]);
  const emitted: SilenceEvent[] = [];

  update(states, new Map([['session-a', { activitySeconds: 100, path: '/repo' }]]), 100, emitted);
  update(states, new Map([['session-a', { activitySeconds: 105, path: '/repo' }]]), 105, emitted);
  update(states, new Map([['session-a', { activitySeconds: 111, path: '/repo' }]]), 111, emitted);
  update(states, new Map([['session-a', { activitySeconds: 111, path: '/repo' }]]), 126, emitted);

  assert.deepEqual(emitted, []);
  assert.equal(states.get('session-a')?.activeSinceSeconds, null);
});

test('updateSilenceStates retries a valid silence event until cwd is available', () => {
  const states = new Map<string, SilenceSessionState>([
    ['session-a', { lastActivitySeconds: null, activeSinceSeconds: null, path: '' }],
  ]);
  const emitted: SilenceEvent[] = [];

  update(states, new Map([['session-a', { activitySeconds: 100, path: '' }]]), 100, emitted);
  update(states, new Map([['session-a', { activitySeconds: 120, path: '' }]]), 120, emitted);
  update(states, new Map([['session-a', { activitySeconds: 145, path: '' }]]), 145, emitted);
  update(states, new Map([['session-a', { activitySeconds: 145, path: '' }]]), 160, emitted);

  assert.deepEqual(emitted, []);
  assert.equal(states.get('session-a')?.activeSinceSeconds, 120);

  update(states, new Map([['session-a', { activitySeconds: 145, path: '/repo' }]]), 161, emitted);

  assert.deepEqual(emitted, [{ sessionId: 'session-a', path: '/repo' }]);
  assert.equal(states.get('session-a')?.activeSinceSeconds, null);
});

test('updateSilenceStates ignores sessions added after the poll snapshot', () => {
  const states = new Map<string, SilenceSessionState>([
    ['existing', { lastActivitySeconds: 100, activeSinceSeconds: null, path: '/repo' }],
    ['new', { lastActivitySeconds: null, activeSinceSeconds: null, path: '' }],
  ]);

  updateSilenceStates(
    states,
    new Map([['existing', { activitySeconds: 100, path: '/repo' }]]),
    120,
    () => {},
    {
      trackedSessions: new Set(['existing']),
    },
  );

  assert.equal(states.has('new'), true);
  assert.equal(states.get('new')?.missingPolls, undefined);
});

test('updateSilenceStates tolerates one missing tmux snapshot before dropping session', () => {
  const states = new Map<string, SilenceSessionState>([
    ['gone', { lastActivitySeconds: 100, activeSinceSeconds: null, path: '/repo' }],
  ]);
  const deleted: string[] = [];

  updateSilenceStates(states, new Map(), 120, () => {}, {
    onSessionDeleted: (sessionName) => deleted.push(sessionName),
  });

  assert.equal(states.has('gone'), true);
  assert.equal(states.get('gone')?.missingPolls, 1);
  assert.equal(deleted.length, 0);

  updateSilenceStates(states, new Map(), 123, () => {}, {
    onSessionDeleted: (sessionName) => deleted.push(sessionName),
  });

  assert.equal(states.has('gone'), false);
  assert.deepEqual(deleted, ['gone']);
});

function update(
  states: Map<string, SilenceSessionState>,
  snapshots: ReadonlyMap<string, TmuxActivitySnapshot>,
  now: number,
  emitted: SilenceEvent[],
): void {
  updateSilenceStates(states, snapshots, now, (event) => emitted.push(event));
}
