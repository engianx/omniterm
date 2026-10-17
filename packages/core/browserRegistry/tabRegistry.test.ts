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

import {
  cleanupTab,
  createTabRegistryRouter,
  LaunchRejectedError,
  listBrowsers,
  registryUrlForRequest,
} from './tabRegistry.js';

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

// POST /t/:tabId/browsers/launch — the UI's "new browser tab" for a terminal
// with no live browser. The launcher is injected, so no Chrome is started.
describe('tabRegistry browser launch', () => {
  let launchServer: http.Server;
  let launchBase: string;
  const calls: Array<{ tabId: string; registryUrl: string; url: string }> = [];
  let failWith: Error | null = null;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/t/:tabId',
      createTabRegistryRouter({
        launchBrowser: async (args) => {
          if (failWith) throw failWith;
          calls.push(args);
        },
      }),
    );
    app.use('/plain/:tabId', createTabRegistryRouter({}));
    await new Promise<void>((resolve) => {
      launchServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    launchBase = `http://127.0.0.1:${(launchServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => launchServer.close(() => resolve()));
  });

  const post = (path: string, body: unknown) =>
    fetch(`${launchBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('hands the launcher the tab and its loopback registry URL', async () => {
    calls.length = 0;
    failWith = null;
    const res = await post('/t/wt-term-3/browsers/launch', {});
    assert.equal(res.status, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tabId, 'wt-term-3');
    assert.equal(calls[0].url, 'about:blank');
    const port = (launchServer.address() as AddressInfo).port;
    assert.equal(calls[0].registryUrl, `http://127.0.0.1:${port}/t/wt-term-3/registry`);
  });

  it('passes an http(s) url through and rejects other schemes', async () => {
    calls.length = 0;
    failWith = null;
    assert.equal((await post('/t/a/browsers/launch', { url: 'https://x.dev/' })).status, 202);
    assert.equal(calls[0].url, 'https://x.dev/');
    const bad = await post('/t/a/browsers/launch', { url: 'file:///etc/passwd' });
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 1);
  });

  it('maps launcher failures to status codes with the message', async () => {
    failWith = new LaunchRejectedError('No terminal session nope');
    const rejected = await post('/t/nope/browsers/launch', {});
    assert.equal(rejected.status, 404);
    assert.deepEqual(await rejected.json(), { error: 'No terminal session nope' });
    failWith = new Error('No Chrome/Chromium binary found.');
    const broken = await post('/t/a/browsers/launch', {});
    assert.equal(broken.status, 500);
    assert.match(((await broken.json()) as { error: string }).error, /No Chrome/);
    failWith = null;
  });

  it('answers 501 when the mounting plugin has no launcher', async () => {
    const res = await post('/plain/a/browsers/launch', {});
    assert.equal(res.status, 501);
  });
});

// Page ownership claims. One Chrome is shared by every terminal, so the
// registry — not the client — records which terminal opened each page.
describe('tabRegistry page claims', () => {
  const CDP_URL = 'ws://127.0.0.1:9555/devtools/browser/shared';
  const register = (tab: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/t/${tab}/registry/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cdpUrl: CDP_URL, ...body }),
    });
  const claim = (tab: string, browserId: string, body: unknown) =>
    fetch(`${baseUrl}/t/${tab}/registry/browsers/${browserId}/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const owners = async (tab: string) => {
    const data = (await (await fetch(`${baseUrl}/t/${tab}/browsers`)).json()) as {
      browsers: Array<{ id: string; pageOwners: Record<string, string> }>;
    };
    return data.browsers[0]?.pageOwners;
  };
  /** Collect SSE events from a tab's stream until `until` matches or 2s pass. */
  const collect = (tab: string, until: (events: Array<{ type: string; data: any }>) => boolean) =>
    (async () => {
      const res = await fetch(`${baseUrl}/t/${tab}/events`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const deadline = Date.now() + 2000;
      let events: Array<{ type: string; data: any }> = [];
      while (Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
          ),
        ]);
        if (next.done) break;
        buffered += decoder.decode(next.value, { stream: true });
        events = buffered
          .split('\n\n')
          .filter((f) => f.startsWith('data: '))
          .flatMap((f) => {
            try {
              return [JSON.parse(f.slice(6))];
            } catch {
              return [];
            }
          });
        if (until(events)) break;
      }
      reader.cancel().catch(() => {});
      return events;
    })();
  const reset = () => ['cA', 'cB', 'cC'].forEach((t) => cleanupTab(t));

  it('records the targetId sent with a registration, deduped or not', async () => {
    reset();
    const a = (await (await register('cA', { targetId: 'T1' })).json()) as { id: string };
    assert.deepEqual(await owners('cA'), { T1: 'cA' });
    // Same Chrome, second terminal: a separate entry in its own registry,
    // but its claim lands in the same Chrome-wide map.
    await register('cB', { targetId: 'T2' });
    const again = (await (await register('cA', { targetId: 'T3' })).json()) as { deduped?: boolean; id: string };
    assert.equal(again.deduped, true);
    assert.equal(again.id, a.id);
    const expected = { T1: 'cA', T2: 'cB', T3: 'cA' };
    assert.deepEqual(await owners('cA'), expected);
    assert.deepEqual(await owners('cB'), expected);
    reset();
  });

  it('rejects a malformed targetId on registration', async () => {
    reset();
    assert.equal((await register('cA', { targetId: 7 })).status, 400);
    assert.equal(listBrowsers('cA').length, 0);
  });

  it('POST /registry/browsers/:id/pages claims a page; the latest claim wins', async () => {
    reset();
    const { id: idA } = (await (await register('cA', {})).json()) as { id: string };
    const { id: idB } = (await (await register('cB', {})).json()) as { id: string };
    const r1 = await claim('cA', idA, { targetId: 'P' });
    assert.equal(r1.status, 200);
    assert.deepEqual(((await r1.json()) as { pageOwners: unknown }).pageOwners, { P: 'cA' });
    await claim('cB', idB, { targetId: 'P' });
    assert.deepEqual(await owners('cA'), { P: 'cB' });
    assert.equal((await claim('cA', idA, {})).status, 400);
    assert.equal((await claim('cA', 'nope', { targetId: 'P' })).status, 404);
    reset();
  });

  it('emits `claims` to every tab listing that Chrome', async () => {
    reset();
    const { id: idA } = (await (await register('cA', {})).json()) as { id: string };
    const { id: idB } = (await (await register('cB', {})).json()) as { id: string };
    const hasClaim = (events: Array<{ type: string; data: any }>) =>
      events.some((e) => e.type === 'claims' && e.data.pageOwners?.Q === 'cA');
    const onA = collect('cA', hasClaim);
    const onB = collect('cB', hasClaim);
    await new Promise((r) => setTimeout(r, 100));
    await claim('cA', idA, { targetId: 'Q' });
    const [evA, evB] = await Promise.all([onA, onB]);
    assert.ok(hasClaim(evA), 'claimant tab sees the claim');
    const onBClaims = evB.find((e) => e.type === 'claims');
    assert.ok(onBClaims, 'the other tab sharing the Chrome sees it too');
    assert.equal(onBClaims.data.id, idB, 'addressed by that tab’s own browser id');
    // The replayed `added` carries current claims for a late joiner.
    const late = await collect('cB', (ev) => ev.some((e) => e.type === 'added'));
    assert.deepEqual(late.find((e) => e.type === 'added')?.data.pageOwners, { Q: 'cA' });
    reset();
  });

  it("cleanupTab drops that tab's claims, and tells the others", async () => {
    reset();
    await register('cA', { targetId: 'A1' });
    await register('cB', { targetId: 'B1' });
    const dropped = (events: Array<{ type: string; data: any }>) =>
      events.some((e) => e.type === 'claims' && !('A1' in e.data.pageOwners));
    const onB = collect('cB', dropped);
    await new Promise((r) => setTimeout(r, 100));
    cleanupTab('cA');
    assert.ok(dropped(await onB));
    assert.deepEqual(await owners('cB'), { B1: 'cB' });
    reset();
  });

  it('forgets a Chrome’s claims once no tab lists it', async () => {
    reset();
    const { id } = (await (await register('cA', { targetId: 'Z' })).json()) as { id: string };
    await fetch(`${baseUrl}/t/cA/registry/browsers/${id}`, { method: 'DELETE' });
    // Re-registered later (same endpoint, e.g. a reconnect): starts clean.
    await register('cC', {});
    assert.deepEqual(await owners('cC'), {});
    reset();
  });
});
