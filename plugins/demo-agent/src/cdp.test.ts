import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCdpUpgradeUrl } from './cdp.js';

test('parseCdpUpgradeUrl matches the agent CDP-proxy shape', () => {
  assert.deepEqual(parseCdpUpgradeUrl('/agent/a-123/ws/cdp/9222'), {
    port: 9222,
    cdpPath: '/',
  });
  assert.deepEqual(parseCdpUpgradeUrl('/agent/a-123/ws/cdp/9222/devtools/page/ABC'), {
    port: 9222,
    cdpPath: '/devtools/page/ABC',
  });
});

test('parseCdpUpgradeUrl rejects non-CDP and out-of-range ports', () => {
  assert.equal(parseCdpUpgradeUrl('/agent/a-123/api/record'), null);
  assert.equal(parseCdpUpgradeUrl('/ws/cdp/9222'), null); // missing /agent/:id prefix
  assert.equal(parseCdpUpgradeUrl('/agent/a-123/ws/cdp/0'), null);
  assert.equal(parseCdpUpgradeUrl('/agent/a-123/ws/cdp/70000'), null);
  assert.equal(parseCdpUpgradeUrl('/agent/a-123/ws/cdp/abc'), null);
});
