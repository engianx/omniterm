export function shouldResetWorkspaceTabs(
  currentPath: string | null,
  nextPath: string | null,
): boolean {
  return currentPath !== nextPath;
}
