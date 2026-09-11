import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildNewSessionArgs,
  buildCleanEnvScript,
  buildDefaultCommand,
  CLEAN_ENV_SCRIPT,
  CLEAN_ENV_VARS,
} from './tmux.js';
import { setEnvPassthrough } from '../../../lib/sessionEnv.js';

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
  // The stamped names are also allowlisted in the wrapper (spec 001) — stamping
  // alone would set them on the tmux session only for `env -i` to drop them
  // again at the pane.
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
      buildCleanEnvScript(['FOO']),
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
  assert.ok(CLEAN_ENV_SCRIPT.includes('\n$cmd\n\nexec \\"\\$0\\"" "$shell"'));
});

test('CLEAN_ENV_SCRIPT re-prepends the bin dir inside the login shell, before $cmd', () => {
  // The re-prepend must be expanded by the LOGIN shell (so it runs after the
  // profile pass), not by the outer sh that builds the -lc string — hence the
  // escaped `\$`. And it must come before $cmd so an initialCommand that opens
  // a URL already sees the shim dir.
  // The LAST -lc line: the first one is the non-POSIX fallback, which
  // deliberately carries no sh syntax.
  const lcLine = CLEAN_ENV_SCRIPT.split('\n')
    .filter((l) => l.includes('-lc '))
    .at(-1)!;
  assert.ok(
    lcLine.includes('\\$OMNITERM_BIN_DIR\\${PATH:+:\\$PATH}'),
    `unexpected -lc line: ${lcLine}`,
  );
  assert.ok(CLEAN_ENV_SCRIPT.indexOf('OMNITERM_BIN_DIR:') < CLEAN_ENV_SCRIPT.indexOf('\n$cmd'));
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

// --- spec 001: session environment ----------------------------------------

/** The wrapper script out of a `tmux new-session` argv (the word before $0). */
function wrapperScript(args: string[]): string {
  return args[args.indexOf('omniterm-clean-env') - 1]!;
}

test('buildCleanEnvScript with no extras is exactly the shipped wrapper', () => {
  // The scrub is the default; configuring nothing must change nothing.
  assert.equal(buildCleanEnvScript(), CLEAN_ENV_SCRIPT);
  assert.equal(buildCleanEnvScript([]), CLEAN_ENV_SCRIPT);
});

test('buildCleanEnvScript appends extras once, de-duplicated against the base list', () => {
  const script = buildCleanEnvScript(['MY_TOKEN', 'MY_TOKEN', 'PATH', 'OTHER']);
  const forLine = script.split('\n').find((l) => l.startsWith('for v in'))!;
  const names = forLine.replace('for v in ', '').replace('; do', '').split(' ');
  assert.equal(names.filter((n) => n === 'MY_TOKEN').length, 1);
  assert.equal(names.filter((n) => n === 'PATH').length, 1, 'PATH is already in the base list');
  assert.deepEqual(names.slice(0, CLEAN_ENV_VARS.length), CLEAN_ENV_VARS);
  assert.deepEqual(names.slice(CLEAN_ENV_VARS.length), ['MY_TOKEN', 'OTHER']);
});

test('buildCleanEnvScript stays single-quote free with extras', () => {
  // buildDefaultCommand embeds the script in a single-quoted sh -c string.
  assert.ok(!buildCleanEnvScript(['MY_TOKEN', 'OTHER']).includes("'"));
});

test('buildDefaultCommand carries the same extras, so splits are not a downgrade', () => {
  assert.equal(
    buildDefaultCommand('bash', ['MY_TOKEN']),
    `exec /bin/sh -c '${buildCleanEnvScript(['MY_TOKEN'])}' omniterm-clean-env 'bash'`,
  );
});

test('buildNewSessionArgs stamps a per-session env and allowlists its names', () => {
  const args = buildNewSessionArgs('sess', 'bash', '/w', { MY_CONTEXT: 'abc' });
  assert.ok(args.includes('-e'));
  assert.ok(args.includes('MY_CONTEXT=abc'));
  // Stamping alone is not enough: without the allowlist entry `env -i` would
  // drop the value again at the pane. That is the bug this feature fixes.
  assert.equal(wrapperScript(args), buildCleanEnvScript(['MY_CONTEXT']));
});

test('buildNewSessionArgs allowlists the host passthrough names too', () => {
  try {
    setEnvPassthrough(['MY_TOKEN']);
    const args = buildNewSessionArgs('sess', 'bash', '/w', { MY_CONTEXT: 'abc' });
    // Passthrough first (host-level), then the session's own names.
    assert.equal(wrapperScript(args), buildCleanEnvScript(['MY_TOKEN', 'MY_CONTEXT']));
    // Passthrough is names-only: no value for it is stamped into the argv.
    assert.ok(!args.some((a) => a.startsWith('MY_TOKEN=')));
  } finally {
    setEnvPassthrough([]);
  }
});

test('buildNewSessionArgs is byte-identical to before when nothing is configured', () => {
  assert.equal(wrapperScript(buildNewSessionArgs('sess', 'bash', '/w')), CLEAN_ENV_SCRIPT);
});

test('clean-env wrapper: an extra name survives, an unlisted one does not', () => {
  // The behavioral proof, through a real sh, that widening the list works and
  // that widening it for one name does not widen it for everything.
  const out = execFileSync(
    'sh',
    [
      '-c',
      buildCleanEnvScript(['MY_TOKEN']),
      'omniterm-clean-env',
      '/bin/sh',
      'env; exit 0',
    ],
    {
      encoding: 'utf-8',
      env: {
        HOME: tmpdir(),
        PATH: '/usr/bin:/bin',
        MY_TOKEN: 'shhh',
        MY_OTHER_TOKEN: 'also-shhh',
      },
    },
  );
  const lines = out.split('\n');
  assert.ok(lines.includes('MY_TOKEN=shhh'));
  assert.ok(!lines.some((l) => l.startsWith('MY_OTHER_TOKEN=')));
});

// --- issue #25: the shim dir must lead PATH after the login-profile pass ---

// buildTabEnv stamps PATH=<bin dir>:<bootstrap> and the pane then runs a
// LOGIN shell, whose profiles get the last word on PATH. Two shapes break
// the prepend:
//
//   - Reorder: macOS /etc/profile runs `path_helper`, which rebuilds PATH
//     with the system dirs FIRST and every other entry appended — the bin
//     dir survives but lands behind /usr/bin, so an `open` shim loses to
//     /usr/bin/open and interception silently stops working.
//   - Replace: plenty of profiles (Debian's /etc/profile, nvm setups,
//     hand-written dotfiles) assign PATH outright and drop the dir entirely.
//
// The wrapper therefore re-prepends $OMNITERM_BIN_DIR INSIDE the login shell,
// after the profile pass. These tests drive the real wrapper through a real
// sh with a HOME/.profile standing in for each shape.
function runCleanEnvWithProfile(
  profile: string,
  env: Record<string, string>,
  cmd: string,
): string {
  const home = mkdtempSync(path.join(tmpdir(), 'omnitest-profile-'));
  try {
    writeFileSync(path.join(home, '.profile'), profile);
    return execFileSync('sh', ['-c', CLEAN_ENV_SCRIPT, 'omniterm-clean-env', '/bin/sh', cmd], {
      encoding: 'utf-8',
      input: '',
      env: { HOME: home, PATH: '/usr/bin:/bin', ...env },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function panePath(profile: string, env: Record<string, string>): string[] {
  const out = runCleanEnvWithProfile(profile, env, 'echo "OMNIPATH=$PATH"; exit 0');
  const line = out.split('\n').find((l) => l.startsWith('OMNIPATH='));
  assert.ok(line, `no PATH line in wrapper output: ${out}`);
  return line.slice('OMNIPATH='.length).split(':');
}

test('clean-env wrapper: the bin dir leads PATH when a profile REPLACES PATH', () => {
  const entries = panePath('PATH=/usr/bin:/bin\nexport PATH\n', {
    OMNITERM_BIN_DIR: '/opt/omniterm/bin',
    PATH: '/usr/bin:/bin',
  });
  assert.equal(entries[0], '/opt/omniterm/bin', `bin dir not first: ${entries.join(':')}`);
});

test('clean-env wrapper: the bin dir leads PATH when a profile HOISTS the system dirs', () => {
  // The path_helper shape: system dirs moved to the front of whatever PATH the
  // pane started with. The bin dir must still outrank /usr/bin afterwards, or
  // the `open` shim loses to /usr/bin/open and URL interception stops working.
  const entries = panePath('PATH="/usr/bin:/bin:$PATH"\nexport PATH\n', {
    OMNITERM_BIN_DIR: '/opt/omniterm/bin',
    PATH: '/usr/bin:/bin',
  });
  assert.equal(entries[0], '/opt/omniterm/bin', `bin dir not first: ${entries.join(':')}`);
  assert.ok(
    entries.indexOf('/opt/omniterm/bin') < entries.indexOf('/usr/bin'),
    `shim dir must outrank /usr/bin: ${entries.join(':')}`,
  );
});

// The idempotence guard cannot be observed through a real login shell: the
// HOST's /etc/profile runs too, and on macOS that is `path_helper`, which
// reorders PATH no matter what ~/.profile says. So this one substitutes a stub
// for $shell that honours `-lc` but runs NO startup files, leaving the wrapper's
// re-prepend as the only thing that touches PATH.
function runCleanEnvNoProfile(env: Record<string, string>, cmd: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'omnitest-stubshell-'));
  try {
    // Named `bash` so the wrapper's shell-family branch treats it as POSIX;
    // the name is the only thing that selection looks at.
    const stub = path.join(dir, 'bash');
    // Called as `<stub> -lc <payload> <stub>`: run the payload with $0 set to
    // $3, the way a real shell would, but with no profile or rc pass.
    writeFileSync(stub, '#!/bin/sh\nexec /bin/sh -c "$2" "$3"\n', { mode: 0o755 });
    // /bin/sh by absolute path: some callers pass an empty PATH on purpose,
    // and a relative lookup would fail to spawn the wrapper at all.
    return execFileSync('/bin/sh', ['-c', CLEAN_ENV_SCRIPT, 'omniterm-clean-env', stub, cmd], {
      encoding: 'utf-8',
      input: '',
      env: { HOME: dir, PATH: '/usr/bin:/bin', ...env },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('clean-env wrapper: a PATH that already leads with the bin dir is left alone', () => {
  // A caller-supplied per-terminal PATH can already lead with it. Prepending
  // again would duplicate the entry in every pane for no gain.
  const out = runCleanEnvNoProfile(
    { OMNITERM_BIN_DIR: '/opt/omniterm/bin', PATH: '/opt/omniterm/bin:/usr/bin:/bin' },
    'echo "OMNIPATH=$PATH"; exit 0',
  );
  assert.ok(
    out.includes('OMNIPATH=/opt/omniterm/bin:/usr/bin:/bin'),
    `re-prepend must be a no-op when the dir already leads, got: ${out}`,
  );
});

test('clean-env wrapper: the bin dir is prepended when PATH does not lead with it', () => {
  // The counterpart, with the same no-profile isolation: prove the prepend
  // itself is what puts the dir in front, not a side effect of a profile.
  const out = runCleanEnvNoProfile(
    { OMNITERM_BIN_DIR: '/opt/omniterm/bin', PATH: '/usr/bin:/bin' },
    'echo "OMNIPATH=$PATH"; exit 0',
  );
  assert.ok(
    out.includes('OMNIPATH=/opt/omniterm/bin:/usr/bin:/bin'),
    `expected the bin dir prepended exactly once, got: ${out}`,
  );
});

test('clean-env wrapper: with no OMNITERM_BIN_DIR the re-prepend is a no-op', () => {
  // The dangerous regression here is an empty leading entry — in PATH an empty
  // entry means the CURRENT DIRECTORY, so every `open`/`ls` in a tab would
  // prefer a same-named file in cwd. (The exact entries are not asserted: the
  // host's own /etc/profile runs during the login pass and legitimately adds
  // its own — macOS's path_helper does exactly that.)
  const entries = panePath('', { PATH: '/usr/bin:/bin' });
  assert.ok(
    !entries.some((e) => e === ''),
    `an unset OMNITERM_BIN_DIR must not add an empty PATH entry: ${entries.join(':')}`,
  );
  assert.ok(entries.includes('/usr/bin'));
});

// --- review round 1: shells that cannot parse the PATH re-prepend -----------

test('CLEAN_ENV_SCRIPT keeps a non-POSIX login shell on its old, working shape', () => {
  // `defaultShell` is a free-form string in settings (the UI offers bash/zsh,
  // but settings.json is hand-editable and PUT /api/settings validates
  // nothing). fish/csh/nu cannot parse `case…esac`, `${VAR:-}` or `$0`, so
  // embedding the re-prepend in THEIR `-lc` would print a syntax error and
  // kill the pane on arrival — a regression from the plain `-l` they used to
  // get. They must fall back rather than fail.
  const script = CLEAN_ENV_SCRIPT;
  assert.match(script, /case "\$\{shell##\*\/\}" in/);
  assert.ok(
    script.includes('exec env -i "$@" "$shell" -l\n'),
    'the bare -l fallback for non-POSIX shells is gone',
  );
  for (const sh of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']) {
    assert.match(script, new RegExp(`\\b${sh}\\b[^)]*\\) ;;`), `${sh} must take the POSIX path`);
  }
});

/**
 * Run the wrapper with a stub standing in for the user's shell, and report the
 * argv the stub was invoked with. That is how we can tell WHICH shape the
 * wrapper chose without needing fish/csh installed.
 */
function shellArgvFor(shellBasename: string, cmd = ''): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'omnitest-shellpick-'));
  try {
    const stub = path.join(dir, shellBasename);
    const out = path.join(dir, 'argv');
    writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${out}; done\n`, {
      mode: 0o755,
    });
    execFileSync('sh', ['-c', CLEAN_ENV_SCRIPT, 'omniterm-clean-env', stub, cmd], {
      encoding: 'utf-8',
      input: '',
      env: { HOME: dir, PATH: '/usr/bin:/bin', OMNITERM_BIN_DIR: '/opt/omniterm/bin' },
    });
    return readFileSync(out, 'utf-8').split('\n').filter((l) => l !== '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('clean-env wrapper: a POSIX shell is handed the re-prepend, fish is not', () => {
  const bash = shellArgvFor('bash');
  assert.equal(bash[0], '-lc');
  assert.match(bash[1] ?? '', /OMNITERM_BIN_DIR/, 'bash must receive the PATH re-prepend');

  // The regression this guards: fish previously got `-l` and a working pane.
  const fish = shellArgvFor('fish');
  assert.deepEqual(fish, ['-l'], 'fish must get the plain login shell, no sh syntax');
});

test('clean-env wrapper: a non-POSIX shell with an initialCommand keeps its old shape', () => {
  // Not made BETTER here (that shape's `exec "$0"` is already meaningless to
  // fish) — just not made worse. Byte-identical to the pre-fix behaviour.
  const fish = shellArgvFor('fish', 'echo hi');
  assert.equal(fish[0], '-lc');
  assert.ok(!fish[1]?.includes('OMNITERM_BIN_DIR'), 'no sh syntax may reach a non-POSIX shell');
  assert.ok(fish[1]?.startsWith('echo hi'), `unexpected command payload: ${fish[1]}`);
});

test('clean-env wrapper: a profile that clears PATH gains no trailing empty entry', () => {
  // Mirror of the leading-`:` guard: a TRAILING empty field means the current
  // directory just as a leading one does. The wrapper itself always has a
  // usable PATH (it needs printenv and env), so the reachable version of this
  // is a PROFILE unsetting PATH — after which our prepend is all that is left.
  const entries = panePath('unset PATH\n', { OMNITERM_BIN_DIR: '/opt/omniterm/bin' });
  assert.deepEqual(entries, ['/opt/omniterm/bin'], `trailing empty PATH entry: ${entries}`);
});

test('clean-env wrapper: a PATH that is exactly the bin dir is not duplicated', () => {
  // The `case` guard's first pattern. Without it the dir would be prepended to
  // itself, since a bare `<dir>` does not match the `<dir>:*` pattern.
  const entries = panePath('PATH=/opt/omniterm/bin\nexport PATH\n', {
    OMNITERM_BIN_DIR: '/opt/omniterm/bin',
  });
  assert.deepEqual(entries, ['/opt/omniterm/bin'], `duplicated bin dir: ${entries}`);
});
