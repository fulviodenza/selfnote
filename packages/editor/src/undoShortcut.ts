/**
 * Global Ctrl/Cmd+Z (undo), Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y (redo).
 *
 * BlockNote binds Mod-Z itself, but only through TipTap keyboard shortcuts,
 * which fire ONLY while the ProseMirror editor has focus. Click a toolbar
 * button, the label bar, or any panel first and Ctrl+Z silently does nothing.
 * This window-level capture handler routes the shortcut to undo/redo no matter
 * where focus sits, except inside another editable field (chat composer, rename
 * input, …) where the field's own native undo must win.
 *
 * Under collaboration this drives the Yjs UndoManager, so only LOCAL changes
 * are undone: a collaborator's edits are never rolled back.
 *
 * Returns a disposer; the host unregisters it when the editor unmounts.
 * Ported to the mobile WebView as setupUndoShortcut in editorHtml.ts — keep
 * the two in sync.
 */
/**
 * Structural view of ProseMirror's EditorView. Declared here rather than
 * imported: `prosemirror-view` is a transitive dependency, not a direct one,
 * and these two fields are all this needs.
 */
interface PmView {
  dom?: HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: { plugins?: any[] } & Record<string, any>;
}

/** The Yjs UndoManager, as much of it as this needs. */
interface UndoManagerLike {
  undo: () => unknown;
  redo: () => unknown;
}

/**
 * Find the collaboration UndoManager by scanning the plugin states.
 *
 * Deliberately not `yUndoPluginKey.getState(state)`: a PluginKey matches by
 * identity, so that call silently returns undefined whenever the y-prosemirror
 * instance we imported is not the one that created the plugin. That is a real
 * possibility here (BlockNote bundles its own, and on mobile the WebView pulls
 * both from a CDN), and the failure mode is exactly the silent no-op this whole
 * change exists to remove. Duck-typing the plugin state cannot miss that way.
 */
function undoManagerOf(view: PmView | undefined): UndoManagerLike | null {
  const plugins = view?.state?.plugins;
  if (!Array.isArray(plugins)) return null;
  for (const plugin of plugins) {
    try {
      const st = plugin?.getState?.(view!.state);
      if (st?.undoManager && typeof st.undoManager.undo === "function") {
        return st.undoManager as UndoManagerLike;
      }
    } catch {
      /* a plugin that dislikes being probed is not the one we want */
    }
  }
  return null;
}

/** The slice of the BlockNote editor this shortcut needs. */
interface UndoApi {
  undo?: () => boolean;
  redo?: () => boolean;
  /** Public in BlockNote 0.54; preferred over the `_tiptapEditor` private. */
  prosemirrorView?: PmView;
  _tiptapEditor?: { view?: PmView };
}

export function registerUndoShortcut(
  editor: UndoApi,
  /**
   * Reported instead of swallowed. A silent catch on a user-facing shortcut is
   * how "Ctrl+Z does nothing" stayed undiagnosable: the one piece of
   * information needed to explain it was being thrown away on every keypress.
   */
  onError?: (message: string) => void,
): () => void {
  const viewOf = (): PmView | undefined =>
    editor.prosemirrorView ?? editor._tiptapEditor?.view;

  const handler = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const isUndo = key === "z" && !e.shiftKey;
    const isRedo = (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey);
    if (!isUndo && !isRedo) return;

    /*
     * Bail only when the focused field is positively known to be something
     * else. The previous form bailed whenever the editor's own DOM could not be
     * resolved, which is indistinguishable from "focus is in another field" and
     * meant an unknown editor DOM disabled the shortcut everywhere, silently.
     */
    const target = e.target as HTMLElement | null;
    const field = target?.closest?.("input, textarea, [contenteditable]");
    const editorDom = viewOf()?.dom;
    if (field && editorDom && !editorDom.contains(field)) return;

    e.preventDefault();
    try {
      // Driving the UndoManager directly means nothing depends on BlockNote's
      // extension registry, which looks up `yUndo` then `history` and throws
      // when neither is found; `withCollaboration` deliberately disables
      // `history`, so that path has one point of failure and no fallback.
      const manager = undoManagerOf(viewOf());
      if (manager) {
        if (isUndo) manager.undo();
        else manager.redo();
        return;
      }
      if (isUndo) editor.undo?.();
      else editor.redo?.();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  };
  window.addEventListener("keydown", handler, true);
  return () => window.removeEventListener("keydown", handler, true);
}
