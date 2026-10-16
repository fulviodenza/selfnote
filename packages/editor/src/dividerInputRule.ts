/**
 * Typing `---` in an empty line: make a divider, with the caret on a new line
 * below it.
 *
 * BlockNote ships its own `^---$` input rule, but it turns the paragraph into a
 * content-less `divider` block and leaves a node selection on the `<hr>`, with
 * no block after it. The caret is gone, the browser re-anchors the view, and the
 * page jumps to the top. This handler takes the third `-` first and builds the
 * final state in one transaction: divider, empty paragraph, caret inside it.
 *
 * Anything that is not exactly "a paragraph holding `--`, caret at its end" is
 * left to BlockNote's own rule. Listens to `beforeinput` rather than `keydown`
 * because software keyboards (Android, iPad) report `keydown` as `Unidentified`.
 *
 * Uses only the public BlockNote API (no prosemirror-state imports), which keeps
 * it portable to the mobile WebView editor: see setupDividerInputRule in
 * apps/mobile/src/editor/editorHtml.ts and keep the two in sync.
 */

interface DividerBlock {
  id: string;
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** The slice of the BlockNote editor this rule needs. */
export interface DividerEditorApi {
  _tiptapEditor?: {
    view?: { dom?: HTMLElement };
    state?: {
      selection: {
        empty: boolean;
        $from: { parentOffset: number; parent: { content: { size: number } } };
      };
    };
  };
  schema?: { blockSchema?: Record<string, unknown> };
  getTextCursorPosition: () => { block: DividerBlock };
  transact: <T>(callback: (tr: unknown) => T) => T;
  insertBlocks: (blocks: Array<{ type: string }>, ref: { id: string }, placement: "after") => Array<{ id: string }>;
  updateBlock: (block: { id: string }, update: { type: string; content?: unknown[] }) => unknown;
  setTextCursorPosition: (block: { id: string }, placement: "start" | "end") => void;
}

/** True when the block is a paragraph whose whole text is `--`. */
function isDashPair(block: DividerBlock): boolean {
  if (block.type !== "paragraph" || !Array.isArray(block.content)) return false;
  if (!block.content.every((c) => c.type === "text")) return false;
  return block.content.map((c) => c.text ?? "").join("") === "--";
}

/** Attach the rule. Returns a function that detaches it. */
export function registerDividerInputRule(editor: DividerEditorApi): () => void {
  const tiptap = editor._tiptapEditor;
  const dom = tiptap?.view?.dom;
  if (!tiptap || !dom) return () => {};

  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType !== "insertText" || e.data !== "-" || e.isComposing) return;
    if (!editor.schema?.blockSchema?.divider) return;
    const sel = tiptap.state?.selection;
    if (!sel || !sel.empty || sel.$from.parentOffset !== sel.$from.parent.content.size) return;
    try {
      const block = editor.getTextCursorPosition().block;
      if (!isDashPair(block)) return;
      // One transaction: one undo step, and the selection the view sees is the
      // final text caret, never a node selection on the divider. It only
      // dispatches when the callback returns, so a throw leaves the document
      // untouched and the dash falls through to the default rule.
      editor.transact(() => {
        const [next] = editor.insertBlocks([{ type: "paragraph" }], block, "after");
        editor.updateBlock(block, { type: "divider", content: [] });
        if (next) editor.setTextCursorPosition(next, "start");
      });
      e.preventDefault();
    } catch {
      /* the block vanished under a rapid edit: leave it to the default rule */
    }
  };

  dom.addEventListener("beforeinput", onBeforeInput, true);
  return () => dom.removeEventListener("beforeinput", onBeforeInput, true);
}
