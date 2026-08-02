/**
 * Session sidecar store for the agent UI.
 *
 * Persists per-conversation metadata + raw SDK event log under
 * `<projectRoot>/.shiplight/agent-sessions/<id>.json`.
 *
 * The Claude Agent SDK already persists transcripts under
 * `~/.claude/projects/` for resume — this sidecar exists so the UI can
 * list past conversations for the current project and replay them
 * without coupling to the SDK's internal storage format.
 */

import * as fs from 'fs';
import * as path from 'path';

const SESSIONS_DIRNAME = path.join('.shiplight', 'agent-sessions');
const GITIGNORE_LINE = '.shiplight/';

export interface SessionEvent {
  /** Pass-through of the raw SDKMessage type so the UI can replay faithfully. */
  type: string;
  [key: string]: unknown;
}

export interface SessionRecord {
  id: string;
  /** Short title — derived from the first user message. */
  title: string;
  /** Project root where the session was created. */
  cwd: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** UUID assigned by the Claude Agent SDK — required for `resume`. */
  sdkSessionId?: string;
  /** Raw SDK events appended in order. */
  events: SessionEvent[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** First user message preview, truncated for the list view. */
  preview: string;
}

export class SessionStore {
  private readonly dir: string;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.dir = path.join(projectRoot, SESSIONS_DIRNAME);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  ensureGitignored(): void {
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      // No .gitignore yet — create one so the sidecar transcripts (which can
      // contain prompts and inlined file contents) aren't accidentally committed.
      fs.writeFileSync(gitignorePath, `${GITIGNORE_LINE}\n`);
      return;
    }
    const contents = fs.readFileSync(gitignorePath, 'utf-8');
    const lines = contents.split(/\r?\n/);
    const already = lines.some((l) => l.trim() === GITIGNORE_LINE || l.trim() === '.shiplight');
    if (already) return;
    const trailing = contents.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(gitignorePath, `${contents}${trailing}${GITIGNORE_LINE}\n`);
  }

  private filePath(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`invalid session id: ${id}`);
    }
    return path.join(this.dir, `${id}.json`);
  }

  list(): SessionSummary[] {
    if (!fs.existsSync(this.dir)) return [];
    const summaries: SessionSummary[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(
          fs.readFileSync(path.join(this.dir, name), 'utf-8'),
        ) as SessionRecord;
        summaries.push({
          id: record.id,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          preview: derivePreview(record),
        });
      } catch {
        // Skip corrupt files rather than failing the whole list.
      }
    }
    summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return summaries;
  }

  get(id: string): SessionRecord | null {
    const p = this.filePath(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SessionRecord;
  }

  create(id: string, firstMessage: string): SessionRecord {
    this.ensureDir();
    this.ensureGitignored();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      title: deriveTitle(firstMessage),
      cwd: this.projectRoot,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    fs.writeFileSync(this.filePath(id), JSON.stringify(record, null, 2));
    return record;
  }

  setSdkSessionId(localId: string, sdkSessionId: string): void {
    const record = this.get(localId);
    if (!record) return;
    record.sdkSessionId = sdkSessionId;
    fs.writeFileSync(this.filePath(localId), JSON.stringify(record, null, 2));
  }

  appendEvent(id: string, event: SessionEvent): void {
    const record = this.get(id);
    if (!record) throw new Error(`session not found: ${id}`);
    record.events.push(event);
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.filePath(id), JSON.stringify(record, null, 2));
  }

  delete(id: string): boolean {
    const p = this.filePath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }
}

export function deriveTitle(message: string): string {
  const cleaned = message.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 60) return cleaned || 'Untitled session';
  const cut = cleaned.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
}

function derivePreview(record: SessionRecord): string {
  for (const evt of record.events) {
    if (evt.type === 'user') {
      const message = (evt as { message?: { content?: unknown } }).message;
      const text = extractUserText(message?.content);
      if (text) return deriveTitle(text);
    }
  }
  return record.title;
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: string }).text;
      if (typeof t === 'string') return t;
    }
  }
  return '';
}
