/**
 * Note-level AI actions (web) — first-class inline transformations of the
 * current note: Summarize, Rewrite in my voice, Extract action items. Rendered
 * as an "AI actions" button in the editor topbar (next to the Assist toggle);
 * it opens a small popover with the three actions. When the editor has a
 * non-empty selection the actions default to `scope:"selection"`, otherwise
 * `scope:"note"`. Clicking an action opens a lightweight streaming result panel
 * with Insert / Replace / Copy / Retry / Dismiss. Shown only when /ai/status
 * reports a provider; a `409` hides the entry point.
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type AiActionKind, type AiActionScope } from "./api";
import { Icon } from "./Icon";

/**
 * Minimal structural view of the BlockNote editor we need for note-level
 * actions — a superset of the Assist panel's `AiEditor`. All optional-ish
 * methods come straight off the BlockNote instance exposed via onEditorReady.
 */
export interface ActionEditor {
  document: unknown[];
  blocksToMarkdownLossy: (blocks?: unknown[]) => Promise<string>;
  tryParseMarkdownToBlocks: (markdown: string) => Promise<unknown[]>;
  insertBlocks: (
    blocks: unknown[],
    referenceBlock: unknown,
    placement: "before" | "after",
  ) => void;
  replaceBlocks: (
    blocksToRemove: unknown[],
    blocksToInsert: unknown[],
  ) => { insertedBlocks: unknown[]; removedBlocks: unknown[] };
  getSelectedText: () => string;
  getSelection: () => { blocks: unknown[] } | undefined;
  getTextCursorPosition: () => { block: unknown };
}

const ACTIONS: { kind: AiActionKind; label: string; hint: string }[] = [
  { kind: "summarize", label: "Summarize", hint: "TL;DR and key points" },
  { kind: "rewrite", label: "Rewrite in my voice", hint: "Same meaning, your style" },
  { kind: "action_items", label: "Extract action items", hint: "As a checklist" },
];

/** How the running action should be applied — mirrors the request scope. */
interface Pending {
  kind: AiActionKind;
  scope: AiActionScope;
  /** The whole-note plain text, sent as `text`. */
  text: string;
  /** The selected passage when scope is "selection", else null. */
  selection: string | null;
  /** Snapshot of the selected blocks at launch, for Replace(selection). */
  selectedBlocks: unknown[] | null;
}

