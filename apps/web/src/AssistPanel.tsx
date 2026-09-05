/**
 * AI Assist (web) — a Claude-style chat in the editor's right sidebar. Talks to
 * the server's streaming /ai/chat/stream, grounds each turn in the current note,
 * and lets the user drop any reply straight into the document. Shown only when
 * /ai/status reports a provider.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createRenderer, CALLOUT_KINDS, calloutIconSvg, type CalloutKind } from "@selfnote/editor";
import { api, type AiProposal, type AiStatus, type ChatMessage, type ExtraDoc } from "./api";
import { ContextPicker, type SelectedNote } from "./ContextPicker";
import { Icon } from "./Icon";

/** Per-note context budget, mirroring the server's MAX_CONTEXT_CHARS. */
const MAX_CONTEXT_CHARS = 24_000;

/**
 * The assistant wraps note-ready content between `<!--insert-->` / `<!--/insert-->`
 * so "Insert into note" grabs just the deliverable, not the surrounding chat.
 */
function extractInsertable(md: string): string {
  const re = /<!--\s*insert\s*-->([\s\S]*?)<!--\s*\/\s*insert\s*-->/gi;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) parts.push(m[1].trim());
  return parts.length ? parts.join("\n\n") : md.trim();
}

/** Hide the insert markers when rendering the reply in the chat. */
function stripInsertMarkers(md: string): string {
  return md
    .replace(/<!--\s*\/?\s*insert\s*-->/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Minimal structural view of the BlockNote editor we need. */
export interface AiEditor {
  document: unknown[];
  blocksToMarkdownLossy: (blocks?: unknown[]) => Promise<string>;
  tryParseMarkdownToBlocks: (markdown: string) => Promise<unknown[]>;
  insertBlocks: (blocks: unknown[], referenceBlock: unknown, placement: "before" | "after") => void;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: boolean;
}

/** Openers shown on an empty thread. `send` fires immediately; otherwise we
 *  prefill the composer so the user can finish the thought. */
const SUGGESTIONS: { label: string; prompt: string; send?: boolean }[] = [
  { label: "Continue writing", prompt: "Continue writing this note from where it leaves off.", send: true },
  { label: "Summarize this page", prompt: "Summarize this note as a few concise bullet points.", send: true },
  { label: "Give me ideas about…", prompt: "Give me ideas about " },
  { label: "Draft an outline", prompt: "Draft an outline for this note.", send: true },
  { label: "Improve the writing", prompt: "Improve the writing in this note — clearer and tighter, same meaning.", send: true },
];

/** Kind of a leading `[!kind]` GitHub-alert marker in text, else null. */
function markerKind(text: string): CalloutKind | null {
  const m = /^\s*\[!(\w+)\]/i.exec(text);
  if (!m) return null;
  const k = m[1].toLowerCase();
  return (CALLOUT_KINDS as readonly string[]).includes(k) ? (k as CalloutKind) : null;
}

/** Collect the plain text of a React node tree (for marker detection). */
function nodeText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? nodeText(props.children) : "";
}

/**
 * Render `> [!kind]` alert blockquotes as styled callouts (reusing the editor's
 * `.callout` CSS), leaving ordinary blockquotes untouched. The marker line is
 * stripped and the remaining content shown inside the callout body.
 */
const mdComponents: Components = {
  blockquote({ children }) {
    const kind = markerKind(nodeText(children));
    if (!kind) return <blockquote>{children}</blockquote>;
    return (
      <div className={`callout callout-${kind}`} data-kind={kind}>
        <span
          className="callout-icon-wrap"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: calloutIconSvg(kind, 18) }}
        />
        <div className="callout-body">
          <CalloutBody>{children}</CalloutBody>
        </div>
      </div>
    );
  },
};

/**
 * Render a callout blockquote's children, dropping the leading `[!kind]` marker.
 * The marker may be its own paragraph (`> [!NOTE]\n> body`) — in which case we
 * drop that whole node — or lead the first paragraph inline, which we trim.
 */
function CalloutBody({ children }: { children: React.ReactNode }) {
  const arr = (Array.isArray(children) ? children : [children]).filter(
    (c) => !(typeof c === "string" && c.trim() === ""),
  );
  const first = arr[0];
  const firstText = nodeText(first).trim();
  if (/^\[!\w+\]$/i.test(firstText)) {
    // The marker sits alone in the first paragraph — drop it entirely.
    return <>{arr.slice(1)}</>;
  }
  if (typeof first === "string") {
    // Marker leads a plain-text first child — trim it off.
    const rest = arr.slice(1);
    return <>{[first.replace(/^\s*\[!\w+\]\s*/i, ""), ...rest]}</>;
  }
  // Marker leads a rich first paragraph: render everything (marker shows inline).
  return <>{arr}</>;
}

