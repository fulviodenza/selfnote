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
  getTextCursorPosition: () => { block: { id: string } };
  replaceBlocks: (target: unknown[], blocks: unknown[]) => unknown;
  insertBlocks: (blocks: unknown[], reference: unknown, placement: string) => unknown;
}

/**
 * Does this text contain something only our converter understands?
 *
 * Cheap, and exact for inline math: it defers to the importer's own predicate
 * so the pre-check and the conversion can never disagree. Taking over a paste
 * we then decline to convert would silently downgrade it, because preventing
 * the default discards the HTML clipboard flavour BlockNote would have used.
 */
export function needsCustomParse(text: string): boolean {
  if (!text) return false;
  // A `$$` opening a line (display math).
  if (/^[ \t]*\$\$/m.test(text)) return true;
  // A GitHub-alert marker (callout).
  if (/^[ \t]*>[ \t]*\[!\w+\]/m.test(text)) return true;
  // An inline run the importer would actually convert. Asking the importer's
  // own predicate rather than approximating it matters: a looser pattern claims
  // "$5 for lunch and $10", and taking over that paste would discard the richer
  // HTML clipboard flavour BlockNote would otherwise have used.
  return hasInlineMath(text);
}

/**
 * Attach the handler. Safe to call once after the editor is created.
 * Returns a disposer.
 */
export function registerMarkdownPaste(editor: PasteEditor): () => void {
  const dom = editor._tiptapEditor?.view?.dom;
  if (!dom) return () => undefined;

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text || !needsCustomParse(text)) return; // BlockNote handles it

    // The parse is async and the default cannot be prevented after the event
    // returns, so we commit here. A parse that then fails leaves the document
    // unchanged rather than half-pasted, and the clipboard still holds the
    // text, so the user can retry.
    e.preventDefault();

    void (async () => {
      try {
        const blocks = await markdownToBlocksWithCallouts(editor, text);
        if (!blocks.length) return;
        const current = editor.getTextCursorPosition().block;
        // Replacing an empty current block avoids leaving a blank line above
        // the paste, which is what BlockNote's own handler does too.
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
