import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  type AgentEvent,
  type AttachedFile,
  getCdpVersion,
  getRecord,
  streamMessage,
  watchSession,
} from './api';

const DEFAULT_CDP_PORT = 9222;
const MAX_RETRIES = 5;

/** `/agent/<id>` — the page prefix used to build same-origin CDP proxy URLs. */
function pagePrefix(): string {
  return window.location.pathname.replace(/\/$/, '');
}

export function Session() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState('');
  const [browserPort, setBrowserPort] = useState<number | null>(null);
  const [panelWidth, setPanelWidth] = useState(() => Math.round((window.innerWidth * 2) / 3));
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const pendingNewSessionToolId = useRef<string | null>(null);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // On mount: load any persisted transcript, then tail an in-flight turn.
  useEffect(() => {
    let cancelled = false;
    let stopWatch: (() => void) | null = null;
    (async () => {
      try {
        const record = await getRecord();
        if (cancelled) return;
        setEvents(record.events);
        setCwd(record.cwd);
        stopWatch = watchSession(record.events.length, {
          onActive: () => {
            if (!cancelled) setStreaming(true);
          },
          onEvent: (evt) => {
            if (cancelled) return;
            extractDebugPort(evt);
            setEvents((prev) => [...prev, evt]);
          },
          onDone: () => {
            if (!cancelled) setStreaming(false);
            stopWatch = null;
          },
          onError: () => {
            if (!cancelled) setStreaming(false);
            stopWatch = null;
          },
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, streaming]);

  function extractDebugPort(event: AgentEvent): void {
    if (event.type === 'assistant') {
      const blocks: unknown[] = event.message?.content ?? [];
      for (const block of blocks) {
        const b = block as { type?: string; name?: string; id?: string };
        if (b.type === 'tool_use' && b.name === 'mcp__shiplight__new_session' && b.id) {
          pendingNewSessionToolId.current = b.id;
        }
      }
    }
    if (event.type === 'user') {
      const pendingId = pendingNewSessionToolId.current;
      if (!pendingId) return;
      const blocks: unknown[] = event.message?.content ?? [];
      for (const block of blocks) {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown };
        if (b.type === 'tool_result' && b.tool_use_id === pendingId) {
          pendingNewSessionToolId.current = null;
          const raw =
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? ((b.content as { type?: string; text?: string }[]).find((c) => c.type === 'text')
                    ?.text ?? '')
                : '';
          try {
            const parsed = JSON.parse(raw) as { debug_port?: number | null };
            setBrowserPort(parsed.debug_port ?? DEFAULT_CDP_PORT);
          } catch {
            setBrowserPort(DEFAULT_CDP_PORT);
          }
        }
      }
    }
  }

  function onPickFiles() {
    fileInputRef.current?.click();
  }

  function onFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList) return;
    Array.from(fileList).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const data = dataUrl.split(',')[1] ?? '';
        setAttachedFiles((prev) => [
          ...prev,
          { name: file.name, type: file.type || 'application/octet-stream', data },
        ]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  }

  function removeFile(index: number) {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function send(prompt: string, files: AttachedFile[]) {
    if (!prompt.trim() || streaming) return;
    setStreaming(true);
    setError(null);
    setEvents((prev) => [
      ...prev,
      { type: 'user', message: { role: 'user', content: prompt }, _optimistic: true },
    ]);
    const handle = streamMessage(
      prompt,
      {
        onEvent: (evt) => {
          extractDebugPort(evt);
          setEvents((prev) => [...prev, evt]);
        },
        onDone: () => {
          abortRef.current = null;
          setStreaming(false);
        },
        onError: (msg) => {
          abortRef.current = null;
          setStreaming(false);
          setError(msg);
        },
      },
      files.length ? files : undefined,
    );
    abortRef.current = handle.abort;
  }

  function onSubmit() {
    const files = attachedFiles;
    setInput('');
    setAttachedFiles([]);
    send(input, files);
  }

  function onStop() {
    abortRef.current?.();
    abortRef.current = null;
    setStreaming(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      dragStartX.current = e.clientX;
      dragStartWidth.current = panelWidth;
      e.preventDefault();
    },
    [panelWidth],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = dragStartX.current - e.clientX;
      setPanelWidth(
        Math.max(280, Math.min(window.innerWidth - 320, dragStartWidth.current + delta)),
      );
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const processed = useMemo(() => processEvents(events), [events]);

  return (
    <div className={`app${browserPort ? ' split' : ''}`}>
      <header className="header">
        <h1>Demo Agent</h1>
        {cwd && <span className="cwd">{cwd}</span>}
      </header>

      <div className="split-body">
        <div className="session">
          <div className="transcript" ref={transcriptRef}>
            {processed.map((msg, i) => (
              <MessageRow key={i} msg={msg} />
            ))}
            {streaming && (
              <div className="msg-assistant">
                <div className="streaming-bubble">
                  <div className="streaming-dot" />
                  <div className="streaming-dot" />
                  <div className="streaming-dot" />
                </div>
              </div>
            )}
          </div>

          <div className="composer-wrap">
            {error && <div className="error-banner">{error}</div>}
            <div className="composer">
              {attachedFiles.length > 0 && (
                <div className="attachments">
                  {attachedFiles.map((f, i) => (
                    <div key={i} className="attachment">
                      {f.type.startsWith('image/') ? (
                        <img
                          className="attachment-thumb"
                          src={`data:${f.type};base64,${f.data}`}
                          alt={f.name}
                        />
                      ) : (
                        <span className="attachment-icon">📄</span>
                      )}
                      <span className="attachment-name" title={f.name}>
                        {f.name}
                      </span>
                      <button
                        className="attachment-remove"
                        onClick={() => removeFile(i)}
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={streaming ? 'Agent is thinking…' : 'Reply…'}
                rows={2}
                disabled={streaming}
              />
              <div className="composer-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="file-input-hidden"
                  onChange={onFilesSelected}
                  accept="image/*,text/*,application/pdf,.json,.yaml,.yml,.md,.csv,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h"
                />
                <button
                  className="attach-btn"
                  onClick={onPickFiles}
                  disabled={streaming}
                  title="Attach files"
                >
                  ＋
                </button>
                {streaming ? (
                  <button className="stop-btn" onClick={onStop}>
                    Stop
                  </button>
                ) : (
                  <button className="send-btn" onClick={onSubmit} disabled={!input.trim()}>
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {browserPort && (
          <>
            <div className="divider" onMouseDown={onDividerMouseDown} />
            <BrowserPanel
              debugPort={browserPort}
              width={panelWidth}
              onClose={() => setBrowserPort(null)}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrowserPanel — live view of the agent's headless browser via CDP.
//
// CDP is proxied through the host at `<prefix>/ws/cdp/<port>/...` (see cdp.ts);
// each page is rendered with the host's vendored DevTools frontend served at
// `/devtools/`. URLs are same-origin and prefix-relative so the panel works
// inside the `/agent/<id>/` iframe regardless of host/port.
// ---------------------------------------------------------------------------

interface PageTarget {
  targetId: string;
  url: string;
  title: string;
}
interface BrowserPanelProps {
  debugPort: number;
  width: number;
  onClose: () => void;
}

function BrowserPanel({ debugPort, width, onClose }: BrowserPanelProps) {
  const [pages, setPages] = useState<PageTarget[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const cancelledRef = useRef(false);
  const prefix = pagePrefix();
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const cdpBase = `${prefix}/ws/cdp/${debugPort}`;

  useEffect(() => {
    cancelledRef.current = false;
    retryRef.current = 0;
    const connect = async () => {
      if (cancelledRef.current) return;
      try {
        const version = await getCdpVersion(debugPort);
        if (cancelledRef.current) return;
        if (!version?.webSocketDebuggerUrl) {
          scheduleRetry();
          return;
        }
        const cdpPath = new URL(version.webSocketDebuggerUrl.replace(/^ws/, 'http')).pathname;
        const proxyUrl = `${wsProto}://${window.location.host}${cdpBase}${cdpPath}`;
        const ws = new WebSocket(proxyUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          retryRef.current = 0;
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Target.setDiscoverTargets',
              params: { discover: true },
            }),
          );
        };
        ws.onmessage = (ev) => {
          let msg: { method?: string; params?: Record<string, unknown> };
          try {
            msg = JSON.parse(ev.data as string);
          } catch {
            return;
          }
          if (msg.method === 'Target.targetCreated') {
            const t = msg.params?.targetInfo as
              | { targetId: string; url: string; title: string; type: string }
              | undefined;
            if (t?.type === 'page') {
              setPages((prev) => {
                if (prev.some((p) => p.targetId === t.targetId)) return prev;
                const next = [
                  ...prev,
                  { targetId: t.targetId, url: t.url, title: t.title || 'Untitled' },
                ];
                setActiveTab(t.targetId);
                return next;
              });
            }
          } else if (msg.method === 'Target.targetInfoChanged') {
            const t = msg.params?.targetInfo as
              | { targetId: string; url: string; title: string; type: string }
              | undefined;
            if (t?.type === 'page') {
              setPages((prev) =>
                prev.map((p) =>
                  p.targetId === t.targetId ? { ...p, url: t.url, title: t.title || p.title } : p,
                ),
              );
            }
          } else if (msg.method === 'Target.targetDestroyed') {
            const targetId = msg.params?.targetId as string | undefined;
            if (!targetId) return;
            setPages((prev) => {
              const next = prev.filter((p) => p.targetId !== targetId);
              setActiveTab((cur) => (cur === targetId ? (next[0]?.targetId ?? null) : cur));
              return next;
            });
          }
        };
        ws.onclose = () => {
          if (!cancelledRef.current) scheduleRetry();
        };
        ws.onerror = () => {};
      } catch {
        if (!cancelledRef.current) scheduleRetry();
      }
    };
    const scheduleRetry = () => {
      if (cancelledRef.current) return;
      if (retryRef.current >= MAX_RETRIES) {
        onClose();
        return;
      }
      const delay = Math.min(1000 * 2 ** retryRef.current, 10000);
      retryRef.current++;
      setTimeout(connect, delay);
    };
    connect();
    return () => {
      cancelledRef.current = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugPort]);

  const devtoolsUrl = useCallback(
    (targetId: string) => {
      const wsEndpoint = `${window.location.host}${cdpBase}/devtools/page/${targetId}`;
      return `/devtools/inspector.html?ws=${encodeURIComponent(wsEndpoint)}`;
    },
    [cdpBase],
  );

  return (
    <div className="browser-panel" style={{ width }}>
      <div className="browser-panel-tabs">
        {pages.map((p) => (
          <button
            key={p.targetId}
            className={`browser-tab${p.targetId === activeTab ? ' active' : ''}`}
            onClick={() => setActiveTab(p.targetId)}
            title={p.url}
          >
            {p.title || p.url || 'Untitled'}
          </button>
        ))}
        {pages.length === 0 && <span className="browser-tab-placeholder">Connecting…</span>}
      </div>
      <div className="browser-panel-body">
        {pages.map((p) => (
          <iframe
            key={p.targetId}
            src={devtoolsUrl(p.targetId)}
            className="browser-iframe"
            title={p.title || p.url}
            style={{ display: p.targetId === activeTab ? 'block' : 'none' }}
          />
        ))}
        {pages.length === 0 && <div className="browser-panel-waiting">Waiting for browser…</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event processing — correlate tool_use with tool_result
// ---------------------------------------------------------------------------

interface RichTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

type MsgGroup = { kind: 'text'; text: string } | { kind: 'tools'; tools: RichTool[] };

type ProcessedMsg = { kind: 'user'; text: string } | { kind: 'assistant'; groups: MsgGroup[] };

function processEvents(events: AgentEvent[]): ProcessedMsg[] {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const evt of events) {
    if (evt.type !== 'user') continue;
    const blocks: unknown[] = evt.message?.content ?? [];
    for (const block of blocks) {
      const b = block as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (b.type === 'tool_result' && b.tool_use_id) {
        const content =
          typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? (b.content as { type?: string; text?: string }[])
                  .filter((c) => c.type === 'text')
                  .map((c) => c.text ?? '')
                  .join('\n')
              : '';
        results.set(b.tool_use_id, { content, isError: b.is_error === true });
      }
    }
  }

  const out: ProcessedMsg[] = [];

  for (const evt of events) {
    if (
      evt.type === 'system' ||
      evt.type === 'stream_event' ||
      evt.type === 'tool_progress' ||
      evt.type === 'auth_status' ||
      evt.type === 'result'
    )
      continue;

    if (evt.type === 'user') {
      if (isSyntheticUserEvent(evt)) continue;
      const text = extractText(evt.message?.content);
      if (text) out.push({ kind: 'user', text });
      continue;
    }

    if (evt.type === 'assistant') {
      const blocks: unknown[] = evt.message?.content ?? [];
      if (!blocks.length) continue;

      const groups: MsgGroup[] = [];
      let currentTools: RichTool[] = [];

      const flushTools = () => {
        if (currentTools.length) {
          groups.push({ kind: 'tools', tools: currentTools });
          currentTools = [];
        }
      };

      for (const block of blocks) {
        const b = block as {
          type?: string;
          text?: string;
          name?: string;
          id?: string;
          input?: unknown;
        };
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          flushTools();
          groups.push({ kind: 'text', text: b.text });
        } else if (b.type === 'tool_use' && b.name && b.id) {
          const res = results.get(b.id);
          currentTools.push({
            id: b.id,
            name: b.name,
            input: (b.input as Record<string, unknown>) ?? {},
            result: res?.content,
            isError: res?.isError,
          });
        }
      }

      flushTools();
      if (groups.length) out.push({ kind: 'assistant', groups });
    }
  }

  return out;
}

function isSyntheticUserEvent(evt: AgentEvent): boolean {
  return evt.type === 'user' && evt.isSynthetic === true;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text')
    .map((c) => (c as { text?: string }).text ?? '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function MessageRow({ msg }: { msg: ProcessedMsg }) {
  if (msg.kind === 'user') {
    return (
      <div className="msg-user">
        <div className="msg-user-inner">{msg.text}</div>
      </div>
    );
  }

  return (
    <div className="msg-assistant">
      <div className="msg-assistant-inner">
        {msg.groups.map((group, i) => {
          if (group.kind === 'text') {
            return (
              <div key={i} className="text-block">
                <ReactMarkdown>{group.text}</ReactMarkdown>
              </div>
            );
          }
          return <ToolGroup key={i} tools={group.tools} />;
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool badge row
// ---------------------------------------------------------------------------

function ToolGroup({ tools }: { tools: RichTool[] }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((v) => !v);

  return (
    <div>
      <div className="badge-row">
        {tools.map((tool) => (
          <button
            key={tool.id}
            className={`badge-pill ${getBadgeClass(tool.name)}`}
            onClick={toggle}
          >
            {getToolIcon(tool.name)} {getSmartLabel(tool)}
            <span style={{ marginLeft: 2, opacity: 0.7, fontSize: 9 }}>{expanded ? '▲' : '▼'}</span>
          </button>
        ))}
      </div>
      {expanded && (
        <div className="expanded-tools">
          {tools.map((tool) => (
            <ToolDetail key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolDetail({ tool }: { tool: RichTool }) {
  return (
    <div className="tool-detail-item">
      <div className="tool-detail-header">{tool.name}</div>
      {renderToolInput(tool.name, tool.input)}
      {tool.result != null && (
        <pre className={`tool-detail-code result${tool.isError ? ' error' : ''}`}>
          {tool.result}
        </pre>
      )}
    </div>
  );
}

function renderToolInput(name: string, inp: Record<string, unknown>): React.ReactNode {
  switch (name) {
    case 'Bash': {
      const cmd = inp.command as string | undefined;
      const desc = inp.description as string | undefined;
      return (
        <pre className="tool-detail-code">
          {desc ? `# ${desc}\n` : ''}$ {cmd ?? ''}
        </pre>
      );
    }
    case 'Read':
    case 'Write':
    case 'Edit': {
      const p = inp.file_path as string | undefined;
      const content = inp.new_string ?? inp.content;
      return (
        <>
          {p && <pre className="tool-detail-code">{p}</pre>}
          {content != null && (
            <pre className="tool-detail-code">
              {String(content).slice(0, 600)}
              {String(content).length > 600 ? '\n…' : ''}
            </pre>
          )}
        </>
      );
    }
    case 'Grep': {
      const pattern = inp.pattern as string | undefined;
      const p = inp.path as string | undefined;
      return (
        <pre className="tool-detail-code">{`pattern: ${pattern ?? ''}${p ? `\npath: ${p}` : ''}`}</pre>
      );
    }
    case 'Glob': {
      const pattern = inp.pattern as string | undefined;
      return <pre className="tool-detail-code">{`glob: ${pattern ?? ''}`}</pre>;
    }
    case 'WebFetch':
    case 'WebSearch': {
      const val = (inp.url ?? inp.query) as string | undefined;
      return <pre className="tool-detail-code">{val ?? ''}</pre>;
    }
    default: {
      const json = JSON.stringify(inp, null, 2);
      if (json === '{}') return null;
      return (
        <pre className="tool-detail-code">
          {json.slice(0, 800)}
          {json.length > 800 ? '\n…' : ''}
        </pre>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

function getBadgeClass(name: string): string {
  const n = name.replace(/^mcp__\w+__/, '');
  if (/^(Read|Write|Edit|NotebookEdit)$/.test(n)) return 'badge-file';
  if (/^(Bash|BashOutput|KillShell)$/.test(n)) return 'badge-bash';
  if (/^(Grep|Glob|WebSearch)$/.test(n)) return 'badge-search';
  if (/^(WebFetch)$/.test(n)) return 'badge-web';
  if (/^(Task|TaskCreate|TaskUpdate|TodoWrite)$/.test(n)) return 'badge-task';
  if (/^(Skill)$/.test(n)) return 'badge-skill';
  if (name.startsWith('mcp__')) return 'badge-mcp';
  return 'badge-default';
}

function getToolIcon(name: string): string {
  const n = name.replace(/^mcp__\w+__/, '');
  if (n === 'Read') return '↓';
  if (n === 'Write') return '✎';
  if (n === 'Edit') return '✏';
  if (n === 'Bash' || n === 'BashOutput') return '$';
  if (n === 'KillShell') return '✕';
  if (n === 'Grep') return '⌕';
  if (n === 'Glob') return '◈';
  if (n === 'WebSearch') return '⊕';
  if (n === 'WebFetch') return '↗';
  if (n === 'Task' || n === 'TaskCreate' || n === 'TaskUpdate') return '⚡';
  if (n === 'TodoWrite') return '☑';
  if (n === 'Skill') return '✦';
  if (name.startsWith('mcp__')) return '⬡';
  return '◇';
}

function getSmartLabel(tool: RichTool): string {
  const inp = tool.input;
  const n = tool.name.replace(/^mcp__\w+__/, '');
  const trunc = (s: string, max = 22) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

  switch (n) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const p = inp.file_path as string | undefined;
      return p ? trunc(p.split('/').pop() ?? p) : n;
    }
    case 'Bash':
    case 'BashOutput': {
      const desc = inp.description as string | undefined;
      const cmd = inp.command as string | undefined;
      if (desc) return trunc(desc);
      if (cmd) return trunc(cmd.split(' ')[0] ?? '');
      return 'Run';
    }
    case 'KillShell':
      return 'Kill shell';
    case 'Grep': {
      const p = inp.pattern as string | undefined;
      return p ? `Search "${trunc(p, 14)}"` : 'Search';
    }
    case 'Glob': {
      const p = inp.pattern as string | undefined;
      return p ? trunc(p, 18) : 'Find';
    }
    case 'WebFetch': {
      const url = inp.url as string | undefined;
      try {
        return url ? trunc(new URL(url).hostname) : 'Fetch';
      } catch {
        return url ? trunc(url) : 'Fetch';
      }
    }
    case 'WebSearch': {
      const q = inp.query as string | undefined;
      return q ? trunc(q, 20) : 'Search';
    }
    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate': {
      const desc = (inp.description ?? inp.title) as string | undefined;
      return desc ? trunc(desc, 20) : n;
    }
    case 'TodoWrite': {
      const todos = inp.todos as Array<{ status?: string }> | undefined;
      if (todos?.length) {
        const done = todos.filter((t) => t.status === 'completed').length;
        return `Todos ${done}/${todos.length}`;
      }
      return 'Todos';
    }
    case 'Skill': {
      const s = inp.skill as string | undefined;
      return s ? `Skill(${s})` : 'Skill';
    }
    case 'NotebookEdit':
      return 'Edit notebook';
    default:
      return tool.name.startsWith('mcp__') ? trunc(tool.name.replace(/^mcp__\w+__/, '')) : trunc(n);
  }
}
