import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  fitSize,
  zoomedSize,
} from './image-viewer-zoom.js';

test('clampZoom bounds the range', () => {
  assert.equal(clampZoom(0), MIN_ZOOM);
  assert.equal(clampZoom(1000), MAX_ZOOM);
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(Number.NaN), 1);
});

test('fitSize contains while preserving aspect ratio', () => {
  // 2000x1000 into 1000x1000 surface → scaled to 1000x500
  assert.deepEqual(fitSize({ width: 2000, height: 1000 }, { width: 1000, height: 1000 }), {
    width: 1000,
    height: 500,
  });
});

test('fitSize does not upscale images smaller than the surface', () => {
  assert.deepEqual(fitSize({ width: 100, height: 50 }, { width: 1000, height: 1000 }), {
    width: 100,
    height: 50,
  });
});

test('fitSize is a no-op without measurements', () => {
  assert.deepEqual(fitSize({ width: 0, height: 0 }, { width: 100, height: 100 }), {
    width: 0,
    height: 0,
  });
});

test('zoomedSize multiplies the fit baseline by the clamped zoom', () => {
  const image = { width: 2000, height: 1000 };
  const surface = { width: 1000, height: 1000 };
  // fit = 1000x500, ×2 → 2000x1000
  assert.deepEqual(zoomedSize(image, surface, 2), { width: 2000, height: 1000 });
  // zoom clamped before multiply
  assert.deepEqual(zoomedSize(image, surface, 1000), {
    width: 1000 * MAX_ZOOM,
    height: 500 * MAX_ZOOM,
  });
});
