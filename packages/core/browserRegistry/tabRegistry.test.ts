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

import { cleanupTab, createTabRegistryRouter, listBrowsers } from './tabRegistry.js';

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
