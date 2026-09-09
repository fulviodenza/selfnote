/**
 * Global Ctrl/Cmd+Z (undo), Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y (redo).
 *
 * BlockNote binds Mod-Z itself, but only through TipTap keyboard shortcuts —
 * which fire ONLY while the ProseMirror editor has focus. Click a toolbar
 * button, the label bar, or any panel first and Ctrl+Z silently does nothing.
 * This window-level capture handler routes the shortcut to the editor's
 * undo/redo (the Yjs UndoManager under collaboration, so only LOCAL changes
 * are undone — a collaborator's edits are never rolled back) no matter where
 * focus sits, except inside another editable field (chat composer, rename
 * input, …) where the field's own native undo must win.
 *
 * Returns a disposer; the host unregisters it when the editor unmounts.
 * Ported to the mobile WebView as setupUndoShortcut in editorHtml.ts — keep
 * the two in sync.
 */

/** The slice of the BlockNote editor this shortcut needs. */
interface UndoApi {
  undo?: () => boolean;
  redo?: () => boolean;
  _tiptapEditor?: { view?: { dom?: HTMLElement } };
}

export function registerUndoShortcut(editor: UndoApi): () => void {
  const handler = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const isUndo = key === "z" && !e.shiftKey;
    const isRedo = (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey);
    if (!isUndo && !isRedo) return;

    // Another editable element (not the note editor) owns native undo.
    const editorDom = editor._tiptapEditor?.view?.dom;
    const target = e.target as HTMLElement | null;
    const field = target?.closest?.("input, textarea, [contenteditable]");
    if (field && !(editorDom && editorDom.contains(field))) return;

    e.preventDefault();
    try {
      if (isUndo) editor.undo?.();
      else editor.redo?.();
    } catch {
      // No undo plugin registered (shouldn't happen under collaboration) —
      // swallowing beats an uncaught error on every keypress.
    }
  };
  window.addEventListener("keydown", handler, true);
  return () => window.removeEventListener("keydown", handler, true);
}
