import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWorktreeSessionReadinessError } from './worktreeSessionErrors.js';

test('sendWorktreeSessionReadinessError cleans up the session and returns 503 JSON', () => {
  const deleted: string[] = [];
  let statusCode: number | undefined;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };

  sendWorktreeSessionReadinessError(res, { id: 'wt-term-1' }, new Error('ttyd not ready'), (id) => {
    deleted.push(id);
    return true;
  });

  assert.deepEqual(deleted, ['wt-term-1']);
  assert.equal(statusCode, 503);
  assert.deepEqual(body, { error: 'ttyd not ready' });
});
