import { execFileSync } from 'child_process';
import { unlinkSync } from 'fs';
import { homedir } from 'os';
import { loadSettings } from '../../../lib/settings.js';

// Configure tmux mouse drag-selection → browser clipboard via OSC 52.
//
// `set-clipboard on` + `terminal-features *:clipboard` tells tmux to emit
// an OSC 52 escape sequence on copy. ttyd 1.7.7's bundled xterm.js does
// not handle OSC 52 itself, so the iframe wrapper registers a custom OSC
// 52 handler on the xterm.js Terminal instance that decodes the payload
// and writes it to the browser's clipboard (see TerminalView.tsx). This
// makes drag-select copy work on macOS / Linux / remote-server setups
// without relying on Shift-drag (which ttyd's xterm.js doesn't honor as
// a mouse-tracking bypass).
//
// Scrollback: PageUp (no prefix) enters tmux copy mode without the usual
// auto-scroll jump. With tmux `mouse on` (see createTmuxSession), the
// wheel auto-enters copy-mode too.
//
// IMPORTANT: each command token must be passed as a separate argv element.
// Passing "send-keys -X copy-pipe-and-cancel" as a single string causes tmux
// to silently drop the trailing arguments.
let tmuxBindingsApplied = false;
export function ensureTmuxBindings(): void {
  if (tmuxBindingsApplied) return;
  tmuxBindingsApplied = true;

  // Clipboard: set-clipboard on + terminal-features clipboard. See the
  // file header for why. With tmux mouse on, MouseDragEnd1Pane fires on
  // drag-select and triggers copy-pipe-and-cancel → OSC 52 → browser
  // clipboard via the xterm.js handler in TerminalView.tsx.
  try {
    execFileSync('tmux', ['set-option', '-g', 'set-clipboard', 'on'], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('tmux', ['set-option', '-as', 'terminal-features', '*:clipboard'], {
      stdio: 'ignore',
    });
  } catch {}
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    try {
      execFileSync(
        'tmux',
        ['bind-key', '-T', table, 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-pipe-and-cancel'],
        { stdio: 'ignore' },
      );
    } catch {}
  }

  // Scrollback shortcut: PageUp (no prefix) enters copy mode WITHOUT
  // auto-scrolling, so there's no jarring jump. The user sees a copy-mode
  // indicator in the status bar and can then use PageUp/PageDown (Fn+Up /
  // Fn+Down on MacBook) to page through history. q or Escape exits.
  //
  // Shift+Up was tested and doesn't reach tmux through ttyd/xterm.js —
  // the modifier gets swallowed on macOS. PageUp is the reliable path.
  try {
    execFileSync('tmux', ['bind-key', '-n', 'PageUp', 'copy-mode'], { stdio: 'ignore' });
  } catch {}
}

export interface CreateTmuxSessionOptions {
  /**
   * If set, the session's first process runs this command and then execs an
   * interactive shell, so the pane stays open after the command exits (a
   * resumed REPL, a long task launched from a deep link, etc.) instead of a
   * bare shell. The command runs via `<shell> -lc` inside the clean-env
   * wrapper (see CLEAN_ENV_SCRIPT), so it sees the same profile-built env a
   * normal tab's login shell gets.
   */
  initialCommand?: string;
}

/**
 * Allowlist of env vars a tab's shell may inherit. Everything else is
 * dropped by CLEAN_ENV_SCRIPT (`env -i`).
 *
 * Background: the tmux server captures the FULL environment of whichever
 * process first starts it — the omniterm server, which itself carries the
 * env of whatever shell launched omniterm — and stamps it on every session
 * forever (it even survives omniterm restarts). That leaked NODE_ENV,
 * PORT, npm_*, OMNITERM_* etc. into every tab and every app started there.
 * Instead of chasing offenders with a denylist (`env -u`), each pane now
 * starts from an empty env plus this allowlist, like a fresh terminal
 * window, and a login shell rebuilds PATH & friends from the profiles.
 *
 * - TERM/COLORTERM and TMUX/TMUX_PANE are set by tmux per pane and must
 *   survive the wipe — TMUX/TMUX_PANE keep in-pane `tmux` commands
 *   (split-window, rename-window, ...) and tmux-aware tools (prompt
 *   indicators, vim clipboard providers) working; they are per-pane tmux
 *   values, never a leak vector.
 * - SSH_AUTH_SOCK is preserved DELIBERATELY so ssh-agent forwarding keeps
 *   working when the omniterm host runs on a remote box.
 * - DISPLAY/WAYLAND_DISPLAY/XAUTHORITY/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS
 *   keep GUI launches working on Linux desktops, mirroring what a local
 *   terminal emulator would pass.
 * - OMNITERM_BROWSER_REGISTRY_URL/BROWSER/PATH are omniterm's own
 *   deliberate per-tab vars, stamped via `tmux -e` (see buildTabEnv); the
 *   wrapper lets them back through.
 */
export const CLEAN_ENV_VARS = [
  'TERM',
  'COLORTERM',
  'TMUX',
  'TMUX_PANE',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'SSH_AUTH_SOCK',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'OMNITERM_BROWSER_REGISTRY_URL',
  'BROWSER',
  'PATH',
];

/**
 * POSIX-sh wrapper that starts a pane's shell with a clean, allowlisted
 * environment. Invoked as `sh -c SCRIPT omniterm-clean-env <shell>
 * [<initialCommand>]`, so $1 is the shell and $2 the optional command.
 *
 * It collects the allowlisted vars that are actually set (printenv exits
 * non-zero for unset vars, which skips them — so e.g. an unset BROWSER
 * stays unset rather than becoming an empty string; printenv is not
 * strictly POSIX but universal on macOS/BSD/Linux, and the one fork per
 * allowlisted var per pane start is accepted — the login-profile pass
 * dominates), then execs the shell under `env -i` with only those. The
 * shell runs as a LOGIN shell so the user's profiles rebuild PATH etc.
 * from scratch — the same convention macOS terminal emulators use. With
 * initialCommand, `<shell> -lc` does the profile pass, runs the command,
 * then execs an interactive shell ($0 is set to the shell path) which
 * sources the rc files — together the same file set as an interactive
 * login shell, without a double profile pass. A newline (not `;`)
 * separates command and exec so a trailing `#` comment in the command
 * can't swallow the exec, and the blank line before the exec absorbs a
 * trailing-backslash line-continuation so it can't merge into the exec
 * line either.
 *
 * MUST NOT contain single quotes: buildDefaultCommand embeds it in a
 * single-quoted `sh -c` string for the tmux default-command option.
 */
export const CLEAN_ENV_SCRIPT = [
  'shell="$1"; cmd="$2"',
  'set --',
  `for v in ${CLEAN_ENV_VARS.join(' ')}; do`,
  '  if val=$(printenv "$v"); then set -- "$@" "$v=$val"; fi',
  'done',
  'if [ -n "$cmd" ]; then',
  '  exec env -i "$@" "$shell" -lc "$cmd',
  '',
  'exec \\"\\$0\\"" "$shell"',
  'else',
  '  exec env -i "$@" "$shell" -l',
  'fi',
].join('\n');

/**
 * The tmux `default-command` for omniterm sessions: new windows and split
 * panes created inside the session (tmux prefix-c / prefix-%) bypass the
 * argv built by buildNewSessionArgs, so without this they would inherit
 * the raw tmux-server env. Routing them through the same clean-env
 * wrapper keeps every pane in the session equally clean. tmux runs the
 * option value via `sh -c`, hence the single string with the shell path
 * single-quoted (POSIX '\'' escape) to survive spaces/metacharacters.
 */
export function buildDefaultCommand(shell: string): string {
  const quotedShell = `'${shell.replace(/'/g, `'\\''`)}'`;
  return `exec /bin/sh -c '${CLEAN_ENV_SCRIPT}' omniterm-clean-env ${quotedShell}`;
}

/**
 * Build the `tmux new-session` argv. Pure (no tmux calls) so the shape —
 * including the clean-env wrapper / initialCommand interplay — is
 * unit-testable.
 */
export function buildNewSessionArgs(
  name: string,
  shell: string,
  cwd?: string,
  env?: Record<string, string>,
  options?: CreateTmuxSessionOptions,
): string[] {
  const args = ['new-session', '-d', '-s', name];
  if (cwd) {
    const resolved = cwd === '~' ? homedir() : cwd;
    args.push('-c', resolved);
  }
  // `-e KEY=VALUE` sets environment variables on the new tmux session. Shells
  // launched inside this session (and every descendant) inherit these — which
  // is how we propagate OMNITERM_BROWSER_REGISTRY_URL to browser-driving commands
  // so their registered Chromiums land in the owning tab's registry. (They reach
  // the pane's shell because they're in CLEAN_ENV_VARS.)
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }
  }
  // Multiple argv words make tmux execvp the command directly (no extra
  // `sh -c` string-splitting pass), so SCRIPT, shell, and initialCommand
  // each arrive as one intact argument.
  args.push('sh', '-c', CLEAN_ENV_SCRIPT, 'omniterm-clean-env', shell);
  if (options?.initialCommand) {
    args.push(options.initialCommand);
  }
  return args;
}

export function createTmuxSession(
  name: string,
  cwd?: string,
  env?: Record<string, string>,
  options?: CreateTmuxSessionOptions,
): void {
  const shell = loadSettings().defaultShell || 'bash';
  execFileSync('tmux', buildNewSessionArgs(name, shell, cwd, env, options), { stdio: 'ignore' });

  const opts: [string, string][] = [
    // Tmux mouse is ON: wheel scroll enters copy-mode and walks scrollback
    // (the common need), and mouse-aware TUI apps (htop, lazygit, vim with
    // `set mouse=a`) receive events. Drag-select fires OSC 52 via
    // copy-pipe-and-cancel; the iframe wrapper's xterm.js OSC 52 handler
    // (see plugins/terminal/components/TerminalView.tsx) relays to the
    // browser clipboard, so Cmd-C / Ctrl-C is unnecessary — selection itself
    // copies, like in iTerm2 / Terminal.app.
    ['mouse', 'on'],
    // New windows / split panes go through the clean-env wrapper too —
    // without this they'd get the raw tmux-server env (see buildDefaultCommand).
    ['default-command', buildDefaultCommand(shell)],
    ['history-limit', '50000'],
    ['status-position', 'bottom'],
    ['base-index', '1'],
    ['renumber-windows', 'on'],
    ['escape-time', '0'],
    ['focus-events', 'on'],
  ];
  const batched: string[] = [];
  for (const [key, value] of opts) {
    if (batched.length > 0) batched.push(';');
    // `=name` forces an exact target match (see tmuxSessionExists) so options
    // never land on a different session that `name` is merely a prefix of. The
    // trailing `:` is required: commands that take a PANE target (set-option,
    // display-message — unlike has-session/kill-session) fail to resolve a
    // bare `=name` on tmux 3.6 ("no such session"), and this whole batch is
    // under a swallowing try/catch, so without it every option here is
    // silently skipped.
    batched.push('set-option', '-t', `=${name}:`, key, value);
  }
  try {
    execFileSync('tmux', batched, { stdio: 'ignore' });
  } catch {}
  ensureTmuxBindings();
}

export function killTmuxSession(name: string): void {
  try {
    // `=name` forces an exact target match (see tmuxSessionExists) so we never
    // kill a different live session that `name` is merely a prefix of — e.g. a
    // stale `foo` entry resolving to a running `foo-<ts>`.
    execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' });
  } catch {
    // Session may already be dead
  }
  try {
    unlinkSync(`/tmp/omniterm-silence-${name}`);
  } catch {
    // State file may already be gone
  }
}

export interface TmuxSessionInfo {
  name: string;
  cwd: string;
  created: string;
}

export function listTmuxSessions(): TmuxSessionInfo[] {
  try {
    // `session_path` is the cwd the session was *created* in — stable for
    // the life of the session. `pane_current_path` follows whichever pane
    // is currently focused, so a multi-window session that the user `cd`d
    // around in would drift (often to $HOME), making orphan-session
    // bucketing in the workspace panel misattribute everything to $HOME.
    const output = execFileSync(
      'tmux',
      ['list-sessions', '-F', '#{session_name}|||#{session_path}|||#{session_created}'],
      { encoding: 'utf-8' },
    ).trim();
    if (!output) return [];
    return output.split('\n').map((line) => {
      const [name, cwd, created] = line.split('|||');
      return { name, cwd: cwd || '~', created };
    });
  } catch {
    return [];
  }
}

/**
 * Whether a tmux `#{pane_title}` is worth showing over `#{pane_current_command}`.
 * A title is meaningful only when it's non-empty, isn't just the session name
 * (tmux's default), and isn't a bare command-ish token like `bash` or `node-1`
 * (matched by /^[a-zA-Z0-9-]+$/). Callers fall back to the current command when
 * this is false. Shared by the sync and async title readers so the rule can't
 * drift between them.
 */
export function isMeaningfulPaneTitle(name: string, title: string): boolean {
  return !!title && title !== name && !/^[a-zA-Z0-9-]+$/.test(title);
}

export function getTmuxPaneTitle(name: string): string {
  try {
    // `=name` forces an exact target match (see tmuxSessionExists) so we read
    // the title of this session, not one it is merely a prefix of. The
    // trailing `:` is required — display-message takes a pane target, and on
    // tmux 3.6 a bare `=name` resolves to nothing (empty expansions).
    const title = execFileSync('tmux', ['display-message', '-t', `=${name}:`, '-p', '#{pane_title}'], {
      encoding: 'utf-8',
    }).trim();
    if (isMeaningfulPaneTitle(name, title)) {
      return title;
    }
    const cmd = execFileSync(
      'tmux',
      ['display-message', '-t', `=${name}:`, '-p', '#{pane_current_command}'],
      { encoding: 'utf-8' },
    ).trim();
    return cmd;
  } catch {
    return '';
  }
}

export function tmuxSessionExists(name: string): boolean {
  try {
    // Prefix `=` forces an exact-name match. Without it, tmux target
    // resolution falls back to prefix/fnmatch, so has-session for `foo` would
    // spuriously succeed against an unrelated `foo-a1b2c3` session.
    execFileSync('tmux', ['has-session', '-t', `=${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
