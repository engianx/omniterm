import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_IDS, detectLanguage } from './languages.js';
import {
  hasGrammar,
  loadLangExtension,
  NO_GRAMMAR_LANGUAGE_IDS,
} from '../app/components/langExtensions.js';

// hasGrammar reports whether an id maps to a (lazily-loaded) grammar loader.
// Every id the server can emit must either map to a grammar or be explicitly
// listed as grammar-less — so adding a language to EXT_TO_LANG without a client
// decision fails here instead of silently rendering plain text.
test('every detectable language id has a client grammar decision', () => {
  for (const id of LANGUAGE_IDS) {
    if (NO_GRAMMAR_LANGUAGE_IDS.has(id)) {
      assert.ok(!hasGrammar(id), `'${id}' is listed in NO_GRAMMAR_LANGUAGE_IDS but has a grammar`);
    } else {
      assert.ok(hasGrammar(id), `'${id}' has no grammar and is not listed in NO_GRAMMAR_LANGUAGE_IDS`);
    }
  }
});

// Each grammar is dynamically import()ed on demand. Loading every one here
// resolves all the lazy chunks and proves each loader's named export is wired
// correctly — a typo'd import or moved export fails here instead of silently
// rendering plain text in the browser.
test('every grammar id loads to a real extension on demand', async () => {
  for (const id of LANGUAGE_IDS) {
    if (NO_GRAMMAR_LANGUAGE_IDS.has(id)) continue;
    const ext = await loadLangExtension(id);
    const empty = Array.isArray(ext) && ext.length === 0;
    assert.ok(!empty, `'${id}' has a grammar decision but its loader returned no extension`);
  }
});

test('loadLangExtension returns plain text for grammar-less ids', async () => {
  const ext = await loadLangExtension('makefile');
  assert.ok(Array.isArray(ext) && ext.length === 0);
});

test('detectLanguage falls back by basename, then to text', () => {
  assert.equal(detectLanguage('.yaml', 'config.yaml'), 'yaml');
  assert.equal(detectLanguage('', 'dockerfile'), 'dockerfile');
  assert.equal(detectLanguage('', 'makefile'), 'makefile');
  assert.equal(detectLanguage('.unknown', 'foo.unknown'), 'text');
});
