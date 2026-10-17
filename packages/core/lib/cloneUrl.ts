// Pure (no Node imports): shared by the clone route and the client's Open
// picker, which shows the same default destination the server would pick.

/**
 * The directory name `git clone` would choose for a URL: its last path
 * segment minus `.git`. Handles scp-style `git@host:owner/repo.git` and bare
 * `git@host:repo` as well as URLs and local paths.
 */
export function cloneSlug(url: string): string {
  const slug = url
    .trim()
    .replace(/[/\\]+$/, '')
    .match(/([^/:\\]+?)(\.git)?$/)?.[1];
  return slug && slug !== '.' && slug !== '..' ? slug : 'repo';
}

/** Where a clone lands when the user doesn't pick a destination. */
export function defaultCloneDestination(url: string, home: string = '~'): string {
  return `${home.replace(/\/+$/, '')}/git/${cloneSlug(url)}`;
}
