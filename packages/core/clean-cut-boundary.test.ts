import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Proof for 002-plugin-platform / clean-cut-boundary (SC-004, FR-008):
// "Plugins are deletable without breaking the host."
//
// The host (apps/omniterm) and core (packages/core) must never carry a STATIC
// dependency on an external, deletable plugin package. The loader reaches
// plugins only through runtime `import()` of a `--plugin` spec (a runtime
// string, never a source literal), so no external plugin identifier should
// appear in any import/require/dynamic-import specifier in host or core source.
// If this invariant holds, removing a plugin package cannot break host
// compilation or boot.
//
// NOTE: core has its OWN internal `plugins/terminal` (the built-in terminal
// plugin shipped inside core) — that is not an external plugin and must not
// trip this check. The patterns below target only the external plugin packages.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// External, deletable plugin packages and their repo-root paths.
//
// These are deliberately SHAPE-based rather than a list of known plugin names:
// any `@omniterm/*-plugin` package, and anything under a `plugins/` directory
// that is not one of core's OWN modules, is external by construction. A
// name-based list would silently stop covering the next plugin somebody writes
// — including out-of-tree ones this repo has never heard of, which are exactly
// the case the boundary exists to protect.
//
// The inversion matters: CORE_INTERNAL_PLUGIN_DIRS below is an allowlist of our
// own code, which we control and which fails loudly if it grows. The
// alternative — enumerating third-party plugin names — is a list we do not
// control and cannot keep complete.
const CORE_INTERNAL_PLUGIN_DIRS = ['terminal', 'types'];
const EXTERNAL_PLUGIN_PATTERNS: RegExp[] = [
  /@omniterm\/[\w.-]+-plugin\b/,
  new RegExp(`(?:^|[./])plugins/(?!(?:${CORE_INTERNAL_PLUGIN_DIRS.join('|')})\\b)[\\w.-]+`),
  /\b[\w.-]+-plugin\b/,
];

// Specifier in `import … from 'x'`, `export … from 'x'`, `require('x')`,
// `import('x')`, and bare side-effect `import 'x'`.
const SPECIFIER_RE =
  /(?:\bfrom|\brequire\s*\(|\bimport\s*\(|\bimport\b)\s*['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx|js|jsx)$/.test(entry.name)) continue; // tests may reference plugins
    out.push(full);
  }
  return out;
}

// Strip block + line comments so a commented-out plugin import can't trip the
// scan. Line comments keep a leading non-`:` char so `https://` in a string
// specifier is preserved.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function importViolations(roots: string[]): string[] {
  const violations: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      const text = stripComments(readFileSync(file, 'utf-8'));
      for (const m of text.matchAll(SPECIFIER_RE)) {
        const spec = m[1];
        if (EXTERNAL_PLUGIN_PATTERNS.some((p) => p.test(spec))) {
          violations.push(`${path.relative(repoRoot, file)} → "${spec}"`);
        }
      }
    }
  }
  return violations;
}

test('host and core never statically import an external plugin package', () => {
  const violations = importViolations(['apps/omniterm/src', 'packages/core']);
  assert.deepStrictEqual(
    violations,
    [],
    `Clean-cut boundary broken — host/core statically reference a deletable plugin:\n${violations.join('\n')}`,
  );
});

test('the host package declares no dependency on a plugin package', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'apps/omniterm/package.json'), 'utf-8'));
  const deps = Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  });
  const pluginDeps = deps.filter((d) => EXTERNAL_PLUGIN_PATTERNS.some((p) => p.test(d)));
  assert.deepStrictEqual(
    pluginDeps,
    [],
    `@omniterm/host must not depend on a plugin package: ${pluginDeps.join(', ')}`,
  );
});
