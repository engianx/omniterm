/**
 * The omniterm-browser shim reports the page it opened, so the registry can
 * record which terminal owns it (one Chrome is shared by every terminal).
 *
 * Runs the real shim against a FAKE Chrome: a small node script, passed as
 * OMNITERM_CHROME_PATH, that writes DevToolsActivePort and SingletonLock like
 * Chrome does and answers the two CDP HTTP endpoints the shim uses
 * (/json/list, /json/new). No real browser is launched, so none of the
 * re-exec / leaked-Chrome cleanup in browserShims.integration.test.ts applies;
 * the fake's own pid is the one in SingletonLock, and it exits on its own
 * after a timeout even if this test dies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { cleanupTab, createTabRegistryRouter } from '../../../browserRegistry/tabRegistry.js';

const SHIM = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../bin/omniterm-browser.js',
);

const FAKE_CHROME = `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const args = process.argv.slice(2);
const udd = args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const url = args.filter((a) => !a.startsWith('--')).pop() || 'about:blank';
// A DevTools window is a page target too; the shim must not claim it.
const targets = [
  { id: 'devtools-1', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
  { id: 'initial-1', type: 'page', url },
];
let n = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/json/list') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(targets));
  } else if (u.pathname === '/json/new' && req.method === 'PUT') {
    const t = { id: 'new-' + ++n, type: 'page', url: decodeURIComponent(u.search.slice(1)) };
    targets.push(t);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(t));
  } else {
    res.statusCode = req.method === 'GET' && u.pathname === '/json/new' ? 405 : 404;
    res.end();
  }
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(udd, 'DevToolsActivePort'), server.address().port + '\\n/devtools/browser/fake');
  try { fs.unlinkSync(path.join(udd, 'SingletonLock')); } catch {}
  fs.symlinkSync(os.hostname() + '-' + process.pid, path.join(udd, 'SingletonLock'));
});
setTimeout(() => process.exit(0), 30000).unref();
process.on('SIGTERM', () => process.exit(0));
`;

function runShim(env: NodeJS.ProcessEnv, url: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    // Async on purpose: the registry answering the shim lives in this process.
    execFile(process.execPath, [SHIM, url], { env, timeout: 20_000 }, (err, _out, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr: String(stderr) });
    });
  });
}

test('shim claims the cold-start page and each warm-path page for its own tab', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'omnitest-shimclaims-'));
  const udd = path.join(root, 'udd');
  const fake = path.join(root, 'fake-chrome');
  writeFileSync(fake, FAKE_CHROME);
  chmodSync(fake, 0o755);

  const app = express();
  app.use(express.json());
  app.use('/t/:tabId', createTabRegistryRouter({}));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = (tab: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: root,
    OMNITERM_BROWSER_UDD: udd,
    OMNITERM_CHROME_PATH: fake,
    OMNITERM_BROWSER_HEADLESS: '1',
    OMNITERM_BROWSER_REGISTRY_URL: `${base}/t/${tab}/registry`,
  });
  const owners = async (tab: string) => {
    const data = (await (await fetch(`${base}/t/${tab}/browsers`)).json()) as {
      browsers: Array<{ pageOwners: Record<string, string> }>;
    };
    return data.browsers[0]?.pageOwners;
  };

  try {
    const cold = await runShim(env('shimA'), 'https://login.example/start');
    assert.equal(cold.code, 0, cold.stderr);
    assert.deepEqual(await owners('shimA'), { 'initial-1': 'shimA' });

    // Another terminal opens a page in the same (running) Chrome.
    const warm = await runShim(env('shimB'), 'https://docs.example/');
    assert.equal(warm.code, 0, warm.stderr);
    assert.match(warm.stderr, /page=new-1/);
    const expected = { 'initial-1': 'shimA', 'new-1': 'shimB' };
    assert.deepEqual(await owners('shimA'), expected);
    assert.deepEqual(await owners('shimB'), expected);
  } finally {
    // Stop the fake by the pid in SingletonLock (it is the process that wrote it).
    try {
      const pid = Number(readlinkSync(path.join(udd, 'SingletonLock')).split('-').pop());
      if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM');
    } catch {}
    cleanupTab('shimA');
    cleanupTab('shimB');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
