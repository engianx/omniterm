import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnvNameError,
  assertValidEnvName,
  getEnvPassthrough,
  isValidEnvName,
  parseEnvPassthrough,
  parseEnvPassthroughArgv,
  setEnvPassthrough,
} from './sessionEnv.js';

test('isValidEnvName accepts POSIX-shaped names', () => {
  for (const name of ['A', '_x', 'A1_B', 'ANTHROPIC_AUTH_TOKEN', '_'])
    assert.equal(isValidEnvName(name), true, name);
});

// Names are interpolated unquoted into the pane wrapper script, which is itself
// embedded in a single-quoted `sh -c` string for tmux's default-command — so
// each of these would be code execution in every pane of the session, not a
// cosmetic problem. They must be rejected, never sanitized.
test('isValidEnvName rejects anything that could break out of the wrapper script', () => {
  for (const name of [
    '',
    '1ABC',
    'A-B',
    'A B',
    'A;B',
    "A'B",
    'A"B',
    'A$B',
    'A`B',
    'A\nB',
    'A=B',
    'A|B',
    'A&B',
    '$(id)',
    '*',
  ])
    assert.equal(isValidEnvName(name), false, JSON.stringify(name));
});

test('isValidEnvName rejects the names omniterm needs for itself', () => {
  assert.equal(isValidEnvName('TMUX'), false);
  assert.equal(isValidEnvName('TMUX_PANE'), false);
});

/** Run `fn` and return the EnvNameError it threw (assert.throws returns nothing). */
function envNameErrorFrom(fn: () => unknown): EnvNameError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof EnvNameError, `expected an EnvNameError, got ${String(e)}`);
    return e;
  }
  assert.fail('expected a throw');
}

test('assertValidEnvName reports which rule was broken and names the entry', () => {
  const reserved = envNameErrorFrom(() => assertValidEnvName('TMUX'));
  assert.equal(reserved.envName, 'TMUX');
  assert.match(reserved.message, /reserved/);

  const bad = envNameErrorFrom(() => assertValidEnvName('A B'));
  assert.equal(bad.envName, 'A B');
  assert.match(bad.message, /not a valid environment variable name/);
});

test('parseEnvPassthrough trims, drops blanks, and de-duplicates in order', () => {
  assert.deepEqual(parseEnvPassthrough(' A , B ,,A, C,'), ['A', 'B', 'C']);
  assert.deepEqual(parseEnvPassthrough(''), []);
  assert.deepEqual(parseEnvPassthrough('   '), []);
});

// A silently dropped name means terminals come up missing configuration the
// operator believes they have, so a bad entry fails loudly.
test('parseEnvPassthrough throws naming the offending entry', () => {
  const err = envNameErrorFrom(() => parseEnvPassthrough('GOOD,bad name'));
  assert.equal(err.envName, 'bad name');
});

test('parseEnvPassthroughArgv reads repeated flags and merges them', () => {
  assert.deepEqual(
    parseEnvPassthroughArgv(['--plugin', 'x', '--env-passthrough', 'A,B', '--env-passthrough', 'B,C']),
    ['A', 'B', 'C'],
  );
  assert.deepEqual(parseEnvPassthroughArgv([]), []);
  assert.deepEqual(parseEnvPassthroughArgv(['--plugin', 'x']), []);
});

test('parseEnvPassthroughArgv rejects a missing value', () => {
  assert.throws(() => parseEnvPassthroughArgv(['--env-passthrough']), EnvNameError);
  assert.throws(() => parseEnvPassthroughArgv(['--env-passthrough', '--plugin']), EnvNameError);
});

test('the passthrough list is empty until set, and validates what it is given', () => {
  assert.deepEqual(getEnvPassthrough(), []);
  setEnvPassthrough(['A', 'B']);
  assert.deepEqual(getEnvPassthrough(), ['A', 'B']);
  assert.throws(() => setEnvPassthrough(['A', 'TMUX']), EnvNameError);
  setEnvPassthrough([]);
  assert.deepEqual(getEnvPassthrough(), []);
});
