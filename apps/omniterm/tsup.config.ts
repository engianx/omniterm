import { defineConfig } from 'tsup';

// Bundle src/server.ts into a single self-contained dist/server.js.
// Inline the workspace `@omniterm/core` library (it's not published — its
// compiled code lives only inside this tarball). Keep external all the
// runtime npm deps (express, http-proxy, etc.) — npm installs them via
// our `dependencies` at install time, no need to inline.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  dts: false,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  // Ship a minified, source-map-free server bundle.
  minify: true,
  // dist/ is fully owned by tsup here (unlike testbox/local-agent where vite
  // emits dist/client/ alongside). Safe to set true; left false to match the
  // pattern in those configs and let scripts/package.sh be the canonical clean.
  clean: false,
  shims: true,
  keepNames: true,
  noExternal: ['@omniterm/core'],
  // posthog-node is a @omniterm/core dependency that must stay EXTERNAL (it's a
  // host runtime dep, installed by npm — not inlined into the bundle). It would
  // already be external via apps/omniterm's package.json deps, but list it
  // explicitly so a future deps change can't accidentally bundle it (+6.9%).
  external: ['posthog-node'],
  // Bake the PostHog project key into the published bundle. The key is never in
  // source — packages/core/lib/telemetryConfig.ts reads the expression defined
  // below, and the release workflow supplies OMNITERM_POSTHOG_KEY from a repo
  // secret. A plain source build injects '' and telemetry is off.
  //
  // OMNITERM_BAKED_POSTHOG_KEY is an internal placeholder, never an env var
  // anyone sets: it appears only in telemetryConfig.ts and in this define. A
  // `define` rewrites its target expression EVERYWHERE it appears in the
  // bundle, so pointing it at the real OMNITERM_POSTHOG_KEY would freeze any
  // future read of that variable to the build-time value — breaking the
  // runtime override in the published bundle only. The placeholder makes that
  // impossible rather than merely unlikely.
  define: {
    'process.env.OMNITERM_BAKED_POSTHOG_KEY': JSON.stringify(
      process.env.OMNITERM_POSTHOG_KEY ?? '',
    ),
  },
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});
