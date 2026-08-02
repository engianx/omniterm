import { test } from 'node:test';
import assert from 'node:assert';
import { parsePluginSpecs, validatePluginModule, PluginSpecError } from './pluginLoader.js';

// --- parsePluginSpecs ---

test('parsePluginSpecs collects repeated --plugin values in order', () => {
  assert.deepStrictEqual(
    parsePluginSpecs(['--plugin', './a', '--port', '8080', '--plugin', '@scope/b']),
    ['./a', '@scope/b'],
  );
});

test('parsePluginSpecs returns [] when no --plugin is present', () => {
  assert.deepStrictEqual(parsePluginSpecs(['--port', '8080']), []);
});

test('parsePluginSpecs throws PluginSpecError when --plugin has no value', () => {
  assert.throws(
    () => parsePluginSpecs(['--plugin']),
    (e: unknown) => e instanceof PluginSpecError && e.spec === null,
  );
});

test('parsePluginSpecs throws when --plugin is followed by another flag', () => {
  assert.throws(() => parsePluginSpecs(['--plugin', '--port']), PluginSpecError);
});

// --- validatePluginModule ---

const validPlugin = { type: 'demo', createRouter: () => undefined };

test('validatePluginModule accepts a default-exported plugin object', () => {
  const seen = new Set<string>();
  const p = validatePluginModule('./demo', { default: validPlugin }, seen);
  assert.strictEqual(p.type, 'demo');
  assert.ok(seen.has('demo'));
});

test('validatePluginModule accepts a `plugin` export', () => {
  const p = validatePluginModule('./demo', { plugin: validPlugin }, new Set());
  assert.strictEqual(p.type, 'demo');
});

test('validatePluginModule accepts a no-arg factory returning a plugin', () => {
  const p = validatePluginModule('./demo', { default: () => validPlugin }, new Set());
  assert.strictEqual(p.type, 'demo');
});

test('validatePluginModule rejects a module with no plugin shape', () => {
  assert.throws(
    () => validatePluginModule('./bad', { default: { type: 'x' } }, new Set()),
    (e: unknown) =>
      e instanceof PluginSpecError && /TabTypePlugin/.test(e.message) && e.spec === './bad',
  );
});

test('validatePluginModule rejects when type is missing', () => {
  assert.throws(
    () => validatePluginModule('./bad', { default: { createRouter: () => undefined } }, new Set()),
    PluginSpecError,
  );
});

test('validatePluginModule surfaces a throwing factory', () => {
  assert.throws(
    () =>
      validatePluginModule(
        './bad',
        {
          default: () => {
            throw new Error('boom');
          },
        },
        new Set(),
      ),
    (e: unknown) =>
      e instanceof PluginSpecError && /factory threw/.test(e.message) && /boom/.test(e.message),
  );
});

test('validatePluginModule rejects a duplicate tab type across specs', () => {
  const seen = new Set<string>();
  validatePluginModule('./a', { default: validPlugin }, seen);
  assert.throws(
    () =>
      validatePluginModule(
        './b',
        { default: { type: 'demo', createRouter: () => undefined } },
        seen,
      ),
    (e: unknown) => e instanceof PluginSpecError && /duplicate tab type "demo"/.test(e.message),
  );
});
