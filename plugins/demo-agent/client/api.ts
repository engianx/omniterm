/**
 * Thin client for the agent plugin's per-instance REST + SSE endpoints.
 *
 * The SPA is served at `/agent/<id>/`, so all URLs here are RELATIVE — they
 * resolve under that prefix to the instance's routes (`/agent/<id>/api/...`).
 * The conversation id is the page prefix; the client never passes it explicitly.
 */

/**
 * Loose event type — mirrors @anthropic-ai/claude-agent-sdk's SDKMessage union
 * but kept untyped so the bundle needn't import the SDK types. The renderer
 * pattern-matches on `type`.
 */
export interface AgentEvent {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface AttachedFile {
  name: string;
  type: string;
  /** Base64-encoded content */
  data: string;
}

/** Replay state for this conversation on mount (empty for a fresh tab). */
export async function getRecord(): Promise<{ events: AgentEvent[]; cwd: string }> {
  const res = await fetch('api/record');
  if (!res.ok) return { events: [], cwd: '' };
  return res.json();
}

export interface StreamCallbacks {
  onEvent: (event: AgentEvent) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * POSTs the prompt and parses the SSE response inline. Returns an abort handle
 * so the caller can cancel mid-stream. We use `fetch` + manual SSE parsing
 * rather than EventSource (which can't POST a body).
 */
export function streamMessage(
  prompt: string,
  cb: StreamCallbacks,
  files?: AttachedFile[],
): { abort: () => void } {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch('api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...(files?.length ? { files } : {}) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        cb.onError(`request failed: ${res.status}`);
        return;
      }
      await pumpSse(res.body, (event, data) => {
        if (event === 'done') cb.onDone();
        else if (event === 'error') cb.onError((data as { message: string }).message);
        else cb.onEvent(data as AgentEvent);
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      cb.onError(err instanceof Error ? err.message : String(err));
    }
  })();

  return { abort: () => controller.abort() };
}

export interface WatchCallbacks {
  onActive: () => void;
  onEvent: (event: AgentEvent) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * Connects to GET api/watch?from=N and streams events for an ongoing turn.
 * Used when returning to a conversation that's still running. The server sends
 * a `status` frame first; if running, it replays from `from` then tails live.
 * Returns an abort function.
 */
export function watchSession(from: number, cb: WatchCallbacks): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`api/watch?from=${from}`, { signal: controller.signal });
      if (!res.ok || !res.body) return;
      await pumpSse(res.body, (event, data) => {
        if (event === 'status') {
          if ((data as { running: boolean }).running) cb.onActive();
        } else if (event === 'done') {
          cb.onDone();
        } else if (event === 'error') {
          cb.onError((data as { message: string }).message);
        } else {
          cb.onEvent(data as AgentEvent);
        }
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }
  })();

  return () => controller.abort();
}

export async function getCdpVersion(
  debugPort: number,
): Promise<{ webSocketDebuggerUrl?: string } | null> {
  const res = await fetch(`api/cdp-version/${debugPort}`);
  if (!res.ok) return null;
  return res.json();
}

/** Read a ReadableStream of SSE frames, invoking `dispatch(event, parsedData)`. */
async function pumpSse(
  body: ReadableStream<Uint8Array>,
  dispatch: (event: string, data: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let dataLine = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLine += line.slice(6);
      }
      if (!dataLine) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataLine);
      } catch {
        continue;
      }
      dispatch(event, parsed);
    }
  }
}
