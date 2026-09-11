/**
 * Tests for the tab-local browser registry.
 *
 * Validates the URL-as-ownership invariant (Phase 6 Commit A):
 *   - Registrations land in the tab whose URL was POSTed to.
 *   - Different tab URLs yield isolated browser lists.
 *   - SSE events emit on add/remove.
 *   - cleanupTab drops everything for a tab.
 *
 * Uses Express + a real http.Server on a random port so each test exercises
 * the actual routing surface clients will hit. node:test runner.
 */

import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import express from 'express';
import * as http from 'http';
import { AddressInfo } from 'net';

import { cleanupTab, createTabRegistryRouter, listBrowsers, registryUrlForRequest } from './tabRegistry.js';

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/t/:tabId', createTabRegistryRouter({ devtoolsFrontendUrl: 'http://test/devtools/' }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('tabRegistry', () => {
  it('POST /t/:tabId/registry/browsers stores entry under that tab', async () => {
    cleanupTab('tabA');
    const res = await fetch(`${baseUrl}/t/tabA/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        label: 'test-1',
        pid: 99999,
      }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { id: string; entry: { id: string; label: string } };
    assert.equal(data.id, '1');
    assert.equal(data.entry.label, 'test-1');
    assert.equal(listBrowsers('tabA').length, 1);
    cleanupTab('tabA');
  });

  it('rejects POST without cdpUrl', async () => {
    cleanupTab('tabA');
    const res = await fetch(`${baseUrl}/t/tabA/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'no-url' }),
    });
    assert.equal(res.status, 400);
    assert.equal(listBrowsers('tabA').length, 0);
  });

  it("isolates tabs — registrations to tabA don't appear in tabB", async () => {
    cleanupTab('tabA');
    cleanupTab('tabB');
    await fetch(`${baseUrl}/t/tabA/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cdpUrl: 'ws://test/x' }),
    });
    const tabA = (await (await fetch(`${baseUrl}/t/tabA/browsers`)).json()) as {
      browsers: unknown[];
    };
    const tabB = (await (await fetch(`${baseUrl}/t/tabB/browsers`)).json()) as {
      browsers: unknown[];
    };
    assert.equal(tabA.browsers.length, 1);
    assert.equal(tabB.browsers.length, 0);
    cleanupTab('tabA');
    cleanupTab('tabB');
  });

  it('DELETE removes the entry and is idempotent', async () => {
    cleanupTab('tabC');
    const post = await fetch(`${baseUrl}/t/tabC/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cdpUrl: 'ws://test/y' }),
    });
    const { id } = (await post.json()) as { id: string };
    const del1 = await fetch(`${baseUrl}/t/tabC/registry/browsers/${id}`, { method: 'DELETE' });
    assert.equal(del1.status, 200);
    const del2 = await fetch(`${baseUrl}/t/tabC/registry/browsers/${id}`, { method: 'DELETE' });
    assert.equal(del2.status, 404, 'second delete should return 404');
    assert.equal(listBrowsers('tabC').length, 0);
  });

  it('GET /t/:tabId/browsers returns the discovery-shaped view', async () => {
    cleanupTab('tabD');
    await fetch(`${baseUrl}/t/tabD/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/xyz',
        label: 'view-test',
      }),
    });
    const res = await fetch(`${baseUrl}/t/tabD/browsers`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      browsers: Array<{
        id: string;
        label: string;
        browserCdpUrl: string;
        pageCdpUrlTemplate: string;
        devtoolsFrontendUrl: string;
      }>;
    };
    assert.equal(data.browsers.length, 1);
    const b = data.browsers[0];
    assert.equal(b.label, 'view-test');
    assert.equal(b.browserCdpUrl, 'ws://127.0.0.1:9222/devtools/browser/xyz');
    assert.equal(b.pageCdpUrlTemplate, 'ws://127.0.0.1:9222/devtools/page/{targetId}');
    assert.equal(b.devtoolsFrontendUrl, 'http://test/devtools/');
    cleanupTab('tabD');
  });

  // The UI's browser switcher labels each entry with pid + uptime, because
  // the omniterm-browser shim registers every Chrome it launches under the
  // same hardcoded label. Dropping pid in toView would make two concurrent
  // browsers indistinguishable in that menu.
  it('GET /t/:tabId/browsers carries pid through, and omits it when unreported', async () => {
    cleanupTab('tabPid');
    await fetch(`${baseUrl}/t/tabPid/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Own pid: guaranteed alive, so the 5s pid-liveness sweep can't evict
      // the entry out from under a slow run.
      body: JSON.stringify({ cdpUrl: 'ws://127.0.0.1:9333/devtools/browser/a', pid: process.pid }),
    });
    await fetch(`${baseUrl}/t/tabPid/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cdpUrl: 'ws://127.0.0.1:9444/devtools/browser/b' }),
    });
    const res = await fetch(`${baseUrl}/t/tabPid/browsers`);
    const data = (await res.json()) as { browsers: Array<{ pid?: number }> };
    assert.equal(data.browsers.length, 2);
    assert.equal(data.browsers[0].pid, process.pid);
    assert.equal(data.browsers[1].pid, undefined);
    cleanupTab('tabPid');
  });

  it("cleanupTab clears the tab's entire registry", async () => {
    await fetch(`${baseUrl}/t/tabE/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cdpUrl: 'ws://a' }),
    });
    await fetch(`${baseUrl}/t/tabE/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cdpUrl: 'ws://b' }),
    });
    assert.equal(listBrowsers('tabE').length, 2);
    cleanupTab('tabE');
    assert.equal(listBrowsers('tabE').length, 0);
  });

  it('SSE /t/:tabId/events emits added on registration', async () => {
    cleanupTab('tabF');
    // EventSource not available in node test runtime; consume the SSE
    // stream as a chunked HTTP body and parse manually.
    const eventsP = (async () => {
      const res = await fetch(`${baseUrl}/t/tabF/events`);
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const events: unknown[] = [];
      // Read enough chunks to capture the registration event we trigger.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (const frame of buffered.split('\n\n')) {
          if (!frame.startsWith('data: ')) continue;
          try {
            events.push(JSON.parse(frame.slice(6)));
          } catch {}
        }
        if (events.length >= 1) break;
      }
      reader.cancel().catch(() => {});
      return events;
    })();

    // Give the SSE stream a moment to attach before triggering.
    await new Promise((r) => setTimeout(r, 100));
    await fetch(`${baseUrl}/t/tabF/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cdpUrl: 'ws://test/sse-1', label: 'sse-test' }),
    });
    const events = await eventsP;
    cleanupTab('tabF');
    assert.ok(events.length > 0, 'expected at least one SSE event');
    const added = events.find(
      (e): e is { type: string; data: { label: string } } =>
        typeof e === 'object' && e !== null && (e as { type?: unknown }).type === 'added',
    );
    assert.ok(added, 'expected an `added` event');
    assert.equal(added.data.label, 'sse-test');
  });
});

