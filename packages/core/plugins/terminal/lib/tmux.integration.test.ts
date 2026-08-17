import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Integration proof for the clean-env wrapper and the `=name:` target fix,
// driving the REAL production functions (createTmuxSession, getTmuxPaneTitle)
// against a real but ISOLATED tmux server. Isolation works because tmux
// resolves its socket directory from TMUX_TMPDIR and the production code's
// execFileSync calls inherit process.env — so pointing TMUX_TMPDIR at a temp
// dir sends every production tmux call to a private server with zero
// production changes. The developer's real tmux server (which hosts live
// omniterm sessions) is never touched.
//
// Each test creates its own session — no ordering dependencies between tests.
// Self-skips when tmux is not installed (CI's publish workflows don't install
// it); a skip is reported as a skip, never as a pass. The behavior under test
// is specs/001-omniterm-core/spec.md FR-010 – FR-013 (the pane environment).

function resolveTmux(): string | null {
  try {
    return execFileSync('which', ['tmux'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

const TMUX_BIN = resolveTmux();
const skip = TMUX_BIN ? false : 'tmux not installed';

const WORK = mkdtempSync(path.join(tmpdir(), 'omnitest-clean-env-'));
const SOCK_DIR = mkdtempSync(path.join(tmpdir(), 'omnitest-tmux-sock-'));

// Environment setup MUST happen before importing tmux.js (SETTINGS_DIR is
// captured at module load of lib/paths.ts), hence the dynamic import below.
// These process.env mutations are safe only because the node test runner
// executes each test FILE in its own child process — if files ever share a
// process, the HOME/SETTINGS_DIR/leak-var mutations here would bleed into
// other suites.
//
// - Delete TMUX/TMUX_PANE: if this test process itself runs inside a tmux
//   pane, the tmux client prefers the $TMUX socket over TMUX_TMPDIR — the
//   production calls under test would land on the REAL server. Deleting them
//   forces TMUX_TMPDIR resolution. (Panes still get fresh TMUX/TMUX_PANE
//   injected by the isolated server.)
// - HOME → empty temp dir: the wrapper's login-shell pass sources no user
//   profiles (fast, machine-independent). os.homedir() follows $HOME.
// - SETTINGS_DIR → empty temp dir: loadSettings() returns defaults
//   (defaultShell 'bash') without touching the user's settings.
// - Leak vars: the tmux server inherits this process env, standing in for
//   "omniterm launched from a dirty shell". NODE_ENV=test is already set by
//   the test script and is itself a leak the panes must not see.
delete process.env.TMUX;
delete process.env.TMUX_PANE;
process.env.TMUX_TMPDIR = SOCK_DIR;
process.env.SETTINGS_DIR = path.join(SOCK_DIR, 'settings');
process.env.HOME = WORK;
process.env.SSH_AUTH_SOCK = '/tmp/omnitest-fake-agent.sock';
process.env.FAKE_LEAK = 'oops';
// Stands in for a value the operator wants panes to keep (spec 001). It MUST be
// set before the first tmux call: the wrapper reads passthrough values with
// printenv inside the tmux server, which inherits this process's environment
// when it is first started. MY_UNSET_TOKEN is deliberately never set.
process.env.MY_PASSTHROUGH_TOKEN = 'ptok';
process.env.PORT = '4321';
process.env.OMNITERM_PORT = '17717';

const { createTmuxSession, getTmuxPaneTitle } = await import('./tmux.js');
const { setEnvPassthrough } = await import('../../../lib/sessionEnv.js');

// Mirrors the shape buildTabEnv stamps via `-e` (kept inline: importing
// sessions.js would trigger its module-load recovery pass).
const TAB_ENV = {
  OMNITERM_BROWSER_REGISTRY_URL: 'http://127.0.0.1:1/t/x/registry',
  PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
};

// Direct tmux helper for assertions — inherits process.env like the
// production code does, so it talks to the same isolated server.
function tmux(args: string[]): string {
  return execFileSync(TMUX_BIN!, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function pollFor<T>(label: string, fn: () => T | null): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

function envFileLines(file: string): (() => string[] | null) {
  // The dump is complete once the terminating marker line lands.
  return () => {
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf-8').split('\n');
    return lines.includes('__DUMP_DONE__') ? lines : null;
  };
}

async function waitPaneAlive(name: string, label: string): Promise<void> {
  // pane_dead=0 plus a live shell process proves the wrapper's exec handoff
  // landed. pane_current_command is bash/dash/sh depending on the shell.
  await pollFor(`${label}: live shell`, () => {
    const out = tmux(['list-panes', '-t', `=${name}:`, '-F', '#{pane_dead} #{pane_current_command}'])
      .trim();
    const [dead, cmd] = out.split(' ');
    return dead === '0' && /sh$/.test(cmd ?? '') ? out : null;
  });
}

async function dumpPaneEnv(name: string, file: string, label: string): Promise<string[]> {
  await waitPaneAlive(name, label);
  tmux(['send-keys', '-t', `=${name}:`, `{ env; echo __DUMP_DONE__; } > ${file}`, 'Enter']);
  return pollFor(`${label}: env dump`, envFileLines(file));
}

function assertCleanPaneEnv(lines: string[], label: string) {
  for (const leaked of ['FAKE_LEAK=', 'PORT=', 'NODE_ENV=', 'OMNITERM_PORT=', 'npm_lifecycle_event=']) {
    assert.ok(!lines.some((l) => l.startsWith(leaked)), `${label}: ${leaked} leaked into pane env`);
  }
  assert.ok(lines.some((l) => l.startsWith('TERM=')), `${label}: TERM missing (env -i wiped it)`);
  // tmux-injected per-pane vars must survive like TERM does — dropping them
  // breaks in-pane `tmux` commands and tmux-aware tools (review round 1).
  assert.ok(lines.some((l) => l.startsWith('TMUX=')), `${label}: TMUX missing`);
  assert.ok(lines.some((l) => l.startsWith('TMUX_PANE=')), `${label}: TMUX_PANE missing`);
  assert.ok(lines.some((l) => l.startsWith('PATH=')), `${label}: PATH missing`);
  assert.ok(
    lines.includes(`SSH_AUTH_SOCK=${process.env.SSH_AUTH_SOCK}`),
    `${label}: SSH_AUTH_SOCK not preserved`,
  );
  assert.ok(
    lines.includes(`OMNITERM_BROWSER_REGISTRY_URL=${TAB_ENV.OMNITERM_BROWSER_REGISTRY_URL}`),
    `${label}: -e stamped registry URL did not reach the shell`,
  );
}

after(() => {
  if (TMUX_BIN) {
    try {
      execFileSync(TMUX_BIN, ['kill-server'], { stdio: 'ignore' });
    } catch {}
  }
  for (const dir of [WORK, SOCK_DIR]) rmSync(dir, { recursive: true, force: true });
});

test('createTmuxSession: pane env is clean and batched session options apply', { skip }, async () => {
  createTmuxSession('it-clean', WORK, TAB_ENV);

  // The batched `set-option -t =name:` calls run under a swallowing
  // try/catch, so asserting the options actually LANDED is the regression
  // guard for the `=name:` colon fix: on tmux 3.6 a bare `=name` fails to
  // resolve and these would silently no-op (exactly the pre-fix bug).
  assert.match(tmux(['show-options', '-t', '=it-clean:', 'mouse']), /mouse on/);
  assert.ok(
    tmux(['show-options', '-t', '=it-clean:', 'default-command']).includes('omniterm-clean-env'),
    'default-command option did not apply',
  );

  // getTmuxPaneTitle's display-message uses the same pane-target syntax; on
  // regression to bare `=name` it returns '' (empty expansions) on tmux 3.6.
  assert.ok(getTmuxPaneTitle('it-clean'), 'getTmuxPaneTitle returned empty');

  const lines = await dumpPaneEnv('it-clean', path.join(WORK, 'clean.env'), 'bare pane');
  assertCleanPaneEnv(lines, 'bare pane');
});

test('createTmuxSession: hostile initialCommand runs verbatim and the pane survives', { skip }, async () => {
  // Embedded escaped quote, command substitution, and a trailing `#` comment
  // — the code comments promise the `#` cannot swallow the exec handoff.
  const out = path.join(WORK, 'hostile.out');
  createTmuxSession('it-hostile', WORK, TAB_ENV, {
    initialCommand: `{ echo "dq\\" bt $(echo sub) hash"; echo __DUMP_DONE__; } > ${out} # tail comment`,
  });
  const lines = await pollFor('hostile initialCommand output', envFileLines(out));
  assert.equal(lines[0], 'dq" bt sub hash', 'hostile quoting was mangled in transit');
  await waitPaneAlive('it-hostile', 'hostile initialCommand');
});

test('createTmuxSession: trailing-backslash initialCommand cannot swallow the exec', { skip }, async () => {
  // A trailing backslash line-continues; the blank line in CLEAN_ENV_SCRIPT
  // absorbs it so the `exec "$0"` line stays intact and the pane lives.
  const out = path.join(WORK, 'tb.out');
  createTmuxSession('it-tb', WORK, TAB_ENV, {
    initialCommand: `{ echo tb-ran; echo __DUMP_DONE__; } > ${out} \\`,
  });
  const lines = await pollFor('trailing-backslash output', envFileLines(out));
  assert.equal(lines[0], 'tb-ran');
  await waitPaneAlive('it-tb', 'trailing-backslash initialCommand');
});

test('createTmuxSession: new windows are cleaned by its default-command', { skip }, async () => {
  createTmuxSession('it-win', WORK, TAB_ENV);
  await waitPaneAlive('it-win', 'initial window');
  // No command → tmux runs the default-command wrapper (the path split panes
  // and prefix-c windows take, bypassing the new-session argv entirely).
  tmux(['new-window', '-t', '=it-win:']);
  const lines = await dumpPaneEnv('it-win', path.join(WORK, 'win.env'), 'default-command window');
  assertCleanPaneEnv(lines, 'default-command window');
});

// --- spec 001: session environment ----------------------------------------

test('createTmuxSession: a per-session env reaches the pane and outlives the command', { skip }, async () => {
  // The initial command writes a marker and EXITS, so the env dump below comes
  // from the shell the wrapper drops to afterwards. That is the case the old
  // `FOO=bar cmd` prefix could not cover, and the reason this feature exists.
  const out = path.join(WORK, 'sessenv.out');
  createTmuxSession(
    'it-env',
    WORK,
    { ...TAB_ENV, MY_CONTEXT: 'abc', MY_HOME_DIR: '/tmp/ctx' },
    { initialCommand: `{ echo "cmd:$MY_CONTEXT"; echo __DUMP_DONE__; } > ${out}` },
  );

  const cmdOut = await pollFor('initial command output', envFileLines(out));
  assert.equal(cmdOut[0], 'cmd:abc', 'the initial command did not see the session env');

  const lines = await dumpPaneEnv('it-env', path.join(WORK, 'sessenv.env'), 'session env');
  assert.ok(lines.includes('MY_CONTEXT=abc'), 'MY_CONTEXT did not survive the command exiting');
  assert.ok(lines.includes('MY_HOME_DIR=/tmp/ctx'));
  assertCleanPaneEnv(lines, 'session env');

  // Splits and prefix-c windows go through default-command, not the
  // new-session argv — they must not be a downgrade.
  tmux(['new-window', '-t', '=it-env:']);
  const winLines = await dumpPaneEnv('it-env', path.join(WORK, 'sessenv-win.env'), 'session env window');
  assert.ok(winLines.includes('MY_CONTEXT=abc'), 'a new window lost the session env');
});

test('createTmuxSession: a session env does not leak into another session', { skip }, async () => {
  createTmuxSession('it-env-other', WORK, TAB_ENV);
  const lines = await dumpPaneEnv('it-env-other', path.join(WORK, 'other.env'), 'sibling session');
  assert.ok(!lines.some((l) => l.startsWith('MY_CONTEXT=')), 'session env crossed sessions');
});

test('createTmuxSession: host passthrough names cross the scrub, unset ones stay unset', { skip }, async () => {
  try {
    setEnvPassthrough(['MY_PASSTHROUGH_TOKEN', 'MY_UNSET_TOKEN']);
    createTmuxSession('it-passthrough', WORK, TAB_ENV);
    const lines = await dumpPaneEnv('it-passthrough', path.join(WORK, 'pass.env'), 'passthrough');
    assert.ok(lines.includes('MY_PASSTHROUGH_TOKEN=ptok'), 'passthrough value did not reach the pane');
    // printenv skips unset vars, so a listed-but-unset name must not appear at
    // all — an empty string would look like a configured-but-blank credential.
    assert.ok(!lines.some((l) => l.startsWith('MY_UNSET_TOKEN')), 'unset name became an empty value');
    assertCleanPaneEnv(lines, 'passthrough');
  } finally {
    setEnvPassthrough([]);
  }
});

test('createTmuxSession: with nothing configured a pane is unchanged', { skip }, async () => {
  // The scrub stays the default: a name that was not asked for does not cross,
  // even though a sibling session earlier in this file allowed it.
  createTmuxSession('it-default', WORK, TAB_ENV);
  const lines = await dumpPaneEnv('it-default', path.join(WORK, 'default.env'), 'unconfigured');
  assert.ok(!lines.some((l) => l.startsWith('MY_PASSTHROUGH_TOKEN=')), 'passthrough outlived its config');
  assertCleanPaneEnv(lines, 'unconfigured');
});

test('createTmuxSession: a per-session value shadows the host passthrough for the same name', { skip }, async () => {
  // Both inputs can name the same variable. The pane must see the per-session
  // value (spec 001 FR-013): `tmux -e` sets it on the session, which shadows the
  // tmux server env the passthrough reads with printenv. Asserting the allowlist
  // ORDER alone would not catch a regression here — the value is what matters.
  try {
    setEnvPassthrough(['MY_PASSTHROUGH_TOKEN']);
    createTmuxSession('it-precedence', WORK, { ...TAB_ENV, MY_PASSTHROUGH_TOKEN: 'session-wins' });
    const lines = await dumpPaneEnv('it-precedence', path.join(WORK, 'prec.env'), 'precedence');
    assert.ok(
      lines.includes('MY_PASSTHROUGH_TOKEN=session-wins'),
      `expected the session value to win, got: ${lines.filter((l) => l.startsWith('MY_PASSTHROUGH_TOKEN')).join(',')}`,
    );
    assert.ok(!lines.includes('MY_PASSTHROUGH_TOKEN=ptok'));
  } finally {
    setEnvPassthrough([]);
  }
});
