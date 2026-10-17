import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createShimLauncher } from './browserLaunch.js';

/** A stand-in child: never a real process, so no Chrome is ever started. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    unref: () => void;
    unrefCalled: boolean;
  };
  child.stderr = new EventEmitter();
  child.unrefCalled = false;
  child.unref = () => {
    child.unrefCalled = true;
  };
  return child;
}

describe('createShimLauncher', () => {
  it('runs the shim with node, the url, and the tab registry URL in env', async () => {
    const child = fakeChild();
    let seen: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
    const launch = createShimLauncher({
      shimPath: '/opt/omniterm/bin/omniterm-browser.js',
      env: { PATH: '/usr/bin', OMNITERM_BROWSER_REGISTRY_URL: 'stale' },
      spawnFn: (command, args, options) => {
        seen = { command, args, options };
        setImmediate(() => child.emit('exit', 0, null));
        return child as unknown as ChildProcess;
      },
    });
    await launch({ registryUrl: 'http://127.0.0.1:1/t/x/registry', url: 'about:blank' });
    assert.ok(seen);
    const s = seen as unknown as { command: string; args: string[]; options: Record<string, unknown> };
    assert.equal(s.command, process.execPath);
    assert.deepEqual(s.args, ['/opt/omniterm/bin/omniterm-browser.js', 'about:blank']);
    assert.equal(s.options.detached, true);
    assert.deepEqual(s.options.env, {
      PATH: '/usr/bin',
      OMNITERM_BROWSER_REGISTRY_URL: 'http://127.0.0.1:1/t/x/registry',
    });
  });

  it("rejects with the shim's fatal line when it fails", async () => {
    const child = fakeChild();
    const launch = createShimLauncher({
      shimPath: '/x/omniterm-browser.js',
      spawnFn: () => {
        setImmediate(() => {
          child.stderr.emit('data', '[omniterm-browser] fatal: Error: No Chrome/Chromium binary found.\n');
          child.emit('exit', 1, null);
        });
        return child as unknown as ChildProcess;
      },
    });
    await assert.rejects(
      launch({ registryUrl: 'r', url: 'about:blank' }),
      /^Error: Error: No Chrome\/Chromium binary found\.$/,
    );
  });

  it('resolves (leaving the shim running) when it outlasts the timeout', async () => {
    const child = fakeChild();
    const launch = createShimLauncher({
      shimPath: '/x/omniterm-browser.js',
      timeoutMs: 10,
      spawnFn: () => child as unknown as ChildProcess,
    });
    await launch({ registryUrl: 'r', url: 'about:blank' });
    assert.equal(child.unrefCalled, true);
  });

  it('refuses when the shim is not staged', async () => {
    const launch = createShimLauncher({ shimPath: null, spawnFn: () => assert.fail('spawned') });
    await assert.rejects(launch({ registryUrl: 'r', url: 'about:blank' }), /not available/);
  });
});
