/**
 * Single source of truth for file-language detection. Both server routes
 * (routes/fs.ts, routes/worktrees.ts) and the client grammar registry
 * (app/components/langExtensions.ts) key off the ids defined here;
 * lib/languages.test.ts fails if a new id is added without a client-side
 * grammar decision.
 */

export const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.json': 'json',
  '.md': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
};

const BASENAME_TO_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

/** All language ids detectLanguage can return, except the 'text' fallback. */
export const LANGUAGE_IDS: readonly string[] = [
  ...new Set([...Object.values(EXT_TO_LANG), ...Object.values(BASENAME_TO_LANG)]),
];

/**
 * Detect a language id from a lowercased extension (with dot) and basename;
 * 'text' when unknown. Takes strings rather than a path so the module stays
 * free of node imports and safe to bundle into the client.
 */
export function detectLanguage(ext: string, basename: string): string {
  return EXT_TO_LANG[ext] || BASENAME_TO_LANG[basename] || 'text';
}
