import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, validatePluginManifests } from './manifest.js';
import type { TabTypePlugin, PluginManifestEntry } from '../../plugins/types.js';

function manifestOf(type: string): PluginManifestEntry {
  return {
    type,
    label: type,
    endpoints: { create: `/api/${type}/instances` },
    iframe: { urlTemplate: `/${type}/{id}` },
  };
}

function plugin(over: Partial<TabTypePlugin>): TabTypePlugin {
  return {
    type: 'x',
    label: 'X',
    proxyPrefix: '',
    createRouter: (() => undefined) as unknown as TabTypePlugin['createRouter'],
    ...over,
  } as TabTypePlugin;
}

// ---- buildManifest ----

test('buildManifest returns only plugins that declare a manifest', () => {
  const withManifest = plugin({ type: 'fixture', manifest: manifestOf('fixture') });
  const componentOnly = plugin({ type: 'terminal', render: { type: 'component', componentPath: './T' } });
  const out = buildManifest([componentOnly, withManifest]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, 'fixture');
});

// ---- validatePluginManifests ----

test('a component-render plugin without a manifest is valid (built-in)', () => {
  const terminal = plugin({
    type: 'terminal',
    proxyPrefix: '/t/:tabId',
    render: { type: 'component', componentPath: './T' },
  });
  assert.doesNotThrow(() => validatePluginManifests([terminal]));
});

test('an iframe plugin with a manifest is valid', () => {
  const fixture = plugin({ type: 'fixture', manifest: manifestOf('fixture') });
  assert.doesNotThrow(() => validatePluginManifests([fixture]));
});

test('a plugin with neither a manifest nor a component render is rejected', () => {
  const bad = plugin({ type: 'bad' }); // render now optional; no manifest
  assert.throws(() => validatePluginManifests([bad]), /neither a `manifest`.*nor a/s);
});

test('duplicate non-empty proxyPrefix is rejected (silent route shadowing)', () => {
  const a = plugin({ type: 'a', proxyPrefix: '/api/foo', manifest: manifestOf('a') });
  const b = plugin({ type: 'b', proxyPrefix: '/api/foo', manifest: manifestOf('b') });
  assert.throws(() => validatePluginManifests([a, b]), /shares proxyPrefix/);
});

test('multiple empty-prefix plugins are allowed (they self-namespace)', () => {
  const a = plugin({ type: 'a', proxyPrefix: '', manifest: manifestOf('a') });
  const b = plugin({ type: 'b', proxyPrefix: '', manifest: manifestOf('b') });
  assert.doesNotThrow(() => validatePluginManifests([a, b]));
});
