import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Tab } from '../app/types.js';
import {
  browserTabId,
  isUserPage,
  pageKey,
  pageTabName,
  parseBrowserTabId,
  pickOwnerForNewPage,
  reconcileBrowserTabs,
  resolvePageOwner,
  type BrowserState,
  type OwnerState,
  type PageAssignment,
  type ReconcileInput,
} from './browserTabs.js';

const CDP = 'ws://127.0.0.1:9222/devtools/browser/abc';
const term = (id: string): Tab => ({ type: 'terminal', id, name: id });
const page = (
  targetId: string,
  opts: { title?: string; url?: string; fresh?: boolean; openerId?: string; pendingClaim?: boolean } = {},
) => ({
  targetId,
  title: opts.title ?? targetId,
  url: opts.url ?? `https://${targetId}.example/`,
  fresh: opts.fresh ?? false,
  ...(opts.openerId ? { openerId: opts.openerId } : {}),
  ...(opts.pendingClaim ? { pendingClaim: true } : {}),
});
const browser = (
  id: string,
  pages: BrowserState['pages'],
  extra: Partial<BrowserState> = {},
): BrowserState => ({
  id,
  browserCdpUrl: CDP,
  startedAt: 1,
  targetsLoaded: true,
  pages,
  ...extra,
});
const owner = (id: string, browsers: BrowserState[], browsersLoaded = true): OwnerState => ({
  ownerTabId: id,
  browsersLoaded,
  browsers,
});
const run = (over: Partial<ReconcileInput>) =>
  reconcileBrowserTabs({
    owners: [],
    tabs: [],
    activeTabId: null,
    activePath: '/ws',
    assignments: new Map(),
    announced: new Set(),
    suppressed: new Set(),
    ...over,
  });

describe('browser tab id scheme', () => {
  it('round-trips, including ids with the separator in them', () => {
    const ref = { ownerTabId: 'repo:wt-term-1', browserId: '12', targetId: 'AB:CD/ef' };
    const id = browserTabId(ref);
    assert.ok(id.startsWith('browser:'));
    assert.equal(id.split(':').length, 4);
    assert.deepEqual(parseBrowserTabId(id), ref);
  });

  it('rejects non-browser ids and malformed ones', () => {
    assert.equal(parseBrowserTabId('wt-term-1'), null);
    assert.equal(parseBrowserTabId('browser:a:b'), null);
    assert.equal(parseBrowserTabId('browser:a::c'), null);
    assert.equal(parseBrowserTabId('browser:%E0%A4%A:1:t'), null);
  });
});

describe('isUserPage', () => {
  it('keeps ordinary pages, blank and new-tab pages', () => {
    assert.ok(isUserPage({ type: 'page', url: 'https://x.dev/' }));
    assert.ok(isUserPage({ type: 'page', url: 'about:blank' }));
    assert.ok(isUserPage({ type: 'page', url: 'chrome://newtab/' }));
  });
  it('skips non-pages, DevTools and Chrome UI targets, and prerenders', () => {
    assert.ok(!isUserPage({ type: 'service_worker', url: 'https://x.dev/sw.js' }));
    assert.ok(!isUserPage({ type: 'iframe', url: 'https://x.dev/' }));
    assert.ok(!isUserPage({ type: 'page', url: 'devtools://devtools/bundled/inspector.html' }));
    assert.ok(!isUserPage({ type: 'page', url: 'chrome://tab-search.top-chrome/' }));
    assert.ok(!isUserPage({ type: 'page', url: 'chrome://omnibox-popup.top-chrome/' }));
    assert.ok(!isUserPage({ type: 'page', url: 'chrome-untrusted://compose/' }));
    assert.ok(!isUserPage({ type: 'page', url: 'https://x.dev/', subtype: 'prerender' }));
  });
});

describe('pageTabName', () => {
  it('prefers the title, then the hostname, then "New tab"', () => {
    assert.equal(pageTabName('Docs', 'https://x.dev/a'), 'Docs');
    assert.equal(pageTabName('https://x.dev/a', 'https://x.dev/a'), 'x.dev');
    assert.equal(pageTabName('', 'http://localhost:3000/'), 'localhost');
    assert.equal(pageTabName('about:blank', 'about:blank'), 'New tab');
    assert.equal(pageTabName('', ''), 'New tab');
  });
});

