import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPreviewKind,
  detectViewerKind,
  isPreviewable,
  rawPreviewUrl,
} from './previewable.js';

test('detectViewerKind maps image extensions', () => {
  // ico/bmp included to preserve parity with the removed data-URI image path.
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp']) {
    assert.equal(detectViewerKind(`/a/b/file.${ext}`), 'image', ext);
  }
});

test('detectViewerKind maps pdf and delimited extensions', () => {
  assert.equal(detectViewerKind('/x/doc.pdf'), 'pdf');
  assert.equal(detectViewerKind('/x/data.csv'), 'csv');
  assert.equal(detectViewerKind('/x/data.tsv'), 'csv');
});

test('detectViewerKind is case-insensitive', () => {
  assert.equal(detectViewerKind('/x/IMG.PNG'), 'image');
  assert.equal(detectViewerKind('/x/Report.PDF'), 'pdf');
  assert.equal(detectViewerKind('/x/Data.CSV'), 'csv');
});

test('detectViewerKind returns null for non-viewer files', () => {
  for (const p of ['/x/main.ts', '/x/readme.md', '/x/index.html', '/x/notes', '/x/archive.zip']) {
    assert.equal(detectViewerKind(p), null, p);
  }
});

// The two dispatchers must never both claim the same extension: a file is
// either an in-place viewer, a preview-pair candidate, or plain text/binary.
test('viewer and preview dispatch never overlap', () => {
  const exts = [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'pdf', 'csv', 'tsv',
    'md', 'markdown', 'html', 'htm', 'ts', 'json', 'txt', 'zip',
  ];
  for (const ext of exts) {
    const p = `/x/f.${ext}`;
    const v = detectViewerKind(p);
    const pk = detectPreviewKind(p);
    assert.ok(!(v !== null && pk !== null), `${ext} claimed by both dispatchers`);
  }
  // isPreviewable stays aligned with detectPreviewKind.
  assert.equal(isPreviewable('/x/f.md'), true);
  assert.equal(isPreviewable('/x/f.png'), false);
});

test('rawPreviewUrl encodes segments and preserves slashes', () => {
  assert.equal(rawPreviewUrl('/Users/me/proj/x.pdf'), '/api/preview/raw/Users/me/proj/x.pdf');
  // spaces and other unsafe chars are percent-encoded per segment
  assert.equal(rawPreviewUrl('/Users/me/a b/x y.png'), '/api/preview/raw/Users/me/a%20b/x%20y.png');
  // leading slashes are trimmed (route rebuilds the leading slash)
  assert.equal(rawPreviewUrl('///etc/hosts'), '/api/preview/raw/etc/hosts');
  // a literal '#' or '?' in a name must not terminate the path
  assert.equal(rawPreviewUrl('/d/a#b?.csv'), '/api/preview/raw/d/a%23b%3F.csv');
});
