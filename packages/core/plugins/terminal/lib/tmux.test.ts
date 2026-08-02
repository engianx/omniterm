import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  buildNewSessionArgs,
  buildDefaultCommand,
  CLEAN_ENV_SCRIPT,
  CLEAN_ENV_VARS,
} from './tmux.js';

test('buildNewSessionArgs: bare shell runs through the clean-env wrapper', () => {
  assert.deepEqual(buildNewSessionArgs('sess', 'bash', '/w'), [
    'new-session',
    '-d',
    '-s',
    'sess',
    '-c',
    '/w',
    'sh',
    '-c',
    CLEAN_ENV_SCRIPT,
    'omniterm-clean-env',
    'bash',
  ]);
});

test('buildNewSessionArgs: initialCommand is appended as the wrapper $2', () => {
  assert.deepEqual(
    buildNewSessionArgs('sess', 'bash', '/w', undefined, { initialCommand: 'claude --resume x' }),
    [
      'new-session',
      '-d',
      '-s',
      'sess',
      '-c',
      '/w',
      'sh',
      '-c',
      CLEAN_ENV_SCRIPT,
      'omniterm-clean-env',
      'bash',
      'claude --resume x',
    ],
  );
});

test('buildNewSessionArgs: env vars are stamped via -e ahead of the wrapper', () => {
  assert.deepEqual(
    buildNewSessionArgs('s', 'zsh', '/w', { FOO: 'bar' }, { initialCommand: 'run' }),
    [
      'new-session',
      '-d',
      '-s',
      's',
      '-c',
      '/w',
      '-e',
      'FOO=bar',
      'sh',
      '-c',
      CLEAN_ENV_SCRIPT,
      'omniterm-clean-env',
      'zsh',
      'run',
    ],
  );
});

test('buildNewSessionArgs: cwd "~" expands to the home directory', () => {
  assert.deepEqual(buildNewSessionArgs('s', 'bash', '~'), [
    'new-session',
    '-d',
    '-s',
    's',
    '-c',
    homedir(),
    'sh',
    '-c',
    CLEAN_ENV_SCRIPT,
    'omniterm-clean-env',
    'bash',
  ]);
});

// Pins the intent of the env-leak fix: the tmux server bakes the omniterm
// server's full env (itself inherited from whatever shell launched omniterm)
// into every session, so tab shells must start from an allowlist, not a
// denylist. If a leak offender sneaks INTO the allowlist, tabs regress.
test('CLEAN_ENV_VARS keeps deliberate vars and excludes known leak offenders', () => {
  // TMUX/TMUX_PANE are tmux-injected per pane like TERM; dropping them breaks
  // in-pane `tmux` commands and tmux-aware tools (found in review round 1).
  for (const v of [
    'TERM',
    'TMUX',
    'TMUX_PANE',
    'HOME',
    'PATH',
    'SSH_AUTH_SOCK',
    'OMNITERM_BROWSER_REGISTRY_URL',
    'BROWSER',
  ]) {
    assert.ok(CLEAN_ENV_VARS.includes(v), `${v} must be allowlisted`);
  }
  for (const v of [
    'NODE_ENV',
    'PORT',
    'OMNITERM_PORT',
    'OMNITERM_HOST',
    'OMNITERM_DEVTOOLS_DIR',
    'OMNITERM_OWNER_ID',
    'OMNITERM_TTYD_PORT_MIN',
    'OMNITERM_TTYD_PORT_MAX',
  ]) {
    assert.ok(!CLEAN_ENV_VARS.includes(v), `${v} must NOT be allowlisted`);
  }
});

test('CLEAN_ENV_SCRIPT contains no single quotes so buildDefaultCommand can embed it', () => {
  assert.ok(!CLEAN_ENV_SCRIPT.includes("'"));
});

test('CLEAN_ENV_SCRIPT separates initialCommand from the exec with a blank line', () => {
  // A `;` separator would let a trailing `#` comment in the command swallow
  // the exec and kill the pane when the command exits; a single newline would
  // let a trailing backslash line-continue INTO the exec line. The blank line
  // defends against both.
  assert.ok(CLEAN_ENV_SCRIPT.includes('-lc "$cmd\n\nexec \\"\\$0\\"" "$shell"'));
});