describe('reconcileBrowserTabs', () => {
  it('opens existing pages in the background, with no placement so the saved order applies', () => {
    const r = run({
      owners: [owner('t1', [browser('1', [page('A'), page('B')])])],
      tabs: [term('t1'), term('t2')],
      activeTabId: 't2',
    });
    const opens = r.actions.filter((a) => a.kind === 'open');
    assert.equal(opens.length, 2);
    const idA = browserTabId({ ownerTabId: 't1', browserId: '1', targetId: 'A' });
    const idB = browserTabId({ ownerTabId: 't1', browserId: '1', targetId: 'B' });
    assert.deepEqual(
      opens.map((a) => a.kind === 'open' && [a.tab.id, a.activate, a.after]),
      [
        [idA, false, undefined],
        [idB, false, undefined],
      ],
    );
    const tab = opens[0].kind === 'open' ? opens[0].tab : null;
    assert.deepEqual(tab, {
      type: 'browser',
      id: idA,
      name: 'A',
      title: 'https://A.example/',
      renamable: false,
    });
  });

  it('focuses a fresh page, placed after the newest tab of the same owner', () => {
    const idA = browserTabId({ ownerTabId: 't1', browserId: '1', targetId: 'A' });
    const r = run({
      owners: [owner('t1', [browser('1', [page('A'), page('N', { fresh: true })])])],
      tabs: [term('t1'), { type: 'browser', id: idA, name: 'A', title: 'https://A.example/' }, term('t2')],
      activeTabId: 't1',
    });
    assert.equal(r.actions.length, 1);
    const a = r.actions[0];
    assert.equal(a.kind, 'open');
    if (a.kind === 'open') {
      assert.equal(a.activate, true);
      assert.equal(a.after, idA);
    }
  });

  // Regression: the strip `Term, New tab, New tab, Tab, .bashrc` came back as
  // `Term, New tab, Tab, New tab, .bashrc` after a reload. The host restores a
  // known id to its saved slot only when no `after` is passed, and reconcile
  // was passing one for every page, including the ones that already existed.
  it('re-adds hydrated pages without `after` (reload keeps the saved order)', () => {
    const owners = [owner('t1', [browser('1', [page('A'), page('B'), page('C')])])];
    const r = run({ owners, tabs: [term('t1'), { type: 'file', id: 'f', name: '.bashrc' }] });
    const opens = r.actions.filter((a) => a.kind === 'open');
    assert.equal(opens.length, 3);
    for (const a of opens) {
      assert.ok(a.kind === 'open' && !('after' in a), 'no explicit placement');
      assert.equal(a.kind === 'open' && a.activate, false);
    }
    // A fresh page that was already announced (re-add after a warm switch) is
    // not live placement either.
    const id = browserTabId({ ownerTabId: 't1', browserId: '1', targetId: 'N' });
    const again = run({
      owners: [owner('t1', [browser('1', [page('N', { fresh: true })])])],
      tabs: [term('t1'), term('t2')],
      announced: new Set([id]),
    });
    assert.ok(again.actions[0].kind === 'open' && again.actions[0].after === undefined);
  });

  it('never re-activates an announced page and skips suppressed ones', () => {
    const id = browserTabId({ ownerTabId: 't1', browserId: '1', targetId: 'N' });
    const owners = [owner('t1', [browser('1', [page('N', { fresh: true })])])];
    const again = run({ owners, tabs: [term('t1')], announced: new Set([id]) });
    assert.equal(again.actions[0].kind === 'open' && again.actions[0].activate, false);
    const closing = run({ owners, tabs: [term('t1')], suppressed: new Set([id]) });
    assert.deepEqual(closing.actions, []);
  });

  it('is idempotent once the host has the tabs', () => {
    const first = run({ owners: [owner('t1', [browser('1', [page('A')])])], tabs: [term('t1')] });
    const tabs = [term('t1'), ...first.actions.flatMap((a) => (a.kind === 'open' ? [a.tab] : []))];
    const second = run({
      owners: [owner('t1', [browser('1', [page('A')])])],
      tabs,
      assignments: first.assignments,
    });
    assert.deepEqual(second.actions, []);
  });

  it('updates name/title when the page changes', () => {
    const id = browserTabId({ ownerTabId: 't1', browserId: '1', targetId: 'A' });
    const r = run({
      owners: [owner('t1', [browser('1', [page('A', { title: 'New', url: 'https://n.dev/' })])])],
      tabs: [term('t1'), { type: 'browser', id, name: 'Old', title: 'https://o.dev/' }],
    });
    assert.deepEqual(r.actions, [
      { kind: 'update', id, patch: { name: 'New', title: 'https://n.dev/' } },
    ]);
  });

  it('removes tabs only on authoritative data', () => {
    const id = (o: string, b: string, t: string) =>
      browserTabId({ ownerTabId: o, browserId: b, targetId: t });
    const tabs: Tab[] = [
      term('t1'),
      term('t2'),
      term('t3'),
      { type: 'browser', id: id('t1', '1', 'gone'), name: 'x' },
      { type: 'browser', id: id('t2', '9', 'x'), name: 'x' },
      { type: 'browser', id: id('t3', '1', 'x'), name: 'x' },
      { type: 'browser', id: id('dead', '1', 'x'), name: 'x' },
      { type: 'browser', id: id('t1', '2', 'loading'), name: 'x' },
    ];
    const r = run({
      owners: [
        owner('t1', [browser('1', []), browser('2', [], { targetsLoaded: false, browserCdpUrl: 'ws://other' })]),
        owner('t2', []), // loaded, browser 9 not registered
        owner('t3', [], false), // still loading
      ],
      tabs,
    });
    const removed = r.actions.filter((a) => a.kind === 'remove').map((a) => a.kind === 'remove' && a.id);
    assert.deepEqual(removed.sort(), [id('t1', '1', 'gone'), id('t2', '9', 'x'), id('dead', '1', 'x')].sort());
  });

  it('gives a page shared by several owners to exactly one, preferring the active terminal', () => {
    const shared = [page('A')];
    const owners = [owner('t1', [browser('1', shared)]), owner('t2', [browser('4', shared)])];
    const r = run({ owners, tabs: [term('t1'), term('t2')], activeTabId: 't2' });
    const opens = r.actions.filter((a) => a.kind === 'open');
    assert.equal(opens.length, 1);
    assert.equal(
      opens[0].kind === 'open' && opens[0].tab.id,
      browserTabId({ ownerTabId: 't2', browserId: '4', targetId: 'A' }),
    );
  });

  it('keeps a shared page with the owner whose tab already shows it', () => {
    const shared = [page('A')];
    const owners = [owner('t1', [browser('1', shared)]), owner('t2', [browser('4', shared)])];
    const id1 = browserTabId({ ownerTabId: 't1', browserId: '1', targetId: 'A' });
    const r = run({
      owners,
      tabs: [term('t1'), term('t2'), { type: 'browser', id: id1, name: 'A', title: 'https://A.example/' }],
      activeTabId: 't2',
    });
    assert.deepEqual(r.actions, []);
  });

  it("skips pages assigned to another workspace's terminal", () => {
    const key = pageKey(CDP, 'A');
    const assignments = new Map<string, PageAssignment>([
      [key, { ownerTabId: 'elsewhere', workspacePath: '/other' }],
    ]);
    const r = run({
      owners: [owner('t1', [browser('1', [page('A'), page('B')])])],
      tabs: [term('t1')],
      assignments,
    });
    const opened = r.actions.map((a) => a.kind === 'open' && parseBrowserTabId(a.tab.id)?.targetId);
    assert.deepEqual(opened, ['B']);
    // Same workspace, owner gone → reassigned instead.
    const r2 = run({
      owners: [owner('t1', [browser('1', [page('A')])])],
      tabs: [term('t1')],
      assignments: new Map([[key, { ownerTabId: 'closed', workspacePath: '/ws' }]]),
    });
    assert.equal(r2.actions.length, 1);
    assert.equal(r2.assignments.get(key)?.ownerTabId, 't1');
  });
});

