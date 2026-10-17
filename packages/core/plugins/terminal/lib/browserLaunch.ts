/**
 * Start the omniterm-browser shim on behalf of a terminal tab.
 *
 * Backs `POST /t/:tabId/browsers/launch` (the UI's "new browser tab" when the
 * terminal has no live browser). It runs the very shim `$BROWSER`/xdg-open
 * run inside the tab, with the server's env plus the tab's
 * `OMNITERM_BROWSER_REGISTRY_URL`, so Chrome registers under that terminal
 * exactly as if the user had typed `xdg-open about:blank` in it: cold-starting
 * the shared Chrome when none is running, or opening a page in the running one
 * (and registering it here) when one is.
 *
 * The shim exits once it has registered — Chrome itself is spawned detached by
 * the shim and outlives it — so we wait for that exit to report the shim's own
 * error (no Chrome binary, Chrome died at start-up) instead of failing silently.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'child_process';

export interface ShimLauncherOptions {
  /** Absolute path to bin/omniterm-browser.js; null when not staged. */
  shimPath: string | null;
  spawnFn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  env?: NodeJS.ProcessEnv;
  /** Give up waiting (but leave the shim running) after this long. */
  timeoutMs?: number;
}

export function createShimLauncher(opts: ShimLauncherOptions) {
  const spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as NonNullable<ShimLauncherOptions['spawnFn']>);
  const timeoutMs = opts.timeoutMs ?? 45_000;

  return function launch(args: { registryUrl: string; url: string }): Promise<void> {
    const shimPath = opts.shimPath;
    if (!shimPath) {
      return Promise.reject(new Error('omniterm-browser is not available in this installation'));
    }
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnFn(process.execPath, [shimPath, args.url], {
          env: { ...(opts.env ?? process.env), OMNITERM_BROWSER_REGISTRY_URL: args.registryUrl },
          // Own process group, so a server restart does not take the shim (and
          // the Chrome it is starting) down mid-launch.
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let stderr = '';
      child.stderr?.on('data', (chunk: unknown) => {
        if (stderr.length < 8192) stderr += String(chunk);
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve();
      }, timeoutMs);
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        // The shim prefixes its messages; the fatal line is the useful one.
        const lines = stderr.trim().split('\n').filter(Boolean);
        const fatal = lines.reverse().find((l) => l.includes('fatal')) ?? lines[0];
        reject(
          new Error(
            fatal
              ? fatal.replace(/^\[omniterm-browser\]\s*(fatal:\s*)?/, '')
              : `omniterm-browser exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          ),
        );
      });
    });
  };
}
