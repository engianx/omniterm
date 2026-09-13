import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const executablePath = process.env.OMNITERM_CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
const source = readFileSync(new URL('../public/devtools-screencast-shim.js', import.meta.url), 'utf8');

test('compact geometry survives Chrome 153 styleMap renders and reverts to stock', {
  skip: executablePath ? false : 'no Chrome/Chromium installed',
}, async () => {
  // Playwright owns a fresh temporary profile and closes its browser in finally.
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    // tsx preserves function names with this helper inside serialized callbacks.
    await page.addInitScript('globalThis.__name = (value) => value;');
    await page.route('http://shim.test/**', route => route.fulfill({
      contentType: route.request().url().endsWith('/shim.js') ? 'text/javascript' : 'text/html',
      body: route.request().url().endsWith('/shim.js') ? source : '<!doctype html><html><head></head><body></body></html>',
    }));
    await page.goto('http://shim.test/');
    const results = await page.evaluate(async () => {
      const shimUrl = '/shim.js';
      const { installCompactScreencastFrame } = await import(shimUrl);
      const element = document.createElement('div');
      element.style.cssText = 'width:900px;height:600px';
      document.body.append(element);
      const viewport = document.createElement('div');
      viewport.className = 'screencast-viewport';
      viewport.style.boxSizing = 'border-box';
      const canvas = document.createElement('canvas');
      viewport.append(canvas);
      const paints: number[][] = [];
      let stockWidth = '', stockHeight = '';
      const view = {
        element,
        imageElement: new Image(),
        screenZoom: 0.5,
        viewportDimensions: () => ({ width: 826, height: 526 }),
        onResize() {},
        // Chrome 153 stores dimensions privately during onload and requests an
        // asynchronous render. Its styleMap assigns them on EVERY render, then
        // the canvas ref measures layout and updates the backing dimensions.
        screencastFrame(_data: string, metadata: { deviceWidth: number; deviceHeight: number }) {
          this.imageElement.onload = () => {
            stockWidth = `${metadata.deviceWidth * this.screenZoom + 44}px`;
            stockHeight = `${metadata.deviceHeight * this.screenZoom + 44}px`;
            queueMicrotask(() => this.performUpdate());
          };
        },
        performUpdate() {
          viewport.style.width = stockWidth;
          viewport.style.height = stockHeight;
          const rect = viewport.getBoundingClientRect();
          canvas.width = rect.width;
          canvas.height = rect.height;
          paints.push([rect.width, rect.height, canvas.width, canvas.height]);
        },
      };
      const handle = installCompactScreencastFrame(view);
      // No viewportElement/repaint properties; DOM arrives after installation.
      element.append(viewport);
      const frames = [];
      for (const [deviceWidth, deviceHeight] of [[800, 500], [800, 500], [600, 400]]) {
        view.screencastFrame('', { deviceWidth, deviceHeight });
        view.imageElement.dispatchEvent(new Event('load'));
        await Promise.resolve();
        frames.push(paints.at(-1));
      }
      view.performUpdate(); // An unrelated stock update, with no new frame.
      const extraRender = paints.at(-1);
      handle.revert();
      // An onload wrapper can outlive revert until stock replaces it.
      view.imageElement.dispatchEvent(new Event('load'));
      await Promise.resolve();
      view.performUpdate();
      return {
        state: handle.state, frames, extraRender, reverted: paints.at(-1),
        remainingProperties: Array.from(element.style).filter(name => name.startsWith('--omniterm-')),
      };
    });
    assert.equal(results.state, 'frame=compact');
    assert.deepEqual(results.frames, [
      [400, 250, 400, 250], [400, 250, 400, 250], [300, 200, 300, 200],
    ]);
    assert.deepEqual(results.extraRender, [300, 200, 300, 200]);
    assert.deepEqual(results.reverted, [344, 244, 344, 244]);
    assert.deepEqual(results.remainingProperties, []);
  } finally {
    await browser.close();
  }
});