describe('pickOwnerForNewPage', () => {
  const pageTab: Tab = {
    type: 'browser',
    id: browserTabId({ ownerTabId: 't2', browserId: '1', targetId: 'A' }),
    name: 'A',
  };
  const tabs = [term('t1'), term('t2'), pageTab, { type: 'file', id: 'f', name: 'f' }];
  it('uses the active terminal, else the active page owner, else the first terminal', () => {
    assert.equal(pickOwnerForNewPage(tabs, 't2'), 't2');
    assert.equal(pickOwnerForNewPage(tabs, pageTab.id), 't2');
    assert.equal(pickOwnerForNewPage(tabs, 'f'), 't1');
    assert.equal(pickOwnerForNewPage([{ type: 'file', id: 'f', name: 'f' }], 'f'), null);
  });
});

describe('reconcileBrowserTabs ownership claims', () => {
  const id = (o: string, t: string, b = '1') => browserTabId({ ownerTabId: o, browserId: b, targetId: t });
  const opened = (r: ReturnType<typeof run>) =>
    r.actions.flatMap((a) => (a.kind === 'open' ? [a.tab.id] : []));

  it('a claimed page goes to its claimant, not the active terminal', () => {
    const claims = { A: 't1' };
    const owners = [
      owner('t1', [browser('1', [page('A')], { pageOwners: claims })]),
      owner('t2', [browser('4', [page('A')], { pageOwners: claims })]),
    ];
    const r = run({ owners, tabs: [term('t1'), term('t2')], activeTabId: 't2' });
    assert.deepEqual(opened(r), [id('t1', 'A')]);
  });

  // The bug: on a fresh load the first workspace viewed claimed every page of
  // the shared Chrome, including ones opened from other workspaces' terminals.
  it("never shows a page claimed by another workspace's terminal", () => {
    const claims = { A: 'other-ws-term', B: 't1' };
    const r = run({
      owners: [owner('t1', [browser('1', [page('A'), page('B')], { pageOwners: claims })])],
      tabs: [term('t1')],
    });
    assert.deepEqual(opened(r), [id('t1', 'B')]);
  });

  it('a claim beats an existing tab and a sticky assignment', () => {
    const claims = { A: 'other-ws-term' };
    const r = run({
      owners: [owner('t1', [browser('1', [page('A')], { pageOwners: claims })])],
      tabs: [term('t1'), { type: 'browser', id: id('t1', 'A'), name: 'A', title: 'https://A.example/' }],
      assignments: new Map([[pageKey(CDP, 'A'), { ownerTabId: 't1', workspacePath: '/ws' }]]),
    });
    assert.deepEqual(r.actions, [{ kind: 'remove', id: id('t1', 'A') }]);
    // Same workspace, other terminal: moves to the claimant.
    const moved = run({
      owners: [
        owner('t1', [browser('1', [page('A')], { pageOwners: { A: 't2' } })]),
        owner('t2', [browser('4', [page('A')], { pageOwners: { A: 't2' } })]),
      ],
      tabs: [term('t1'), term('t2'), { type: 'browser', id: id('t1', 'A'), name: 'A', title: 'https://A.example/' }],
    });
    assert.deepEqual(
      moved.actions.map((a) => a.kind),
      ['remove', 'open'],
    );
    assert.deepEqual(opened(moved), [id('t2', 'A', '4')]);
  });

  it('a popup inherits its opener chain claim, even after the opener is gone', () => {
    const claims = { root: 'other-ws-term', mine: 't1' };
    const pages = [
      page('mid', { openerId: 'root' }), // root itself already closed
      page('leaf', { openerId: 'mid', fresh: true }),
      page('child', { openerId: 'mine', fresh: true }),
    ];
    const r = run({
      owners: [owner('t1', [browser('1', pages, { pageOwners: claims })])],
      tabs: [term('t1')],
    });
    assert.deepEqual(opened(r), [id('t1', 'child')]);
  });

  it('holds back an unclaimed page while its claim may be in flight', () => {
    const owners = (pendingClaim: boolean, pageOwners = {}) => [
      owner('t1', [browser('1', [page('N', { fresh: true, pendingClaim })], { pageOwners })]),
    ];
    assert.deepEqual(run({ owners: owners(true), tabs: [term('t1')] }).actions, []);
    // Claimed elsewhere while pending: still hidden; claimed here: shown.
    assert.deepEqual(run({ owners: owners(true, { N: 'x' }), tabs: [term('t1')] }).actions, []);
    assert.deepEqual(opened(run({ owners: owners(true, { N: 't1' }), tabs: [term('t1')] })), [id('t1', 'N')]);
    // Grace over and still unclaimed: the heuristic places it.
    assert.deepEqual(opened(run({ owners: owners(false), tabs: [term('t1')] })), [id('t1', 'N')]);
  });

  it('cycles in opener ids terminate', () => {
    const pages = new Map([
      ['a', { openerId: 'b' }],
      ['b', { openerId: 'a' }],
    ]);
    assert.equal(resolvePageOwner('a', {}, pages), undefined);
    assert.equal(resolvePageOwner('a', { b: 't9' }, pages), 't9');
  });
});
