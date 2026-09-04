/**
 * AI Assist panel (web) — a right-side panel in the editor. Sends the current
 * document (as markdown) plus an intent to the server's /ai/complete and lets the
 * user insert the suggestion. Shown only when /ai/status reports a provider.
 */
import { useState } from "react";
import { api, type AiStatus } from "./api";

const INTENTS: { key: string; label: string }[] = [
  { key: "continue", label: "Continue" },
  { key: "summarize", label: "Summarize" },
  { key: "ideas", label: "Ideas" },
  { key: "improve", label: "Improve" },
];

/** Minimal structural view of the BlockNote editor we need. */
export interface AiEditor {
  document: unknown[];
  blocksToMarkdownLossy: (blocks?: unknown[]) => Promise<string>;
  tryParseMarkdownToBlocks: (markdown: string) => Promise<unknown[]>;
  insertBlocks: (blocks: unknown[], referenceBlock: unknown, placement: "before" | "after") => void;
}

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
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [last, setLast] = useState<{ intent: string; prompt?: string } | null>(null);

  const run = async (intent: string, prompt?: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setLast({ intent, prompt });
    try {
      const context = editor ? await editor.blocksToMarkdownLossy(editor.document) : "";
      const res = await api.aiComplete({ doc_id: docId, intent, prompt, context });
      setResult(res.text);
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 200) : "Assist failed.");
    } finally {
      setBusy(false);
    }
  };

  const insert = async () => {
    if (!editor || result == null) return;
    const blocks = await editor.tryParseMarkdownToBlocks(result);
    const doc = editor.document;
    editor.insertBlocks(blocks, doc[doc.length - 1], "after");
    onClose();
  };

  const badge = [status.provider, status.model].filter(Boolean).join(" · ");

  return (
    <aside className="assist">
      <div className="assist-head">
        <span className="assist-title">Assist</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {badge ? <div className="assist-badge">{badge}</div> : null}

      <div className="assist-chips">
        {INTENTS.map((it) => (
          <button key={it.key} className="assist-chip" disabled={busy} onClick={() => run(it.key)}>
            {it.label}
          </button>
        ))}
      </div>

      <div className="assist-ask">
        <input
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder="Ask about this page…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && ask.trim()) run("ask", ask.trim());
          }}
        />
        <button
          className="assist-send"
          disabled={busy || !ask.trim()}
          onClick={() => ask.trim() && run("ask", ask.trim())}
        >
          Ask
        </button>
      </div>

      <div className="assist-result">
        {busy ? (
          <div className="assist-muted">Thinking…</div>
        ) : error ? (
          <div className="assist-err">{error}</div>
        ) : result != null ? (
          <div className="assist-text">{result}</div>
        ) : (
          <div className="assist-muted">
            Pick an action or ask a question to get a suggestion grounded in this page.
          </div>
        )}
      </div>

      {result != null && !busy ? (
        <div className="assist-actions">
          <button className="assist-insert" onClick={insert}>
            Insert
          </button>
          <button className="assist-retry" onClick={() => last && run(last.intent, last.prompt)}>
            Retry
          </button>
        </div>
      ) : null}
    </aside>
  );
}