test('buildDefaultCommand wraps the script and single-quotes the shell path', () => {
  assert.equal(
    buildDefaultCommand('bash'),
    `exec /bin/sh -c '${CLEAN_ENV_SCRIPT}' omniterm-clean-env 'bash'`,
  );
  assert.equal(
    buildDefaultCommand("/opt/o'dd/fish"),
    `exec /bin/sh -c '${CLEAN_ENV_SCRIPT}' omniterm-clean-env '/opt/o'\\''dd/fish'`,
  );
});

// --- behavioral tests: run the wrapper through a real sh ------------------

// Executes CLEAN_ENV_SCRIPT exactly the way tmux does (sh -c SCRIPT $0
// shell cmd), with an initialCommand that dumps the env and exits before
// the exec-interactive-shell handoff. HOME points at tmpdir so no user
// profile runs during the -lc login pass.
function runCleanEnv(env: Record<string, string>): string[] {
  const out = execFileSync(
    'sh',
    ['-c', CLEAN_ENV_SCRIPT, 'omniterm-clean-env', '/bin/sh', 'env; exit 0'],
    { encoding: 'utf-8', env: { HOME: tmpdir(), PATH: '/usr/bin:/bin', ...env } },
  );
  return out.split('\n');
}

test('clean-env wrapper: allowlisted vars survive, everything else is dropped', () => {
  const lines = runCleanEnv({
    TERM: 'xterm-omnitest',
    SSH_AUTH_SOCK: '/tmp/fake-agent.sock',
    OMNITERM_BROWSER_REGISTRY_URL: 'http://127.0.0.1:1/t/x/registry',
    // The leak offenders that motivated the fix:
    PORT: '4321',
    NODE_ENV: 'production',
    OMNITERM_PORT: '17717',
    npm_lifecycle_event: 'test',
  });
  assert.ok(lines.includes('TERM=xterm-omnitest'));
  assert.ok(lines.includes('SSH_AUTH_SOCK=/tmp/fake-agent.sock'));
  assert.ok(lines.includes('OMNITERM_BROWSER_REGISTRY_URL=http://127.0.0.1:1/t/x/registry'));
  assert.ok(!lines.some((l) => l.startsWith('PORT=')), 'PORT must not leak into the tab shell');
  assert.ok(!lines.some((l) => l.startsWith('NODE_ENV=')), 'NODE_ENV must not leak');
  assert.ok(!lines.some((l) => l.startsWith('OMNITERM_PORT=')), 'OMNITERM_PORT must not leak');
  assert.ok(!lines.some((l) => l.startsWith('npm_lifecycle_event=')), 'npm_* must not leak');
});

test('clean-env wrapper: unset allowlisted vars stay unset, not empty strings', () => {
  const lines = runCleanEnv({ TERM: 'xterm' });
  assert.ok(!lines.some((l) => l.startsWith('BROWSER=')));
  assert.ok(!lines.some((l) => l.startsWith('SSH_AUTH_SOCK=')));
});

test('clean-env wrapper: initialCommand runs with $0 set to the shell path', () => {
  const out = execFileSync(
    'sh',
    ['-c', CLEAN_ENV_SCRIPT, 'omniterm-clean-env', '/bin/sh', 'echo "marker:$0"; exit 0'],
    { encoding: 'utf-8', env: { HOME: tmpdir(), PATH: '/usr/bin:/bin' } },
  );
  assert.ok(out.includes('marker:/bin/sh'));
});

test('clean-env wrapper: trailing backslash cannot line-continue into the exec', () => {
  // Without the blank-line guard, `echo tb-unit \` would splice the exec line
  // into itself and print `tb-unit exec /bin/sh` — and the pane would die
  // instead of dropping to a shell. stdin is closed (input: '') so the exec'd
  // interactive shell reads EOF and exits instead of hanging the test.
  const out = execFileSync(
    'sh',
    ['-c', CLEAN_ENV_SCRIPT, 'omniterm-clean-env', '/bin/sh', 'echo tb-unit \\'],
    { encoding: 'utf-8', input: '', env: { HOME: tmpdir(), PATH: '/usr/bin:/bin' } },
  );
  const lines = out.split('\n').map((l) => l.trim());
  assert.ok(lines.includes('tb-unit'), `expected clean "tb-unit" line, got: ${out}`);
  assert.ok(!out.includes('tb-unit exec'), 'exec line was swallowed by the trailing backslash');
});