// Regression: the registry URL used to be built from `req.headers.host`, which
// is whatever hostname the BROWSER used to reach omniterm. Behind a proxy on a
// hosted box that is a public, authenticated hostname, so the shim — running
// inside the box with no session cookie — POSTed there and got 401, and no
// browser ever reached the UI. It worked on macOS only because the developer
// browses localhost, which made the header loopback by accident.
describe('registryUrlForRequest', () => {
  it('ignores the Host header and uses loopback', () => {
    const req = {
      headers: { host: 'box.example.com' },
      socket: { localPort: 17716 },
    } as unknown as Parameters<typeof registryUrlForRequest>[0];
    const url = registryUrlForRequest(req, 'tab-1');
    assert.equal(url, 'http://127.0.0.1:17716/t/tab-1/registry');
    assert.ok(!url.includes('box.example.com'));
  });

  it('uses the port the connection actually landed on', () => {
    const req = { socket: { localPort: 12345 } } as unknown as Parameters<
      typeof registryUrlForRequest
    >[0];
    assert.equal(registryUrlForRequest(req, 't'), 'http://127.0.0.1:12345/t/t/registry');
  });

  it('falls back to OMNITERM_PORT, then the server default', () => {
    const noSocket = {} as unknown as Parameters<typeof registryUrlForRequest>[0];
    const prev = process.env.OMNITERM_PORT;
    try {
      process.env.OMNITERM_PORT = '18080';
      assert.equal(registryUrlForRequest(noSocket, 't'), 'http://127.0.0.1:18080/t/t/registry');
      delete process.env.OMNITERM_PORT;
      // 17717 is startServer's default port — the old inline fallback said 17716.
      assert.equal(registryUrlForRequest(noSocket, 't'), 'http://127.0.0.1:17717/t/t/registry');
    } finally {
      if (prev === undefined) delete process.env.OMNITERM_PORT;
      else process.env.OMNITERM_PORT = prev;
    }
  });
});
