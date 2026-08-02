import { watch, FSWatcher, readFileSync } from 'fs';
import path from 'path';
import ignore, { Ignore } from 'ignore';
import { broadcast } from './events.js';

let currentWatcher: FSWatcher | null = null;
let currentPath: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let ig: Ignore | null = null;
let watchEventLogLimiter = createWatchEventLogLimiter(5000);

const DEBOUNCE_MS = 500;

function normalizeWatchPath(filename: string): string {
  return filename.replace(/\\/g, '/');
}

function isGitInternalPath(filename: string): boolean {
  return filename === '.git' || filename.startsWith('.git/');
}

export function createWatchEventLogLimiter(minIntervalMs: number): {
  shouldLog: (now?: number) => boolean;
} {
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  return {
    shouldLog(now = Date.now()): boolean {
      if (now - lastLoggedAt < minIntervalMs) return false;
      lastLoggedAt = now;
      return true;
    },
  };
}

export function buildWatchIgnoreMatcher(dirPath: string): Ignore {
  const matcher = ignore();
  try {
    const content = readFileSync(path.join(dirPath, '.gitignore'), 'utf-8');
    matcher.add(content);
  } catch {
    // No .gitignore or unreadable — nothing to ignore
  }
  // Always ignore node_modules and common build output
  matcher.add([
    'node_modules',
    '.next',
    'dist',
    'standalone',
    'test-results/',
    'e2e/test-results/',
    'playwright-report/',
    'e2e/playwright-report/',
    '**/.playwright-artifacts-*',
  ]);
  return matcher;
}

export function shouldIgnoreWatchPath(
  dirPath: string,
  filename: string,
  matcher: Ignore | null,
): boolean {
  const normalized = normalizeWatchPath(filename);
  if (normalized === '<unknown>') return false;
  if (normalized === '.gitignore' || normalized.endsWith('/.gitignore')) {
    ig = buildWatchIgnoreMatcher(dirPath);
    return false;
  }
  if (isGitInternalPath(normalized)) return true;

  return matcher ? matcher.ignores(normalized) : false;
}

export function watchWorkspace(dirPath: string): void {
  // Skip if already watching this path
  if (currentPath === dirPath) return;
  stopWatching();

  currentPath = dirPath;
  ig = buildWatchIgnoreMatcher(dirPath);
  try {
    console.log(`[watcher] start watching path=${dirPath}`);
    currentWatcher = watch(dirPath, { recursive: true }, (eventType, filename) => {
      const name = typeof filename === 'string' && filename.length > 0 ? filename : '<unknown>';
      if (shouldIgnoreWatchPath(dirPath, name, ig)) {
        return;
      }
      if (watchEventLogLimiter.shouldLog()) {
        console.log(`[watcher] fs event path=${dirPath} event=${eventType} file=${name}`);
      }
      // Debounce — builds and git operations trigger many events
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[watcher] broadcast files-changed path=${dirPath}`);
        broadcast('files-changed');
      }, DEBOUNCE_MS);
    });
    currentWatcher.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[watcher] error path=${dirPath} message=${message}`);
      // Directory removed or inaccessible — stop watching
      stopWatching();
    });
  } catch {
    // fs.watch not supported or path doesn't exist
    console.error(`[watcher] failed to watch path=${dirPath}`);
    currentPath = null;
  }
}

export function stopWatching(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (currentWatcher) {
    if (currentPath) {
      console.log(`[watcher] stop watching path=${currentPath}`);
    }
    currentWatcher.close();
    currentWatcher = null;
  }
  watchEventLogLimiter = createWatchEventLogLimiter(5000);
  ig = null;
  currentPath = null;
}
