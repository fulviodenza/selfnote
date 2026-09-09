/**
 * Ctrl/Cmd+A, Notion-style progressive select:
 *
 *   1st press — select the current block's content;
 *   2nd press (block already fully selected, or the block is empty) — select
 *   the ENTIRE document, so copy/delete/format apply to the whole note.
 *
 * Implemented as a capture-phase keydown on the ProseMirror DOM so it wins over
 * both the browser default and ProseMirror's own keymap, and uses only TipTap
 * commands (no prosemirror-state imports), which keeps it portable to the
 * mobile WebView editor — see the setupSelectAll port in
 * apps/mobile/src/editor/editorHtml.ts and keep the two in sync.
 */

/** The slice of the BlockNote/TipTap editor this shortcut needs. */
interface TiptapApi {
  view?: { dom?: HTMLElement };
  state?: {
    selection: {
      from: number;
      to: number;
      $from: { start: () => number; end: () => number };
    };
  };
  commands?: {
    selectAll: () => boolean;
    setTextSelection: (range: { from: number; to: number }) => boolean;
  };
}

export function registerSelectAllShortcut(editor: { _tiptapEditor?: TiptapApi }): void {
  const tiptap = editor._tiptapEditor;
  const dom = tiptap?.view?.dom;
  if (!tiptap || !dom) return;

  dom.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key !== "a" && e.key !== "A") return;
      const sel = tiptap.state?.selection;
      const commands = tiptap.commands;
      if (!sel || !commands) return;

      e.preventDefault();
      try {
        const start = sel.$from.start();
        const end = sel.$from.end();
        const emptyBlock = start === end;
        const coversBlock = sel.from <= start && sel.to >= end && sel.to > sel.from;
        if (emptyBlock || coversBlock) commands.selectAll();
        else commands.setTextSelection({ from: start, to: end });
      } catch {
        // Unusual selection shape (e.g. inside a table cell) — whole doc.
        commands.selectAll();
      }
    },
    true,
  );
}
