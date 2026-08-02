/**
 * Regression tests for `findOmnitermPackageRoot`.
 *
 * Original bug: the function threw at module load when no package.json
 * was found between the caller's location and the filesystem root —
 * which crashed every consumer (apps/testbox, etc.) when run from a
 * deployment layout without surrounding package.jsons. Plus the original
 * "first package.json wins" behavior returned the wrong directory after
 * the rename `omniterm` → `@omniterm/core` because consumers' own
 * package.json sat between the bundled file and any actual @omniterm/core
 * package.json.
 *
 * After the fix:
 *   - Returns null instead of throwing.
 *   - Prefers a package.json named "@omniterm/core" (dev / unbundled).
 *   - Falls back to the first package.json (bundled consumer).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findOmnitermPackageRoot } from './paths.js';

function withTmpdir<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), 'omniterm-paths-test-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data));
}

test('returns null when no package.json upward (deployment with shallow fs)', () => {
  withTmpdir((root) => {
    // No package.json anywhere in the temp tree; simulates a Docker layout
    // where dist/server.js is copied to /opt/app with nothing around it.
    const startDir = path.join(root, 'deep', 'nest', 'no-pkgjson');
    mkdirSync(startDir, { recursive: true });
    assert.equal(findOmnitermPackageRoot(startDir), null);
  });
});

test('returns the @omniterm/core package dir when found upward (dev / unbundled)', () => {
  withTmpdir((root) => {
    // Mimics packages/omniterm/lib/paths.ts walking up to packages/omniterm/.
    const corePkg = path.join(root, 'packages', 'omniterm');
    const startDir = path.join(corePkg, 'lib');
    writeJson(path.join(corePkg, 'package.json'), { name: '@omniterm/core' });
    mkdirSync(startDir, { recursive: true });
    assert.equal(findOmnitermPackageRoot(startDir), corePkg);
  });
});

test('prefers @omniterm/core over a closer non-matching package.json (the post-rename trap)', () => {
  withTmpdir((root) => {
    // Mimics: @omniterm/core sits ABOVE a workspace member whose package
    // happens to walk-up first. First-pass should skip the closer one
    // because its `name` isn't "@omniterm/core" and keep climbing.
    const corePkg = path.join(root, 'monorepo', 'packages', 'omniterm');
    const consumerPkg = path.join(corePkg, 'consumer');
    const startDir = path.join(consumerPkg, 'src');
    writeJson(path.join(corePkg, 'package.json'), { name: '@omniterm/core' });
    writeJson(path.join(consumerPkg, 'package.json'), { name: 'example-host-app' });
    mkdirSync(startDir, { recursive: true });
    assert.equal(findOmnitermPackageRoot(startDir), corePkg);
  });
});

test('falls back to nearest package.json when no @omniterm/core upward (bundled context)', () => {
  withTmpdir((root) => {
    // Mimics testbox's bundled output: dist/server.js inside apps/testbox
    // with no @omniterm/core/ surviving on disk. The walk-up's second pass
    // should accept the consumer's package.json so OMNITERM_BIN_DIR points
    // somewhere sensible (consumer's own bin/, which the consumer stages).
    const consumerPkg = path.join(root, 'apps', 'testbox');
    const startDir = path.join(consumerPkg, 'dist');
    writeJson(path.join(consumerPkg, 'package.json'), { name: 'example-host-app' });
    mkdirSync(startDir, { recursive: true });
    assert.equal(findOmnitermPackageRoot(startDir), consumerPkg);
  });
});

test('ignores unreadable / malformed package.json instead of throwing', () => {
  withTmpdir((root) => {
    // A garbage package.json in the walk path shouldn't crash the resolver.
    // First pass should skip it (no "@omniterm/core" name), second pass
    // accepts it since it does exist.
    const consumerPkg = path.join(root, 'apps', 'testbox');
    const startDir = path.join(consumerPkg, 'dist');
    mkdirSync(startDir, { recursive: true });
    writeFileSync(path.join(consumerPkg, 'package.json'), 'this is not json {');
    assert.equal(findOmnitermPackageRoot(startDir), consumerPkg);
  });
});

test('first-pass picks @omniterm/core even if a malformed package.json sits between', () => {
  withTmpdir((root) => {
    // Walk: startDir → broken/ (malformed pkg, skip in first pass) →
    // outer/ (@omniterm/core, RETURN).
    const corePkg = path.join(root, 'outer');
    const brokenPkg = path.join(corePkg, 'broken');
    const startDir = path.join(brokenPkg, 'deep');
    mkdirSync(startDir, { recursive: true });
    writeJson(path.join(corePkg, 'package.json'), { name: '@omniterm/core' });
    writeFileSync(path.join(brokenPkg, 'package.json'), '{not json');
    assert.equal(findOmnitermPackageRoot(startDir), corePkg);
  });
});

test('falls back to nearest package.json when name field is absent', () => {
  withTmpdir((root) => {
    // Edge case: package.jsons without a `name` field. First pass walks
    // past them all (no name match). Second pass should still find one
    // — it accepts ANY package.json regardless of name.
    const dir = path.join(root, 'consumer');
    const startDir = path.join(dir, 'src');
    mkdirSync(startDir, { recursive: true });
    writeJson(path.join(dir, 'package.json'), { version: '1.0.0' }); // no name
    assert.equal(findOmnitermPackageRoot(startDir), dir);
  });
});
