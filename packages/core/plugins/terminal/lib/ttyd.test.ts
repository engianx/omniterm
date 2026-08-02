import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTtydPidsToKill, buildTtydArgs } from './ttyd.js';

test('buildTtydArgs: renderer defaults to webgl and coerces invalid/missing values', () => {
  const renderOf = (s: { terminalRenderer?: string }) => {
    const arg = buildTtydArgs('sess', 7700, s).find((a) => a.startsWith('rendererType='));
    return arg?.split('=')[1];
  };
  assert.equal(renderOf({}), 'webgl'); // missing → default
  assert.equal(renderOf({ terminalRenderer: 'webgl' }), 'webgl');
  assert.equal(renderOf({ terminalRenderer: 'dom' }), 'dom');
  assert.equal(renderOf({ terminalRenderer: 'canvas' }), 'webgl'); // bogus → coerced
  assert.equal(renderOf({ terminalRenderer: '' }), 'webgl');
});

test('buildTtydArgs: wires fontSize, session bind path, and port', () => {
  const args = buildTtydArgs('my-sess', 7711, { terminalFontSize: 14 });
  assert.ok(args.includes('fontSize=14'));
  assert.ok(args.includes('/t/my-sess/'));
  assert.ok(args.includes('7711'));
  assert.equal(args.includes('fontSize=18'), false);
  // fontSize falls back to 18 when unset
  assert.ok(buildTtydArgs('s', 7700, {}).includes('fontSize=18'));
});

test('getTtydPidsToKill preserves duplicate ttyd listeners for live tmux sessions', () => {
  const psOutput = [
    '  100 ttyd --writable -i 127.0.0.1 -b /t/live-session/ -p 7700 -- bash',
    '  300 ttyd --writable -i 127.0.0.1 -b /t/live-session/ -p 7701 -- bash',
    '  200 ttyd --writable -i 127.0.0.1 -b /t/live-session/ -p 7702 -- bash',
    '  400 ttyd --writable -i 127.0.0.1 -b /t/other-live/ -p 7703 -- bash',
  ].join('\n');

  const pids = getTtydPidsToKill(psOutput, new Set(['live-session', 'other-live']));

  assert.deepEqual(pids, []);
});

test('getTtydPidsToKill removes all ttyd listeners whose tmux session is gone', () => {
  const psOutput = [
    '  500 ttyd --writable -i 127.0.0.1 -b /t/dead-session/ -p 7704 -- bash',
    '  600 ttyd --writable -i 127.0.0.1 -b /t/dead-session/ -p 7705 -- bash',
    '  700 ttyd --writable -i 127.0.0.1 -b /t/live-session/ -p 7706 -- bash',
    '  800 node unrelated.js',
  ].join('\n');

  const pids = getTtydPidsToKill(psOutput, new Set(['live-session']));

  assert.deepEqual(new Set(pids), new Set([500, 600]));
  assert.equal(pids.includes(700), false);
  assert.equal(pids.includes(800), false);
});
