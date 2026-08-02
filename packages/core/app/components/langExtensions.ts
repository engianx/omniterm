import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

/**
 * Language ids from lib/languages.ts that deliberately render as plain text:
 * CodeMirror has no official or legacy-mode grammar for them. Removing an id
 * from this set without adding a loader below fails lib/languages.test.ts.
 */
export const NO_GRAMMAR_LANGUAGE_IDS: ReadonlySet<string> = new Set([
  'graphql', // cm6-graphql exists but is a community package; not worth the dep until requested
  'hcl',
  'makefile',
]);

/**
 * Each loader dynamically `import()`s its grammar so Vite code-splits every
 * `@codemirror/lang-*` (and legacy mode) into its own chunk. The chunks ship
 * inside the package and are served by the host, but the browser only fetches
 * the grammar for a language the moment a file of that type is first opened —
 * so the initial bundle carries none of them. `@codemirror/language`
 * (StreamLanguage) is already pulled in by the editor's basicSetup, so
 * importing it eagerly here costs nothing extra.
 */
// Loaders shared by more than one id, so an alias (e.g. jsx → javascript) can't
// drift from its base.
const js = async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
const ts = async () =>
  (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
const cssLoader = async () => (await import('@codemirror/lang-css')).css();
const cppLoader = async () => (await import('@codemirror/lang-cpp')).cpp();

const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  javascript: js,
  jsx: js,
  typescript: ts,
  tsx: ts,
  python: async () => (await import('@codemirror/lang-python')).python(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  css: cssLoader,
  scss: cssLoader,
  html: async () => (await import('@codemirror/lang-html')).html(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  c: cppLoader,
  cpp: cppLoader,
  toml: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml),
  ruby: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  bash: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
  dockerfile: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
};

/** Whether a language id maps to a grammar (synchronous; no chunk is fetched). */
export function hasGrammar(lang: string): boolean {
  return lang in LANG_LOADERS;
}

// Memoize the in-flight/resolved load per language so repeat opens (and
// concurrent ones) share one chunk fetch and one extension instance instead of
// re-importing on every editor mount. A rejected load is evicted so a transient
// chunk-fetch failure can be retried on the next open rather than caching the error.
const extensionCache = new Map<string, Promise<Extension>>();

/**
 * Resolve the CodeMirror extension for a language id, fetching its grammar
 * chunk on demand. Returns `[]` (plain text) for ids with no grammar.
 */
export function loadLangExtension(lang: string): Promise<Extension> {
  const loader = LANG_LOADERS[lang];
  if (!loader) return Promise.resolve([]);
  let pending = extensionCache.get(lang);
  if (!pending) {
    pending = loader().catch((err) => {
      extensionCache.delete(lang);
      throw err;
    });
    extensionCache.set(lang, pending);
  }
  return pending;
}
