import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getOrCreateInstallId, readState, markNoticeShown } from './installId.js';

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'omniterm-tele-'));
  return path.join(dir, 'telemetry.json');
}

test('getOrCreateInstallId creates, persists, and is idempotent', () => {
  const file = tempFile();
  try {
    assert.equal(existsSync(file), false);
    const id1 = getOrCreateInstallId(file);
    assert.match(id1, /^[0-9a-f-]{36}$/);
    assert.equal(existsSync(file), true);

    // Second call returns the same persisted id.
    const id2 = getOrCreateInstallId(file);
    assert.equal(id2, id1);
    assert.equal(readState(file)?.installId, id1);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('readState returns null for a missing or corrupt file', () => {
  const file = tempFile();
  try {
    assert.equal(readState(file), null);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('markNoticeShown preserves the install id and is idempotent', () => {
  const file = tempFile();
  try {
    const id = getOrCreateInstallId(file);
    markNoticeShown(file);
    assert.equal(readState(file)?.noticeShown, true);
    assert.equal(readState(file)?.installId, id);

    markNoticeShown(file); // idempotent
    assert.equal(readState(file)?.noticeShown, true);
    assert.equal(readState(file)?.installId, id);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
