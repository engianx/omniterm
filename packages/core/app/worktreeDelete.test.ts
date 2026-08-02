import assert from 'node:assert/strict';
import test from 'node:test';
import { worktreeDeleteUrl, worktreeStatusUrl, probeIsDirty } from './worktreeDelete';

test('worktreeDeleteUrl forces only when dirty', () => {
  assert.equal(worktreeDeleteUrl('wt-x', true), '/api/worktrees/wt-x?force=true');
  assert.equal(worktreeDeleteUrl('wt-x', false), '/api/worktrees/wt-x');
});

test('worktreeDeleteUrl encodes the id so special chars do not break the URL', () => {
  // A branch/worktree name with ? or # would otherwise truncate the path.
  assert.equal(worktreeDeleteUrl('wt-a?b', true), '/api/worktrees/wt-a%3Fb?force=true');
  assert.equal(worktreeDeleteUrl('wt-a#b', true), '/api/worktrees/wt-a%23b?force=true');
  assert.equal(worktreeDeleteUrl('wt-a b', false), '/api/worktrees/wt-a%20b');
});

test('worktreeStatusUrl encodes the id like the delete URL', () => {
  assert.equal(worktreeStatusUrl('wt-x'), '/api/worktrees/wt-x/status');
  assert.equal(worktreeStatusUrl('wt-a?b'), '/api/worktrees/wt-a%3Fb/status');
  assert.equal(worktreeStatusUrl('wt-a#b'), '/api/worktrees/wt-a%23b/status');
});

test('probeIsDirty: explicit dirty flag from a 2xx response is honored', () => {
  assert.equal(probeIsDirty(true, { dirty: true }), true);
  assert.equal(probeIsDirty(true, { dirty: false }), false);
});

test('probeIsDirty fails safe to dirty for anything but an explicit clean signal', () => {
  // Non-OK response: ignore the body entirely, assume dirty.
  assert.equal(probeIsDirty(false, { dirty: false }), true);
  // 2xx but malformed/garbled body: missing field, null, wrong shape → dirty.
  assert.equal(probeIsDirty(true, {}), true, 'missing dirty field');
  assert.equal(probeIsDirty(true, null), true, 'null body');
  assert.equal(probeIsDirty(true, 'nope'), true, 'non-object body');
});
