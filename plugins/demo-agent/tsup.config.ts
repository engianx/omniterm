import { defineConfig } from 'tsup';

// Bundle the plugin server entry (src/index.ts → adapter/session/store/cdp) into
// a single minified, source-map-free dist/index.js.
//   - express is a runtime `dependency` (npm installs it) — keep external.
//   - @anthropic-ai/claude-agent-sdk is a runtime dependency that dynamically
//     loads platform-specific binaries via require() — keep external.
//   - @omniterm/plugin-types is imported as types only (erased) AND is a
//     devDependency absent from a consumer install — external it so any
//     accidental value import fails loudly at build instead of shipping an
//     unresolvable ref.
// `clean: false` because the client bundle (dist/client, owned by vite) is built
// first by `build:client` and must survive the server build.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  dts: false,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  minify: true,
  clean: false,
  shims: true,
  keepNames: true,
  external: ['express', '@anthropic-ai/claude-agent-sdk', '@omniterm/plugin-types'],
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});
