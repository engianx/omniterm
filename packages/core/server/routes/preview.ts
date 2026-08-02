import { Router } from 'express';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { marked } from 'marked';
import { confinePath } from '../../lib/paths.js';
import { allowedRoots } from '../../lib/allowedRoots.js';

export const previewRouter: Router = Router();

const MAX_MARKDOWN_BYTES = 1024 * 1024; // 1MB — same cap as /api/fs read.
const MAX_RAW_BYTES = 25 * 1024 * 1024; // 25MB — generous for HTML + images served as page resources.

/**
 * Render a markdown file to a self-contained HTML document for preview.
 *
 * Returns a full HTML page (not just a fragment) so the iframe can render
 * it via `srcdoc` with no further fetches. Styles are inlined to keep the
 * preview self-contained even under a strict sandbox.
 *
 * The output is meant to load inside a `sandbox=""` iframe — no scripts,
 * no forms, no top-navigation. We rely on `marked`'s default sanitization
 * being absent (it doesn't sanitize), so callers SHOULD treat this output
 * as untrusted markup; the sandbox is the security boundary, not marked.
 */
previewRouter.get('/preview/markdown', async (req, res) => {
  const rawPath = (req.query.path as string) || '';
  const resolved = confinePath(rawPath, allowedRoots());
  if (!resolved) {
    res.status(403).type('text/plain').send('Path outside allowed roots');
    return;
  }
  try {
    const s = await stat(resolved);
    if (s.size > MAX_MARKDOWN_BYTES) {
      res.status(413).type('text/plain').send('Markdown file too large (>1MB)');
      return;
    }
    const source = await readFile(resolved, 'utf-8');
    const body = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
    res.type('text/html; charset=utf-8').send(renderShell(path.basename(resolved), body));
  } catch {
    res.status(404).type('text/plain').send('Not found');
  }
});

/**
 * Serve a raw file by absolute path so the iframe can resolve relative
 * sibling assets through the SAME route. The wildcard captures URL path
 * segments after `/api/preview/raw/`, which are joined with a leading `/`
 * to reconstruct the absolute filesystem path. Example:
 *
 *   iframe src=/api/preview/raw/Users/me/proj/index.html
 *   <img src="logo.png">  →  /api/preview/raw/Users/me/proj/logo.png
 *
 * Both requests hit this handler; the second resolves to the sibling file
 * because the browser resolves `logo.png` against the iframe URL's directory.
 *
 * Confined to `allowedRoots()` so an attacker can't escape with `..` or by
 * crafting a path under `/etc` or `/root`.
 */
previewRouter.get(/^\/preview\/raw\/(.+)$/, async (req, res) => {
  // Express 5 surfaces unnamed regex capture groups under numeric string
  // keys on `req.params` (e.g. `req.params["0"]` for the first group).
  // The default ParamsDictionary type only declares string-keyed names, so
  // we reach in via a Record cast — single cast, no `unknown`.
  const captured = (req.params as Record<string, string>)['0'] ?? '';
  if (!captured) {
    res.status(400).type('text/plain').send('Missing path');
    return;
  }
  // URL segments are decoded by Express. Reconstruct an absolute path.
  const absPath = '/' + captured;
  const resolved = confinePath(absPath, allowedRoots());
  if (!resolved) {
    res.status(403).type('text/plain').send('Path outside allowed roots');
    return;
  }
  try {
    const s = await stat(resolved);
    if (!s.isFile()) {
      res.status(404).type('text/plain').send('Not a file');
      return;
    }
    if (s.size > MAX_RAW_BYTES) {
      res.status(413).type('text/plain').send('File too large (>25MB)');
      return;
    }
    // `dotfiles: "allow"` — `confinePath` already enforces the security
    // boundary, and refusing dotfile paths would block legitimate preview
    // targets that happen to live under, e.g., `~/.config/...`.
    res.sendFile(resolved, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) {
        res.status(500).type('text/plain').send('Send failed');
      }
    });
  } catch {
    res.status(404).type('text/plain').send('Not found');
  }
});

function renderShell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --md-fg: #1f2328;
    --md-bg: #ffffff;
    --md-muted: #59636e;
    --md-border: #d1d9e0;
    --md-code-bg: #f6f8fa;
    --md-link: #0969da;
    --md-quote: #59636e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --md-fg: #e6edf3;
      --md-bg: #0d1117;
      --md-muted: #9198a1;
      --md-border: #30363d;
      --md-code-bg: #151b23;
      --md-link: #4493f8;
      --md-quote: #9198a1;
    }
  }
  html, body { background: var(--md-bg); color: var(--md-fg); }
  body {
    margin: 0;
    padding: 32px 48px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    max-width: 980px;
    box-sizing: border-box;
  }
  @media (max-width: 720px) { body { padding: 16px; } }
  h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin-top: 1.6em; margin-bottom: 0.6em; }
  h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--md-border); }
  h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--md-border); }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1em; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
  a { color: var(--md-link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre, kbd { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  code { padding: 0.2em 0.4em; background: var(--md-code-bg); border-radius: 4px; font-size: 85%; }
  pre { padding: 14px; overflow: auto; background: var(--md-code-bg); border-radius: 6px; }
  pre code { padding: 0; background: transparent; font-size: 90%; }
  blockquote {
    margin: 0 0 1em; padding: 0 1em;
    color: var(--md-quote); border-left: 4px solid var(--md-border);
  }
  table { border-collapse: collapse; }
  th, td { padding: 6px 13px; border: 1px solid var(--md-border); }
  tr:nth-child(2n) { background: var(--md-code-bg); }
  hr { height: 1px; background: var(--md-border); border: 0; margin: 24px 0; }
  img { max-width: 100%; }
  ul, ol { padding-left: 2em; }
  li + li { margin-top: 0.25em; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
