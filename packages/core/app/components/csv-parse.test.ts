import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCsvDelimiter, parseCsv } from './csv-parse.js';

test('detectCsvDelimiter uses tab for .tsv regardless of content', () => {
  assert.equal(detectCsvDelimiter('/x/data.tsv', 'a,b,c\n1,2,3'), '\t');
});

test('detectCsvDelimiter sniffs comma / tab / semicolon', () => {
  assert.equal(detectCsvDelimiter('/x/a.csv', 'a,b,c\n1,2,3'), ',');
  assert.equal(detectCsvDelimiter('/x/a.txt', 'a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectCsvDelimiter('/x/a.csv', 'a;b;c\n1;2;3'), ';');
});

test('detectCsvDelimiter defaults to comma when nothing matches', () => {
  assert.equal(detectCsvDelimiter('/x/a.csv', 'single-column\nvalue'), ',');
  assert.equal(detectCsvDelimiter('/x/a.csv', ''), ',');
});

test('parseCsv splits a simple grid', () => {
  const { rows, maxColumns } = parseCsv('a,b,c\n1,2,3\n4,5,6', ',');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
    ['4', '5', '6'],
  ]);
  assert.equal(maxColumns, 3);
});

test('parseCsv handles quoted delimiters, escaped quotes and newlines', () => {
  const text = 'name,note\n"Smith, J","line1\nline2"\n"a ""quoted"" b",ok';
  const { rows } = parseCsv(text, ',');
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['Smith, J', 'line1\nline2'],
    ['a "quoted" b', 'ok'],
  ]);
});

test('parseCsv ignores a single trailing newline (no spurious empty row)', () => {
  assert.equal(parseCsv('a,b\n1,2\n', ',').rows.length, 2);
  // CRLF normalization
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n', ',').rows, [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('parseCsv reports maxColumns for ragged rows', () => {
  const { rows, maxColumns } = parseCsv('a,b,c\n1,2\n3', ',');
  assert.equal(maxColumns, 3);
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2'], ['3']]);
});

test('parseCsv on empty input yields no rows', () => {
  assert.deepEqual(parseCsv('', ',').rows, []);
});

test('parseCsv keeps empty fields (consecutive delimiters)', () => {
  assert.deepEqual(parseCsv('a,,c', ',').rows, [['a', '', 'c']]);
});

test('detectCsvDelimiter prefers the consistent candidate on ragged counts', () => {
  // line 1 has 2 commas, line 2 has 1 — comma is inconsistent but still the only
  // candidate present, so it wins over tab/semicolon (which never appear).
  assert.equal(detectCsvDelimiter('/x/a.csv', 'a,b,c\n1,2'), ',');
});

test('parseCsv strips a leading UTF-8 BOM from the first cell', () => {
  const { rows } = parseCsv('﻿a,b\n1,2', ',');
  assert.deepEqual(rows[0], ['a', 'b']); // not ['﻿a', 'b']
});

test('parseCsv splits TSV with a tab delimiter', () => {
  assert.deepEqual(parseCsv('a\tb\n1\t2', '\t').rows, [
    ['a', 'b'],
    ['1', '2'],
  ]);
});
