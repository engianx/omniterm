/**
 * Quote a path for a POSIX shell (bash, zsh, sh) so it pastes as ONE word.
 * Plain paths stay readable; anything else is single-quoted, with embedded
 * single quotes written as `'\''`. Inside single quotes nothing is special —
 * not `$`, backticks, `!` history expansion in a paste, nor newlines.
 */
export function shellQuote(s: string): string {
  if (s === '') return "''";
  // Leading `~` would expand, `=` at the start is a zsh expansion: quote those.
  if (/^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What a path dropped onto a terminal types: the quoted path and a space, so
 *  several drops (or a following argument) stay separate words. */
export function pathDropText(absPath: string): string {
  return `${shellQuote(absPath)} `;
}
