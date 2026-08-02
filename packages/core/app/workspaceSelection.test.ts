import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldResetWorkspaceTabs } from './workspaceSelection';

test('selecting the current workspace does not reset tabs', () => {
  assert.equal(shouldResetWorkspaceTabs('/workspace/project', '/workspace/project'), false);
});

test('selecting no workspace when no workspace is active does not reset tabs', () => {
  assert.equal(shouldResetWorkspaceTabs(null, null), false);
});

test('selecting a different workspace resets tabs', () => {
  assert.equal(shouldResetWorkspaceTabs('/workspace/project', '/workspace/other'), true);
});

test('selecting the first workspace from a blank state resets tabs', () => {
  assert.equal(shouldResetWorkspaceTabs(null, '/workspace/project'), true);
});

test('selecting home from an active workspace resets tabs', () => {
  assert.equal(shouldResetWorkspaceTabs('/workspace/project', null), true);
});
