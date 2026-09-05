/**
 * Callout input rule for the web/React editor.
 *
 * Typing `[!note] ` / `[!tip] ` / `[!warning] ` / `[!important] ` / `[!caution] `
 * (case-insensitive, optionally prefixed with `> `) at the start of an empty
 * paragraph converts that block into a callout of that kind, caret inside.
 *
 * This is a genuine ProseMirror input rule (`prosemirror-inputrules`) attached to
 * BlockNote's underlying TipTap editor: it fires as the trailing space is typed,
 * deletes the marker text, and swaps the block type through BlockNote's public
 * API (which drives the Yjs binding correctly). If the editor doesn't expose
 * TipTap's `registerPlugin`, a keydown fallback on the editor DOM does the same.
 */
import { InputRule, inputRules } from "prosemirror-inputrules";
import { CALLOUT_KINDS, type CalloutKind } from "./callout";

/** Minimal shape of the BlockNote editor we depend on. */
interface BlockApi {
  _tiptapEditor?: {
    registerPlugin?: (plugin: unknown) => unknown;
    view?: { dom?: HTMLElement };
  };
  getTextCursorPosition: () => { block: CurrentBlock };
  updateBlock: (
    block: { id: string },
    update: { type: string; props?: Record<string, unknown> },
  ) => unknown;
}

interface CurrentBlock {
  id: string;
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

// `[!kind]` at block start (allow an optional leading `> `), followed by a space.
const MARKER_RE = new RegExp(`^(?:>\\s*)?\\[!(${CALLOUT_KINDS.join("|")})\\]\\s$`, "i");

/** Plain text of the current block's inline content. */
function blockPlainText(block: CurrentBlock): string {
  const content = block.content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c.text === "string" ? c.text : "")).join("");
}

function kindFromMatch(raw: string | undefined): CalloutKind | null {
  if (!raw) return null;
  const k = raw.toLowerCase();
  return (CALLOUT_KINDS as readonly string[]).includes(k) ? (k as CalloutKind) : null;
}

/**
 * Register the callout input rule on the given BlockNote editor. Safe to call
 * once after the editor is created.
 */
export function registerCalloutInputRule(editor: BlockApi): void {
  const tiptap = editor._tiptapEditor;

  if (tiptap?.registerPlugin) {
    const rule = new InputRule(MARKER_RE, (state, match, start, end) => {
      const kind = kindFromMatch(match[1]);
      if (!kind) return null;
      const tr = state.tr.delete(start, end);
      scheduleConvert(editor, kind);
      return tr;
    });
    tiptap.registerPlugin(inputRules({ rules: [rule] }));
    return;
  }

  attachKeydownFallback(editor);
}

/** Swap the current block to a callout on the next tick (post-transaction). */
function scheduleConvert(editor: BlockApi, kind: CalloutKind): void {
  const run = () => {
    try {
      const block = editor.getTextCursorPosition().block;
      editor.updateBlock(block, { type: "callout", props: { kind } });
    } catch {
      /* block vanished (rapid edits) — ignore */
    }
  };
  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setTimeout(run, 0);
}

/**
 * Fallback: watch for the trailing space via a capturing keydown on the editor
 * root. On space, if the current paragraph's text (plus the pending space)
 * matches the marker, convert it and let BlockNote clear the block.
 */
function attachKeydownFallback(editor: BlockApi): void {
  const dom = editor._tiptapEditor?.view?.dom;
  if (!dom) return;
  dom.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== " " && e.key !== "Spacebar") return;
    let block: CurrentBlock;
    try {
      block = editor.getTextCursorPosition().block;
    } catch {
      return;
    }
    if (block.type && block.type !== "paragraph") return;
    const text = blockPlainText(block) + " ";
    const kind = kindFromMatch(MARKER_RE.exec(text)?.[1]);
    if (!kind) return;
    e.preventDefault();
    try {
      editor.updateBlock(block, { type: "callout", props: { kind } });
    } catch {
      /* ignore */
    }
  });
}