export function NoteAiActions({
  editor,
  docId,
}: {
  editor: ActionEditor | null;
  docId: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  // A non-empty selection at the moment the popover is shown flips the default
  // scope to "selection". Tracked so the menu can hint "Selected text".
  const [hasSelection, setHasSelection] = useState(false);

  const openMenu = () => {
    let sel = "";
    try {
      sel = editor?.getSelectedText().trim() ?? "";
    } catch {
      /* editor not ready */
    }
    setHasSelection(sel.length > 0);
    setOpen((v) => !v);
  };

  const run = async (kind: AiActionKind) => {
    if (!editor) return;
    setOpen(false);

    let text = "";
    try {
      text = await editor.blocksToMarkdownLossy(editor.document);
    } catch {
      /* leave empty; the panel will surface the server's 400 */
    }

    let selection: string | null = null;
    let selectedBlocks: unknown[] | null = null;
    if (hasSelection) {
      try {
        selection = editor.getSelectedText();
        selectedBlocks = editor.getSelection()?.blocks ?? null;
      } catch {
        selection = null;
      }
    }
    const scope: AiActionScope = selection ? "selection" : "note";
    setPending({ kind, scope, text, selection, selectedBlocks });
  };

  return (
    <div className="nai">
      <button
        className={open ? "toggle on" : "toggle"}
        onClick={openMenu}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="sparkles" size={15} /> AI actions
      </button>
      {open && (
        <>
          <div className="nai-scrim" onClick={() => setOpen(false)} />
          <div className="nai-menu" role="menu">
            <div className="nai-menu-head">
              {hasSelection ? "Selected text" : "Whole note"}
            </div>
            {ACTIONS.map((a) => (
              <button key={a.kind} className="nai-menu-item" role="menuitem" onClick={() => run(a.kind)}>
                <span className="nai-menu-label">{a.label}</span>
                <span className="nai-menu-hint">{a.hint}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {pending && (
        <AiActionResult
          editor={editor}
          docId={docId}
          pending={pending}
          onDismiss={() => setPending(null)}
        />
      )}
    </div>
  );
}

const ACTION_TITLE: Record<AiActionKind, string> = {
  summarize: "Summary",
  rewrite: "Rewrite",
  action_items: "Action items",
};

/**
 * Streaming result panel for one action run. Streams over `/ai/action/stream`,
 * falling back nowhere (the stream path already returns pre-stream errors as
 * HTTP codes). Footer: Insert, Replace (confirm for whole-note), Copy, Retry,
 * Dismiss. A `409` surfaces "No AI provider configured".
 */
function AiActionResult({
  editor,
  docId,
  pending,
  onDismiss,
}: {
  editor: ActionEditor | null;
  docId: string;
  pending: Pending;
  onDismiss: () => void;
}) {
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [applied, setApplied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stream = () => {
    setResult("");
    setError(null);
    setApplied(false);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";
    api
      .aiActionStream(
        {
          action: pending.kind,
          scope: pending.scope,
          doc_id: docId,
          text: pending.text,
          selection: pending.scope === "selection" ? pending.selection : null,
        },
        {
          signal: controller.signal,
          onDelta: (d) => {
            acc += d;
            setResult(acc);
          },
          onDone: () => {
            setBusy(false);
            abortRef.current = null;
          },
          onError: (msg) => {
            setError(msg);
            setBusy(false);
            abortRef.current = null;
          },
        },
      )
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        const status = (e as { status?: number }).status;
        setError(
          status === 409
            ? "No AI provider configured."
            : e instanceof Error
              ? e.message.slice(0, 200)
              : "Action failed.",
        );
        setBusy(false);
        abortRef.current = null;
      });
  };

  // Fire the stream on mount and whenever the pending action changes (Retry
  // re-runs the same request by re-invoking `stream`).
  useEffect(() => {
    stream();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const canApply = !busy && !error && result.trim().length > 0;

  const insert = async () => {
    if (!editor || !canApply) return;
    try {
      const blocks = await editor.tryParseMarkdownToBlocks(result);
      // Anchor at the end of the current selection if any, else the cursor block.
      const anchor =
        (pending.selectedBlocks && pending.selectedBlocks[pending.selectedBlocks.length - 1]) ||
        editor.getTextCursorPosition().block;
      editor.insertBlocks(blocks, anchor, "after");
      setApplied(true);
      onDismiss();
    } catch {
      setError("Couldn’t insert the result into the note.");
    }
  };

  const replace = async () => {
    if (!editor || !canApply) return;
    // Whole-note replace is destructive — gate behind an explicit confirm.
    if (pending.scope === "note" && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    try {
      const blocks = await editor.tryParseMarkdownToBlocks(result);
      const target =
        pending.scope === "selection" && pending.selectedBlocks?.length
          ? pending.selectedBlocks
          : editor.document;
      editor.replaceBlocks(target, blocks);
      setApplied(true);
      onDismiss();
    } catch {
      setError("Couldn’t replace the note content.");
    }
  };

  const replaceLabel =
    pending.scope === "selection"
      ? "Replace selection"
      : confirmReplace
        ? "Confirm replace note"
        : "Replace note";

  return (
    <>
      <div className="nai-panel-scrim" onClick={onDismiss} />
      <div className="nai-panel" role="dialog" aria-label={`${ACTION_TITLE[pending.kind]} result`}>
        <div className="nai-panel-head">
          <div className="nai-panel-title">
            <span className="assist-spark"><Icon name="sparkles" size={16} /></span>
            {ACTION_TITLE[pending.kind]}
            <span className="nai-panel-scope">
              {pending.scope === "selection" ? "Selected text" : "Whole note"}
            </span>
          </div>
          <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="nai-panel-body">
          {error ? (
            <div className="nai-panel-error">{error}</div>
          ) : (
            <div className="assist-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
              {busy ? <span className="assist-caret" /> : null}
            </div>
          )}
        </div>

        <div className="nai-panel-foot">
          {error ? (
            <>
              <button className="nai-foot-primary" onClick={stream}>
                Retry
              </button>
              <button onClick={onDismiss}>Dismiss</button>
            </>
          ) : (
            <>
              <button className="nai-foot-primary" onClick={insert} disabled={!canApply || applied}>
                Insert
              </button>
              <button
                className={confirmReplace ? "nai-foot-danger" : undefined}
                onClick={replace}
                disabled={!canApply || applied}
              >
                {replaceLabel}
              </button>
              <button onClick={() => navigator.clipboard?.writeText(result)} disabled={!result}>
                Copy
              </button>
              <button onClick={stream} disabled={busy}>
                Retry
              </button>
              <button onClick={onDismiss}>Dismiss</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
