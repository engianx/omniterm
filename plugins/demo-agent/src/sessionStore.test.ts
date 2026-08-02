import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore, deriveTitle } from './sessionStore.js';

test('deriveTitle trims, collapses whitespace, and truncates long prompts', () => {
  assert.equal(deriveTitle('  hello   world  '), 'hello world');
  assert.equal(deriveTitle(''), 'Untitled session');
  const long = 'a'.repeat(200);
  const title = deriveTitle(long);
  assert.ok(title.length <= 61, `expected truncated title, got length ${title.length}`);
  assert.ok(title.endsWith('…'));
});

test('SessionStore round-trips a record with events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-agent-store-'));
  try {
    const store = new SessionStore(dir);
    const rec = store.create('a-test', 'first prompt');
    assert.equal(rec.id, 'a-test');
    assert.equal(rec.title, 'first prompt');

    store.appendEvent('a-test', { type: 'assistant', message: { content: [] } });
    store.setSdkSessionId('a-test', 'sdk-xyz');

    const loaded = store.get('a-test');
    assert.ok(loaded);
    assert.equal(loaded.sdkSessionId, 'sdk-xyz');
    assert.equal(loaded.events.length, 1);
    assert.equal(loaded.events[0]?.type, 'assistant');

    assert.equal(store.list().length, 1);
    assert.equal(store.delete('a-test'), true);
    assert.equal(store.get('a-test'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStore rejects path-traversal ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-agent-store-'));
  try {
    const store = new SessionStore(dir);
    assert.throws(() => store.get('../escape'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
