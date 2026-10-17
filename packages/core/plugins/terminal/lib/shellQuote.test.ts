import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathDropText, shellQuote } from './shellQuote';

test('plain paths are left readable', () => {
  assert.equal(shellQuote('/home/u/src/app.ts'), '/home/u/src/app.ts');
  assert.equal(shellQuote('a-b_c.d,e:f@g+h%i=j'), 'a-b_c.d,e:f@g+h%i=j');
});

test('anything a shell would interpret is single-quoted', () => {
  assert.equal(shellQuote('/tmp/my file'), "'/tmp/my file'");
  assert.equal(shellQuote('$HOME'), "'$HOME'");
  assert.equal(shellQuote('~/x'), "'~/x'");
  assert.equal(shellQuote('=cmd'), "'=cmd'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote(''), "''");
});

test('quoted strings survive a real shell round trip as one word', () => {
  const nasty = [
    "/tmp/it's here",
    '/tmp/$(touch pwned)`id`',
    '/tmp/a\nb',
    '/tmp/!bang *glob? [x]',
    '/tmp/back\\slash "dq"',
  ];
  for (const s of nasty) {
    const out = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(s)}`], { encoding: 'utf-8' });
    assert.equal(out, s);
  }
});

test('a dropped path types the quoted path and a separating space', () => {
  assert.equal(pathDropText('/a b'), "'/a b' ");
  assert.equal(pathDropText('/ab'), '/ab ');
});
