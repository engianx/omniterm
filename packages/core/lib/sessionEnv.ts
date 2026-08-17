/**
 * Session environment configuration — spec 001.
 *
 * Two inputs widen the pane environment omniterm otherwise scrubs (see
 * CLEAN_ENV_VARS in plugins/terminal/lib/tmux.ts): a host-level list of
 * variable NAMES to let through, and a per-session map of VALUES on
 * create-session. Both funnel through the validation here so the two entry
 * points can never disagree about what a legal name is.
 *
 * Why validation is strict rather than forgiving: a name is interpolated,
 * unquoted, into the POSIX-sh wrapper that starts every pane — and that
 * wrapper is itself embedded in a single-quoted `sh -c` string stored as the
 * session's tmux `default-command`. A name carrying a quote, a space, or a
 * semicolon is therefore code execution in every pane that session ever opens.
 * Values are not interpolated anywhere (they travel as `tmux -e KEY=VALUE`
 * argv words, which tmux hands to execvp without a shell), which is why only
 * names need this treatment.
 */

/** POSIX-shaped environment variable name. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names omniterm needs for itself. TMUX/TMUX_PANE identify the pane to tmux;
 * a caller overriding them breaks pane targeting for every tmux-aware tool.
 */
const RESERVED_ENV_NAMES = new Set(['TMUX', 'TMUX_PANE']);

export class EnvNameError extends Error {
  /** The offending entry, verbatim, so callers can name it in their own error. */
  readonly envName: string;
  constructor(envName: string, message: string) {
    super(message);
    this.name = 'EnvNameError';
    this.envName = envName;
  }
}

export function isValidEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name) && !RESERVED_ENV_NAMES.has(name);
}

/** Throws {@link EnvNameError} with a message that says which rule was broken. */
export function assertValidEnvName(name: string): void {
  if (RESERVED_ENV_NAMES.has(name)) {
    throw new EnvNameError(name, `${name} is reserved by omniterm and cannot be overridden`);
  }
  if (!ENV_NAME_RE.test(name)) {
    throw new EnvNameError(
      name,
      `${JSON.stringify(name)} is not a valid environment variable name ` +
        '(letters, digits and underscore; must not start with a digit)',
    );
  }
}

/**
 * Parse a comma-separated passthrough list. Blank entries are dropped (so a
 * trailing comma is harmless), duplicates collapse to the first occurrence, and
 * order is preserved. Any invalid entry throws rather than being skipped: a
 * silently dropped name means terminals come up missing configuration the
 * operator believes they have.
 */
export function parseEnvPassthrough(raw: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of raw.split(',')) {
    const name = entry.trim();
    if (!name) continue;
    assertValidEnvName(name);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Parse repeated `--env-passthrough <list>` flags out of argv, in order, the
 * way `parsePluginSpecs` parses `--plugin`. Repeats accumulate and duplicates
 * collapse. Throws when the flag is given without a value (end of argv or
 * followed by another flag), or when any name is invalid.
 */
export function parseEnvPassthroughArgv(argv: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--env-passthrough') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new EnvNameError(
        '',
        '--env-passthrough requires a value (a comma-separated list of variable names)',
      );
    }
    for (const name of parseEnvPassthrough(value)) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    i++;
  }
  return names;
}

// Module state, written once during startServer before any route is mounted.
// A singleton rather than plumbing through five call sites, matching how
// loadSettings() is already reached from the tmux layer.
let passthrough: string[] = [];

/** Replace the host-level passthrough list. Names are validated by the caller's parse. */
export function setEnvPassthrough(names: string[]): void {
  for (const name of names) assertValidEnvName(name);
  passthrough = [...names];
}

export function getEnvPassthrough(): string[] {
  return passthrough;
}
