/**
 * Cross-area window events (CustomEvent on `window`). One place for the
 * names and detail shapes so the sidebar sections, status bar and plugin
 * integrations can talk without importing each other.
 */

export interface OmnitermEvents {
  /** Track the folder if needed and switch to it (page.tsx). */
  'omniterm:open-workspace': { path: string };
  /** Open a source tab, in diff mode when `diff` is set (files integration). */
  'omniterm:open-file': { path: string; diff?: 'worktree' | 'staged' };
  /** Show a file in the Files tree: expand its folders, scroll to it (files integration). */
  'omniterm:reveal-file': { path: string };
  /** New terminal tab in the active workspace, starting in `cwd` (terminal integration). */
  'omniterm:open-terminal': { cwd: string };
  /** The repo at `cwd` changed through the UI (stage/commit/checkout/...). */
  'omniterm:git-changed': { cwd: string };
  /** Open the sidebar on a section (page.tsx). */
  'omniterm:show-sidebar': { section: 'workspaces' | 'files' | 'changes' };
}

export type OmnitermEventName = keyof OmnitermEvents;

export function emit<K extends OmnitermEventName>(name: K, detail: OmnitermEvents[K]): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on<K extends OmnitermEventName>(
  name: K,
  handler: (detail: OmnitermEvents[K]) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<OmnitermEvents[K]>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
