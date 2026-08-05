#!/usr/bin/env bash
# Build and package omniterm for npm publishing.
#
# Steps:
#   1. Build @omniterm/core (vite client + tsc server) so its dist/ is fresh.
#   2. Bundle apps/omniterm's server.ts via tsup (@omniterm/core inlined).
#   3. Assemble standalone/ — the actual artifact that ships:
#        standalone/server/server.js   ← tsup bundle
#        standalone/client/            ← @omniterm/core/dist/client/
#        standalone/public/            ← @omniterm/core/public/
#   4. Copy bin/omniterm-browser.js + bin/xdg-open from @omniterm/core/bin/
#      into apps/omniterm/bin/ so OMNITERM_BIN_DIR's package.json walk-up
#      finds them at runtime.
#
# Runtime npm deps (express, http-proxy, marked, etc.) stay in package.json
# `dependencies` and are installed by npm at install-time — not bundled.
#
# Layout in the published tarball:
#   bin/omniterm.js              launcher
#   bin/omniterm-browser.js     system-browser shim (used by tab tmux env)
#   bin/xdg-open                 xdg-open shim (PATH-injected in tabs)
#   standalone/server/server.js  bundled server entry
#   standalone/client/           vite build output
#   standalone/public/           static manifest etc.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$APP_DIR/../.." && pwd)
# @omniterm/core lives at packages/core.
CORE_DIR="$REPO_ROOT/packages/core"

echo "[omniterm] Syncing the package README..."
node "$SCRIPT_DIR/sync-readme.mjs"

echo "[omniterm] Building @omniterm/core..."
(cd "$CORE_DIR" && pnpm build)

if [ ! -d "$CORE_DIR/dist/client" ] || [ ! -d "$CORE_DIR/dist/server" ]; then
  echo "[omniterm] ERROR: @omniterm/core build did not produce expected dist/ subdirs" >&2
  exit 1
fi

echo "[omniterm] Bundling server.ts via tsup..."
(cd "$APP_DIR" && pnpm exec tsup)

if [ ! -f "$APP_DIR/dist/server.js" ]; then
  echo "[omniterm] ERROR: tsup did not produce dist/server.js" >&2
  exit 1
fi

echo "[omniterm] Assembling standalone/..."
rm -rf "$APP_DIR/standalone"
mkdir -p "$APP_DIR/standalone/server" "$APP_DIR/standalone/client" "$APP_DIR/standalone/public"

cp "$APP_DIR/dist/server.js" "$APP_DIR/standalone/server/server.js"
cp -r "$CORE_DIR/dist/client/." "$APP_DIR/standalone/client/"
cp -r "$CORE_DIR/public/." "$APP_DIR/standalone/public/"

echo "[omniterm] Copying bin shims from @omniterm/core..."
cp "$CORE_DIR/bin/omniterm-browser.js" "$APP_DIR/bin/omniterm-browser.js"
cp "$CORE_DIR/bin/xdg-open" "$APP_DIR/bin/xdg-open"
# Note: this chmod is a no-op under `pnpm pack` (the publish path): pnpm
# normalizes non-bin files to 0644 in the tarball regardless of source mode.
# Only files in package.json `bin` come out 0755. So:
#   - omniterm-browser.js gets +x via the `bin` map.
#   - xdg-open can't go in `bin` (would shadow /usr/bin/xdg-open in PATH);
#     it's fixed up by the package's `postinstall` on the user's machine.
# Left here so the local apps/omniterm/bin/ tree still mirrors install-time
# layout, and so a future switch to `npm pack` (which preserves modes)
# would Just Work.
chmod 755 "$APP_DIR/bin/omniterm-browser.js" "$APP_DIR/bin/xdg-open"

# Guard: the eager client entry chunk must stay small. Editor grammars are
# code-split into on-demand chunks (see packages/core/app/components/
# langExtensions.ts) and fetched only when a file of that type is opened.
# Re-introducing a static `@codemirror/lang-*` import would fold them back
# into this entry chunk — bloating first load WITHOUT growing the total
# tarball (the chunks already ship), so the tarball-size gate can't catch it.
# This guard does. Current size ~636 KB; budget leaves headroom but trips
# well before a full grammar regression (~1190 KB).
MAX_EAGER_BUNDLE_BYTES=$((750 * 1024))
# Anchor on the entry chunk index.html actually loads (its module <script src>),
# not a glob of index-*.js — if Vite ever emits more than one index-*.js, a glob
# could measure the wrong (small) chunk and let a regression through. We require
# EXACTLY one entry <script src>: a multi-chunk entry (e.g. via manualChunks)
# would mean this single-file guard no longer measures the whole eager payload,
# so fail loudly rather than silently under-measure.
INDEX_HTML="$APP_DIR/standalone/client/index.html"
ENTRY_SRCS=$(grep -oE '<script[^>]+src="/assets/[^"]+\.js"' "$INDEX_HTML" | sed -E 's/.*src="([^"]+)".*/\1/')
ENTRY_COUNT=$(printf '%s\n' "$ENTRY_SRCS" | grep -c . || true)
if [ "$ENTRY_COUNT" -ne 1 ]; then
  echo "[omniterm] ERROR: expected exactly one entry <script src> in $INDEX_HTML, found ${ENTRY_COUNT}." >&2
  echo "[omniterm]        The eager-bundle guard assumes a single entry chunk; update it if the build split the entry." >&2
  exit 1
fi
ENTRY_REL="$ENTRY_SRCS"
EAGER_BUNDLE="$APP_DIR/standalone/client${ENTRY_REL}"
if [ ! -f "$EAGER_BUNDLE" ]; then
  echo "[omniterm] ERROR: entry chunk $ENTRY_REL (referenced by index.html) missing at $EAGER_BUNDLE" >&2
  exit 1
fi
EAGER_BUNDLE_BYTES=$(wc -c < "$EAGER_BUNDLE" | tr -d ' ')
if [ "$EAGER_BUNDLE_BYTES" -gt "$MAX_EAGER_BUNDLE_BYTES" ]; then
  echo "[omniterm] ERROR: eager client bundle $(basename "$EAGER_BUNDLE") is ${EAGER_BUNDLE_BYTES} bytes, over the ${MAX_EAGER_BUNDLE_BYTES}-byte budget." >&2
  echo "[omniterm]        A grammar or other heavy module likely leaked into the initial chunk." >&2
  echo "[omniterm]        Keep editor grammars behind dynamic import() in langExtensions.ts." >&2
  exit 1
fi
echo "[omniterm] Eager client bundle: ${EAGER_BUNDLE_BYTES} bytes (budget ${MAX_EAGER_BUNDLE_BYTES})."

echo "[omniterm] Done. Tarball preview:"
du -sh "$APP_DIR/bin" "$APP_DIR/standalone"
