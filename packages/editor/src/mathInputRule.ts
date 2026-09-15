/**
 * Math input rules for the web/React editor.
 *
 *  - `$$` then a space at the start of an empty paragraph converts it into a
 *    math block, which opens straight into its source field.
 *  - A closing `$` completing a `$ ... $` run inside a paragraph converts that
 *    run into inline math.
 *
 * Both are genuine ProseMirror input rules (`prosemirror-inputrules`) attached
 * to BlockNote's underlying TipTap editor, mirroring calloutInputRule.ts: they
 * fire as the closing character is typed, delete the source text, and go through
 * BlockNote's public API (which drives the Yjs binding correctly). If the editor
 * does not expose TipTap's `registerPlugin`, a keydown fallback does the block
 * rule; the inline rule needs the transaction and is skipped in that case.
 */
import { InputRule, inputRules } from "prosemirror-inputrules";

/** Minimal shape of the BlockNote editor we depend on. */
interface MathEditorApi {
  _tiptapEditor?: {
    registerPlugin?: (plugin: unknown) => unknown;
    view?: { dom?: HTMLElement };
  };
  getTextCursorPosition: () => { block: CurrentBlock };
  updateBlock: (
    block: { id: string },
    update: { type: string; props?: Record<string, unknown> },
  ) => unknown;
  insertInlineContent: (content: unknown[]) => unknown;
}

interface CurrentBlock {
  id: string;
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** `$$` at the start of a block, closed by the space that triggers the rule. */
const BLOCK_RE = /^\$\$\s$/;

/**
 * `$ ... $` ending at the caret.
 *
 * The leading `(?:^|[\s(])` keeps the rule from firing across a word boundary,
 * and is matched rather than looked behind so the rule does not depend on
 * lookbehind support in every WebView we ship to.
 *
 * The body must open on a non-space and contain no `$`, so "$5 for lunch and
 * $10 for dinner" is safe: by the time the second `$` is typed the run between
 * them ends in a space, and the trailing `[^$\s]` below refuses it.
 */
const INLINE_RE = /(?:^|[\s(])\$([^$\s](?:[^$]*[^$\s])?)\$$/;

/**
 * …and a body of only digits and arithmetic punctuation is money, not
 * mathematics: "$5-$10" satisfies the delimiter rule but is a price range. Kept
 * identical to NOT_MATH_RE in mathMarkdown.ts, so typing a formula and pasting
 * the same formula produce the same result.
 */
const NOT_MATH_RE = /^[\d.,\-+/*\s]*$/;

/** Plain text of the current block's inline content. */
function blockPlainText(block: CurrentBlock): string {
  const content = block.content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c.text === "string" ? c.text : "")).join("");
}

/**
 * Register both math input rules on the given BlockNote editor. Safe to call
 * once after the editor is created.
 */
export function registerMathInputRules(editor: MathEditorApi): void {
  const tiptap = editor._tiptapEditor;

  if (tiptap?.registerPlugin) {
    const blockRule = new InputRule(BLOCK_RE, (state, _match, start, end) => {
      const tr = state.tr.delete(start, end);
      schedule(() => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "math", props: { latex: "" } });
      });
      return tr;
    });

    const inlineRule = new InputRule(INLINE_RE, (state, match, start, end) => {
      const latex = match[1];
      if (!latex.trim() || NOT_MATH_RE.test(latex)) return null;
      // Delete from the opening `$`, not from the boundary character the regex
      // also consumed, so the preceding space or "(" survives.
      const from = start + match[0].indexOf("$");
      const tr = state.tr.delete(from, end);
      schedule(() => {
        editor.insertInlineContent([{ type: "inlineMath", props: { latex } }]);
      });
      return tr;
    });

    tiptap.registerPlugin(inputRules({ rules: [blockRule, inlineRule] }));
    return;
  }

  attachKeydownFallback(editor);
}

/** Run after the current transaction has been applied. */
function schedule(run: () => void): void {
  const guarded = () => {
    try {
      run();
    } catch {
      /* block vanished (rapid edits): ignore */
    }
  };
  if (typeof queueMicrotask === "function") queueMicrotask(guarded);
  else setTimeout(guarded, 0);
}

/**
 * Fallback for the block rule only: watch for the trailing space via a keydown
 * on the editor root. The inline rule needs to rewrite a text range, which
 * needs the transaction, so it has no keydown equivalent and is simply absent
 * on an editor that cannot register plugins.
 */
function attachKeydownFallback(editor: MathEditorApi): void {
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
    if (!BLOCK_RE.test(blockPlainText(block) + " ")) return;
    e.preventDefault();
    try {
      editor.updateBlock(block, { type: "math", props: { latex: "" } });
    } catch {
      /* ignore */
    }
  });
}
