/**
 * Thin wrapper around the Claude Agent SDK for the agent web UI.
 *
 * One AgentSession per logical conversation. The first turn boots a new
 * session and captures its assigned id from the SDK; subsequent turns
 * pass `resume: <sessionId>` so the SDK loads prior context from its
 * own persistence under ~/.claude/projects/.
 *
 * Each turn is a fresh `query()` call; we do not hold a long-lived
 * streaming-input Query open between user messages.
 */

import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type Options,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { SessionStore, type SessionEvent } from './sessionStore.js';

export interface AttachedFile {
  name: string;
  /** MIME type, e.g. "image/png" or "text/plain" */
  type: string;
  /** Base64-encoded file content */
  data: string;
}

export interface AgentSessionOptions {
  projectRoot: string;
  sidecarId?: string;
  resumeId?: string;
}

export interface RunTurnArgs {
  prompt: string;
  files?: AttachedFile[];
  onEvent: (event: SDKMessage) => void;
  signal?: AbortSignal;
}

export class AgentSession {
  readonly projectRoot: string;
  readonly localId: string;
  sdkSessionId: string | null;
  private store: SessionStore;

  constructor(opts: AgentSessionOptions) {
    this.projectRoot = opts.projectRoot;
    this.store = new SessionStore(opts.projectRoot);
    this.sdkSessionId = opts.resumeId ?? null;
    this.localId = opts.sidecarId ?? `s-${randomUUID()}`;
  }

  async runTurn(args: RunTurnArgs): Promise<void> {
    const { prompt, files, onEvent, signal } = args;

    // Create the sidecar record on the very first turn only. Keyed off the
    // record's existence (not a mutable flag) so a turn that throws/aborts
    // before completing can't leave us thinking the next turn is "first" and
    // re-`create()` — which would overwrite the record's events with [].
    if (!this.store.get(this.localId)) {
      this.store.create(this.localId, prompt);
    }

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort());
    }

    const userEvent: SessionEvent = {
      type: 'user',
      message: { role: 'user', content: buildSidecarContent(prompt, files) },
      session_id: this.sdkSessionId ?? this.localId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      _source: 'ui',
    };
    this.store.appendEvent(this.localId, userEvent);

    const sdkPrompt = files?.length
      ? buildUserMessageIterable(prompt, files, this.sdkSessionId ?? '')
      : prompt;

    const options: Options = {
      cwd: this.projectRoot,
      model: process.env.AGENT_MODEL || 'claude-sonnet-4-6',
      abortController,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],
      mcpServers: {
        // Headless browser; the plugin reads the debug port from the MCP's
        // new_session tool result and proxies its CDP directly (no registry).
        shiplight: {
          command: 'npx',
          args: ['-y', '@shiplightai/mcp@latest'],
          env: {
            PWDEBUG: 'console',
            PLAYWRIGHT_HEADED: 'false',
          },
        },
      },
      debug: process.env.AGENT_DEBUG === 'true',
      stderr: (data) => process.stderr.write(`[agent-sdk] ${data}`),
      ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
    };

    const q = await query({ prompt: sdkPrompt, options });

    for await (const message of q) {
      if (this.sdkSessionId === null && (message as SDKMessage).session_id) {
        this.sdkSessionId = (message as SDKMessage).session_id ?? null;
        this.store.setSdkSessionId(this.localId, this.sdkSessionId as string);
      }
      this.store.appendEvent(this.localId, message as SessionEvent);
      onEvent(message);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

function buildContentBlocks(prompt: string, files: AttachedFile[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (prompt.trim()) {
    blocks.push({ type: 'text', text: prompt });
  }

  for (const file of files) {
    if (file.type.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: file.type, data: file.data },
      });
    } else {
      const text = Buffer.from(file.data, 'base64').toString('utf-8');
      blocks.push({ type: 'text', text: `[${file.name}]\n${text}` });
    }
  }

  return blocks;
}

function buildSidecarContent(
  prompt: string,
  files: AttachedFile[] | undefined,
): string | { type: string; text?: string; name?: string }[] {
  if (!files?.length) return prompt;
  const parts: { type: string; text?: string; name?: string }[] = [];
  if (prompt.trim()) parts.push({ type: 'text', text: prompt });
  for (const f of files) parts.push({ type: 'file_ref', name: f.name });
  return parts;
}

async function* buildUserMessageIterable(
  prompt: string,
  files: AttachedFile[],
  sessionId: string,
): AsyncIterable<SDKUserMessage> {
  const content = buildContentBlocks(prompt, files);
  const msg: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: content as unknown as string },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
  yield msg;
}
