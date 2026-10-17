import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// paths.ts captures SETTINGS_DIR at module-import time — set it before importing.
const settingsDir = mkdtempSync(path.join(tmpdir(), 'omniterm-fs-route-settings-'));
process.env.SETTINGS_DIR = settingsDir;

const { fsRouter, containsAllowedRoot } = await import('./fs.js');
const { setExtraAllowedRoots } = await import('../../lib/allowedRoots.js');
const { saveSettings } = await import('../../lib/settings.js');

// tmpdir() is outside $HOME, so the scratch root is allowed as an extra root —
// which also makes the root itself a protected path, like a real workspace.
const root = mkdtempSync(path.join(tmpdir(), 'omniterm-fs-route-'));
setExtraAllowedRoots([root]);

const app = express();
app.use(express.json());
app.use('/api', fsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

after(async () => {
  setExtraAllowedRoots([]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(settingsDir, { recursive: true, force: true });
});

async function post(route: string, body: unknown) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function del(p: string) {
  const res = await fetch(`${base}/fs?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function scratch(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('containsAllowedRoot: the root itself and its ancestors, not siblings or children', () => {
  const roots = ['/home/u', '/srv/ws/app'];
  assert.equal(containsAllowedRoot('/home/u', roots), true);
  assert.equal(containsAllowedRoot('/srv/ws', roots), true);
  assert.equal(containsAllowedRoot('/', roots), true);
  assert.equal(containsAllowedRoot('/srv/ws/app/src', roots), false);
  assert.equal(containsAllowedRoot('/srv/ws/ap', roots), false);
  assert.equal(containsAllowedRoot('/srv/other', roots), false);
});

test('create makes an empty file and refuses to overwrite one', async () => {
  const dir = scratch('create');
  const file = path.join(dir, 'a.txt');
  const r = await post('/fs/create', { path: file });
  assert.equal(r.status, 201);
  assert.equal(r.body.path, file);
  assert.equal(readFileSync(file, 'utf-8'), '');

  writeFileSync(file, 'keep');
  assert.equal((await post('/fs/create', { path: file })).status, 409);
  assert.equal(readFileSync(file, 'utf-8'), 'keep');

  assert.equal((await post('/fs/create', { path: path.join(dir, 'missing', 'b.txt') })).status, 404);
  assert.equal((await post('/fs/create', {})).status, 400);
});

test('mkdir makes one folder; 409 when it exists, 404 without a parent', async () => {
  const dir = scratch('mkdir');
  const sub = path.join(dir, 'sub');
  assert.equal((await post('/fs/mkdir', { path: sub })).status, 201);
  assert.ok(existsSync(sub));
  assert.equal((await post('/fs/mkdir', { path: sub })).status, 409);
  assert.equal((await post('/fs/mkdir', { path: path.join(dir, 'x', 'y') })).status, 404);
});

test('rename renames and moves, never over an existing path', async () => {
  const dir = scratch('rename');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  writeFileSync(path.join(dir, 'b.txt'), 'b');
  mkdirSync(path.join(dir, 'folder'));

  const moved = await post('/fs/rename', {
    from: path.join(dir, 'a.txt'),
    to: path.join(dir, 'folder', 'c.txt'),
  });
  assert.equal(moved.status, 200);
  assert.equal(readFileSync(path.join(dir, 'folder', 'c.txt'), 'utf-8'), 'a');
  assert.ok(!existsSync(path.join(dir, 'a.txt')));

  const clash = await post('/fs/rename', {
    from: path.join(dir, 'b.txt'),
    to: path.join(dir, 'folder', 'c.txt'),
  });
  assert.equal(clash.status, 409);
  assert.equal(readFileSync(path.join(dir, 'folder', 'c.txt'), 'utf-8'), 'a');

  assert.equal(
    (await post('/fs/rename', { from: path.join(dir, 'nope'), to: path.join(dir, 'x') })).status,
    404,
  );
  assert.equal(
    (await post('/fs/rename', { from: path.join(dir, 'b.txt'), to: path.join(dir, 'no', 'b.txt') }))
      .status,
    404,
  );
  const intoSelf = await post('/fs/rename', {
    from: path.join(dir, 'folder'),
    to: path.join(dir, 'folder', 'inner'),
  });
  assert.equal(intoSelf.status, 400);
});

test('delete removes files and folders recursively, and a symlink without following it', async () => {
  const dir = scratch('delete');
  mkdirSync(path.join(dir, 'tree', 'deep'), { recursive: true });
  writeFileSync(path.join(dir, 'tree', 'deep', 'f.txt'), 'x');
  writeFileSync(path.join(dir, 'file.txt'), 'x');
  mkdirSync(path.join(dir, 'target'));
  writeFileSync(path.join(dir, 'target', 'kept.txt'), 'x');
  symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'));

  assert.equal((await del(path.join(dir, 'tree'))).status, 200);
  assert.ok(!existsSync(path.join(dir, 'tree')));
  assert.equal((await del(path.join(dir, 'file.txt'))).status, 200);
  assert.equal((await del(path.join(dir, 'link'))).status, 200);
  assert.ok(existsSync(path.join(dir, 'target', 'kept.txt')));
  assert.equal((await del(path.join(dir, 'file.txt'))).status, 404);
});

test('workspace roots and their ancestors cannot be deleted or moved', async () => {
  const parent = scratch('workspaces');
  const ws = path.join(parent, 'ws');
  mkdirSync(ws);
  saveSettings({ trackedDirs: [ws] });
  try {
    assert.equal((await del(root)).status, 400);
    assert.equal((await del(ws)).status, 400);
    assert.equal((await del(parent)).status, 400);
    assert.equal((await post('/fs/rename', { from: ws, to: path.join(parent, 'ws2') })).status, 400);
    assert.equal((await post('/fs/rename', { from: parent, to: path.join(root, 'moved') })).status, 400);
    assert.ok(existsSync(ws));
  } finally {
    saveSettings({ trackedDirs: [] });
  }
});

test('paths outside the allowed roots are refused', async () => {
  const outside = '/omniterm-fs-route-test-outside/x';
  assert.equal((await post('/fs/create', { path: outside })).status, 403);
  assert.equal((await post('/fs/mkdir', { path: outside })).status, 403);
  assert.equal((await del(outside)).status, 403);
  const file = path.join(scratch('outside'), 'f.txt');
  writeFileSync(file, 'x');
  assert.equal((await post('/fs/rename', { from: file, to: outside })).status, 403);
  assert.ok(existsSync(file));
});
