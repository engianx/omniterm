# Client Bundle Policy

Two build gates enforce this policy, and they will fail your PR if you break it:

- the **entry-chunk budget** in `apps/omniterm/scripts/package.sh`, which caps
  the eager client chunk that `index.html` loads;
- the **tarball-size gate** in `.github/workflows/publish-host.yml`, which fails
  a release whose tarball grew more than a small percentage over the published
  version.

Both assume `standalone/client/` carries first-party code (`@omniterm/core`
components) plus small libraries only. When a gate trips, the fix is almost
never to raise the baseline.

## Externalize vendor libraries; don't bundle them

A large *vendor* browser library must not land in the Vite client bundle. Make
it a dependency of `@omniterm/host` and serve it from its installed
`node_modules` with `express.static`, the way `pdfjs-dist` is served at
`/pdfjs/` (worked through below).

Before reaching for that, check whether the asset needs to ship at all. The
browser-view panel used to serve a 120 MB vendored Chrome DevTools frontend
until we noticed the inspected browser already serves one on its CDP port. The
cheapest vendor dependency is the one you don't take.

Lazy `import()` — for example the CodeMirror grammars — cuts *first-load* time,
but the chunk still ships inside the tarball. It is not a substitute for
externalizing. Prefer externalize-and-serve for any vendor browser library heavy
enough to matter; on-demand loading then applies to the served module too.

## Worked example: pdfjs-dist

`pdfjs-dist` (the PDF viewer, roughly 2 MB including its worker) is an
`@omniterm/host` dependency served at `/pdfjs/` — see `pdfjsDistDir` in
`apps/omniterm/src/server.ts` and `packages/core/server/startServer.ts`. The
client loads it at runtime from `packages/core/app/components/pdfjs-loader.ts`
using type-only imports plus a dynamic URL `import()`, so zero pdf.js bytes are
bundled. The prebuilt `web/pdf_viewer.mjs` reads the core library from
`globalThis.pdfjsLib`, so the loader sets that global before importing the
viewer.

Apply the same treatment if the CodeMirror grammars ever outgrow the budget.

## Cache headers for served vendor assets

Served vendor assets sit at a **stable, non-content-hashed** path —
`/pdfjs/build/pdf.min.mjs` keeps its name across versions. They must therefore
not be served `immutable`. Use a short `max-age` so an ETag or Last-Modified
revalidation picks up a dependency upgrade, instead of a year-long stale cache.

Content-hashed first-party assets under `/assets/` are the opposite case: their
name changes on every build, so they are served `immutable` with a long TTL.
