/**
 * Markdown paste, for the nodes BlockNote does not know about.
 *
 * BlockNote parses pasted Markdown perfectly well on its own, and keeps doing
 * so: this handler is not a general takeover of pasting. It intervenes only
 * when the clipboard holds syntax BlockNote would get wrong, which is exactly
 * our custom nodes: `$$ … $$` and `$ … $` (math) and `> [!kind]` (callouts).
 * Everything else falls straight through untouched.
 *
 * Without this, the single most common way a formula-heavy note enters
 * Selfnote, pasting it, was also the one way that could not produce a formula.
 */
import {
  blocksToMarkdownWithCallouts,
  markdownToBlocksWithCallouts,
  type MarkdownEditor,
} from "./calloutMarkdown";
import { hasInlineMath } from "./mathMarkdown";

/** Minimal shape of the BlockNote editor this needs. */
export interface PasteEditor extends MarkdownEditor {
  _tiptapEditor?: { view?: { dom?: HTMLElement } };
  getTextCursorPosition: () => { block: { id: string; type?: string } };
  getSelection?: () => { blocks?: unknown[] } | undefined;
  replaceBlocks: (target: unknown[], blocks: unknown[]) => unknown;
  insertBlocks: (blocks: unknown[], reference: unknown, placement: string) => unknown;
  insertInlineContent?: (content: unknown[]) => unknown;
}

/** A `$$` opening a line: display math, which is block-level either way. */
const DISPLAY_RE = /^[ \t]*\$\$/m;
/** A GitHub-alert marker: a callout, also block-level. */
const CALLOUT_RE = /^[ \t]*>[ \t]*\[!\w+\]/m;

/**
 * What, if anything, in this text needs our converter.
 *
 * Inline math is reported separately from the block-level constructs because
 * the two justify different amounts of interference: see `onPaste`.
 *
 * The inline test defers to the importer's own predicate, and runs per line so
 * it cannot match a `$ … $` spanning a newline that the importer (which works
 * per inline text node) would never convert.
 */
export function classifyPaste(text: string): "block" | "inline" | "none" {
  if (!text) return "none";
  if (DISPLAY_RE.test(text) || CALLOUT_RE.test(text)) return "block";
  for (const line of text.split("\n")) {
    if (hasInlineMath(line)) return "inline";
  }
  return "none";
}

/*
 * Residual, stated rather than papered over: `export PATH=$PATH:$HOME/bin`
 * classifies as inline math, because `PATH:` genuinely satisfies every
 * delimiter rule we have. The two guards in `onPaste` cover the cases that
 * matter, a paste into a code block and a paste carrying a rich flavour, so
 * what is left is plain-text shell pasted into prose. That converts, and the
 * importer would do the same to the same text, so at least the two agree.
 */

/** Kept for callers that only need a yes/no. */
export function needsCustomParse(text: string): boolean {
  return classifyPaste(text) !== "none";
}

/**
 * Attach the handler. Safe to call once after the editor is created.
 * Returns a disposer.
 *
 * `editable` must be the editor's real editability: this writes to the document
 * through `replaceBlocks`/`insertBlocks` rather than through ProseMirror, so it
 * is not covered by BlockNote's own editable guard. Registering it on a
 * read-only share would let a viewer paste into a page they cannot edit.
 */
export function registerMarkdownPaste(editor: PasteEditor, editable: boolean): () => void {
  const dom = editor._tiptapEditor?.view?.dom;
  if (!dom || !editable) return () => undefined;

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    const kind = classifyPaste(text);
    if (kind === "none") return; // BlockNote handles it

    /*
     * Never take over a paste into code. `export PATH=$PATH:$HOME/bin` looks
     * like inline math by any delimiter rule, and the whole point of a code
     * block is that its contents are not interpreted.
     */
    let current: { id: string; type?: string };
    try {
      current = editor.getTextCursorPosition().block;
    } catch {
      return;
    }
    if (current.type === "codeBlock") return;

    /*
     * Inline math alone is not worth discarding a rich paste for. Preventing
     * the default throws away the `text/html` flavour, so a formatted table
     * copied out of a browser would arrive as flat text merely because some
     * `$ … $` run happened to appear in it. Block-level constructs are
     * unambiguous enough to be worth it; an ambiguous inline run is not.
     */
    if (kind === "inline" && e.clipboardData?.types?.includes("text/html")) return;

    // The parse is async and the default cannot be prevented once the event
    // returns, so we commit here. A parse that then fails leaves the document
    // unchanged rather than half-pasted, and the clipboard still holds the
    // text, so the user can retry.
    e.preventDefault();

    void (async () => {
      try {
        const blocks = await markdownToBlocksWithCallouts(editor, text);
        if (!blocks.length) return;

        /*
         * A paste that is one paragraph is inline content, and belongs at the
         * caret rather than as a new block after it. This is also what keeps a
         * mid-sentence paste from jumping to the end of the paragraph.
         */
        const sole =
          blocks.length === 1 ? (blocks[0] as { type?: string; content?: unknown }) : null;
        if (
          sole?.type === "paragraph" &&
          Array.isArray(sole.content) &&
          editor.insertInlineContent
        ) {
          editor.insertInlineContent(sole.content);
          return;
        }

        // Pasting over a selection replaces it, as every editor does and as
        // BlockNote's own handler would have.
        const selected = editor.getSelection?.()?.blocks;
        if (Array.isArray(selected) && selected.length > 0) {
          editor.replaceBlocks(selected, blocks);
          return;
        }

        // Otherwise replace an empty current block (so the paste does not leave
        // a blank line above it), else insert after it.
        if (await isEmptyBlock(editor, current)) {
          editor.replaceBlocks([current], blocks);
        } else {
          editor.insertBlocks(blocks, current, "after");
        }
      } catch {
        /* nothing sensible to recover to; the clipboard still holds the text */
      }
    })();
  };

  dom.addEventListener("paste", onPaste, true);
  return () => dom.removeEventListener("paste", onPaste, true);
}

/** True when the block holds no text, so the paste can take its place. */
async function isEmptyBlock(editor: PasteEditor, block: { id: string }): Promise<boolean> {
  try {
    const md = await blocksToMarkdownWithCallouts(editor, [block]);
    return md.trim() === "";
  } catch {
    return false;
  }
}
