import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveWorkspacePanelState,
  updateWorkspacePanelState,
} from './workspacePanelState';

test('workspace pane visibility remains isolated while switching paths', () => {
  let states = {};

  states = updateWorkspacePanelState(states, '/workspace/a', 'browserOpen', false, false);
  states = updateWorkspacePanelState(states, '/workspace/a', 'filesOpen', true, false);
  states = updateWorkspacePanelState(states, '/workspace/b', 'browserOpen', true, false);

  assert.deepStrictEqual(resolveWorkspacePanelState(states, '/workspace/a', false), {
    browserOpen: false,
    filesOpen: true,
  });
  assert.deepStrictEqual(resolveWorkspacePanelState(states, '/workspace/b', false), {
    browserOpen: true,
    filesOpen: false,
  });
});

test('missing workspace visibility uses responsive browser and closed-file defaults', () => {
  assert.deepStrictEqual(resolveWorkspacePanelState({}, '/workspace/a', false), {
    browserOpen: true,
    filesOpen: false,
  });
  assert.deepStrictEqual(resolveWorkspacePanelState({}, '/workspace/a', true), {
    browserOpen: false,
    filesOpen: false,
  });
  assert.deepStrictEqual(resolveWorkspacePanelState({}, null, false), {
    browserOpen: false,
    filesOpen: false,
  });
});

test('functional updates resolve a legacy null browser value before toggling', () => {
  const states = updateWorkspacePanelState(
    { '/workspace/a': { browserOpen: null, filesOpen: false } },
    '/workspace/a',
    'browserOpen',
    (open) => !open,
    false,
  );

  assert.strictEqual(states['/workspace/a'].browserOpen, false);
});
