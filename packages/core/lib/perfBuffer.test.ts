import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordPerf, getRecent, clear, PERF_BUFFER_CAP } from './perfBuffer.js';

test('recordPerf appends records in order and getRecent returns a copy', () => {
  clear();
  recordPerf('session_created', { total_ms: 10 }, 1000);
  recordPerf('session_adopted', { total_ms: 20 }, 2000);

  const recent = getRecent();
  assert.equal(recent.length, 2);
  assert.deepEqual(recent[0], { op: 'session_created', timings: { total_ms: 10 }, at: 1000 });
  assert.equal(recent[1].op, 'session_adopted');

  // Mutating the returned array must not affect the buffer.
  recent.push({ op: 'x', timings: {}, at: 0 });
  assert.equal(getRecent().length, 2);
});

test('buffer is bounded to the cap, evicting oldest', () => {
  clear();
  for (let i = 0; i < PERF_BUFFER_CAP + 25; i++) {
    recordPerf('op', { i }, i);
  }
  const recent = getRecent();
  assert.equal(recent.length, PERF_BUFFER_CAP);
  // Oldest 25 evicted → first remaining is i=25.
  assert.equal(recent[0].timings.i, 25);
  assert.equal(recent[recent.length - 1].timings.i, PERF_BUFFER_CAP + 24);
});