export function AssistPanel({
  editor,
  status,
  docId,
  workspaceId,
  onClose,
  onStaged,
}: {
  editor: AiEditor | null;
  status: AiStatus;
  docId: string;
  workspaceId: string;
  onClose: () => void;
  /** Called with a freshly-staged proposal so the parent can open the diff gate. */
  onStaged: (proposal: AiProposal) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState<SelectedNote[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // One headless Yjs→Markdown renderer, reused across sends.
  const renderer = useMemo(() => createRenderer(), []);

  // Chips are scoped per doc for the session: reset when the note changes.
  useEffect(() => {
    setContext([]);
    setMessages([]);
  }, [docId]);

  // Keep the newest message in view as it streams.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;

    const history = messages.filter((m) => !m.error);
    const next: Msg[] = [
      ...history,
      { role: "user", content },
      { role: "assistant", content: "", streaming: true },
    ];
    const asstIndex = next.length - 1;
    setMessages(next);
    setInput("");
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let noteContext = "";
    try {
      noteContext = editor ? await editor.blocksToMarkdownLossy(editor.document) : "";
    } catch {
      /* editor not ready — send without context */
    }

    // Resolve each selected note's body to Markdown (headless Yjs render) and
    // fold in as extra_docs. Cap at 6 notes and truncate each to the budget;
    // notes that fail to load are skipped rather than failing the whole turn.
    const extra_docs: ExtraDoc[] = [];
    for (const note of context.slice(0, 6)) {
      try {
        const { updates } = await api.getContent(note.id);
        const text = (await renderer.fromUpdatesBase64(updates)).slice(0, MAX_CONTEXT_CHARS);
        extra_docs.push({ doc_id: note.id, title: note.title, text, source: note.source });
      } catch {
        /* skip a note we couldn't render */
      }
    }

    const wire: ChatMessage[] = next
      .slice(0, asstIndex)
      .map((m) => ({ role: m.role, content: m.content }));

    const patchAsst = (fn: (m: Msg) => Msg) =>
      setMessages((prev) => {
        const copy = prev.slice();
        const m = copy[asstIndex];
        if (m) copy[asstIndex] = fn(m);
        return copy;
      });

    try {
      await api.aiChatStream(
        {
          doc_id: docId,
          messages: wire,
          context: noteContext,
          ...(extra_docs.length ? { extra_docs } : {}),
        },
        {
          signal: controller.signal,
          onDelta: (d) => patchAsst((m) => ({ ...m, content: m.content + d })),
          onError: (msg) => patchAsst(() => ({ role: "assistant", content: msg, error: true })),
        },
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        patchAsst(() => ({
          role: "assistant",
          content: e instanceof Error ? e.message.slice(0, 200) : "Assist failed.",
          error: true,
        }));
      }
    } finally {
      patchAsst((m) => ({ ...m, streaming: false }));
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  // Staging an in-app insertion goes through the same proposal → accept/reject
  // gate as a remote MCP write: create a `pending` proposal and hand it to the
  // parent, which opens the diff preview.
  const [staging, setStaging] = useState<number | null>(null);
  const insertIntoNote = async (content: string, index: number) => {
    if (staging != null) return;
    setStaging(index);
    try {
      const proposal = await api.createAiProposal({
        document_id: docId,
        op: "append",
        markdown: content,
        origin: "app",
        summary: "Insert assistant reply",
      });
      onStaged(proposal);
    } catch {
      /* leave the reply in place; the user can retry */
    } finally {
      setStaging(null);
    }
  };

  const onSuggest = (s: (typeof SUGGESTIONS)[number]) => {
    if (s.send) {
      void send(s.prompt);
    } else {
      setInput(s.prompt);
      inputRef.current?.focus();
    }
  };

  const badge = [status.provider, status.model].filter(Boolean).join(" · ");

  return (
    <aside className="assist">
      <div className="assist-head">
        <div className="assist-brand">
          <span className="assist-spark"><Icon name="sparkles" size={16} /></span>
          <span className="assist-title">Assist</span>
        </div>
        <div className="assist-head-right">
          {messages.length > 0 && (
            <button
              className="assist-clear"
              onClick={() => {
                setMessages([]);
                setContext([]);
              }}
              disabled={busy}
            >
              New chat
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>
      {badge ? <div className="assist-badge">{badge}</div> : null}

      <div className="assist-thread" ref={threadRef}>
        {messages.length === 0 ? (
          <div className="assist-welcome">
            <p className="assist-greeting">How can I help with this note?</p>
            <p className="assist-sub">Ask anything, or start with:</p>
            <div className="assist-suggests">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} className="assist-suggest" onClick={() => onSuggest(s)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`assist-msg ${m.role}${m.error ? " error" : ""}`}>
              <div className="assist-bubble">
                {m.role === "assistant" && !m.error ? (
                  <div className="assist-md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {stripInsertMarkers(m.content)}
                    </ReactMarkdown>
                  </div>
                ) : (
                  m.content
                )}
                {m.streaming ? <span className="assist-caret" /> : null}
              </div>
              {m.role === "assistant" && !m.streaming && !m.error && m.content ? (
                <div className="assist-msg-actions">
                  <button
                    onClick={() => insertIntoNote(extractInsertable(m.content), i)}
                    disabled={staging != null}
                  >
                    {staging === i ? "Staging…" : "Insert into note"}
                  </button>
                  <button onClick={() => navigator.clipboard?.writeText(extractInsertable(m.content))}>
                    Copy
                  </button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <ContextPicker
        docId={docId}
        workspaceId={workspaceId}
        selected={context}
        onChange={setContext}
      />

      <div className="assist-composer">
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder="Ask about this note…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        {busy ? (
          <button className="assist-send stop" onClick={stop} aria-label="Stop">
            <Icon name="square" size={16} />
          </button>
        ) : (
          <button
            className="assist-send"
            onClick={() => void send(input)}
            disabled={!input.trim()}
            aria-label="Send"
          >
            <Icon name="arrow-up" size={18} />
          </button>
        )}
      </div>
    </aside>
  );
}
