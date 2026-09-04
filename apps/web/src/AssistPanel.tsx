/**
 * AI Assist (web) — a Claude-style chat in the editor's right sidebar. Talks to
 * the server's streaming /ai/chat/stream, grounds each turn in the current note,
 * and lets the user drop any reply straight into the document. Shown only when
 * /ai/status reports a provider.
 */
import { useEffect, useRef, useState } from "react";
import { api, type AiStatus, type ChatMessage } from "./api";

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

export function AssistPanel({
  editor,
  status,
  docId,
  onClose,
}: {
  editor: AiEditor | null;
  status: AiStatus;
  docId: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

    let context = "";
    try {
      context = editor ? await editor.blocksToMarkdownLossy(editor.document) : "";
    } catch {
      /* editor not ready — send without context */
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
        { doc_id: docId, messages: wire, context },
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

  const insertIntoNote = async (content: string) => {
    if (!editor) return;
    const blocks = await editor.tryParseMarkdownToBlocks(content);
    const doc = editor.document;
    editor.insertBlocks(blocks, doc[doc.length - 1], "after");
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
          <span className="assist-spark">✦</span>
          <span className="assist-title">Assist</span>
        </div>
        <div className="assist-head-right">
          {messages.length > 0 && (
            <button className="assist-clear" onClick={() => setMessages([])} disabled={busy}>
              New chat
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
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
                {m.content}
                {m.streaming ? <span className="assist-caret" /> : null}
              </div>
              {m.role === "assistant" && !m.streaming && !m.error && m.content ? (
                <div className="assist-msg-actions">
                  <button onClick={() => insertIntoNote(m.content)}>Insert into note</button>
                  <button onClick={() => navigator.clipboard?.writeText(m.content)}>Copy</button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

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
            ■
          </button>
        ) : (
          <button
            className="assist-send"
            onClick={() => void send(input)}
            disabled={!input.trim()}
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </div>
    </aside>
  );
}
