import assert from 'node:assert/strict';
import test from 'node:test';
import { worktreeDeleteUrl, worktreeStatusUrl, probeIsDirty } from './worktreeDelete';

test('worktreeDeleteUrl forces only when dirty', () => {
  assert.equal(
    worktreeDeleteUrl('/src/app-x', true),
    '/api/workspaces/worktrees?path=%2Fsrc%2Fapp-x&force=true',
  );
  assert.equal(worktreeDeleteUrl('/src/app-x', false), '/api/workspaces/worktrees?path=%2Fsrc%2Fapp-x');
});

test('worktreeDeleteUrl encodes the path so special chars do not break the URL', () => {
  // A worktree path with ?, # or & would otherwise truncate or split the query.
  assert.equal(
    worktreeDeleteUrl('/a?b#c&force=true', false),
    '/api/workspaces/worktrees?path=%2Fa%3Fb%23c%26force%3Dtrue',
  );
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
