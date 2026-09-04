/**
 * @selfnote/editor — the shared Notion-style block editor.
 *
 * Built on BlockNote (ProseMirror/TipTap under the hood) with first-class Yjs
 * collaboration. This is the one UI piece that is web/desktop-only (DOM-based);
 * on React Native it will be hosted inside a WebView bound to the same Yjs doc.
 * Everything else in the client stack is shared via @selfnote/core.
 */
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useEffect } from "react";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc, withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { FRAGMENT_NAME, type DocConnection } from "@selfnote/core";
import * as Y from "yjs";
import { toBase64 } from "lib0/buffer";

export interface EditorUser {
  name: string;
  color: string;
  /** BlockNote's CollaborationUser allows arbitrary extra string fields. */
  [key: string]: string;
}

export interface CollaborativeEditorProps {
  connection: DocConnection;
  user: EditorUser;
  /** Force the editor color scheme instead of following the OS. */
  theme?: "light" | "dark";
  /** Fired with the plain text of the first block when it is a heading. */
  onFirstHeadingChange?: (text: string) => void;
  /** When false, the editor is read-only (e.g. a read-only share). */
  editable?: boolean;
  /** Exposes the BlockNote instance once ready (e.g. for the AI Assist panel). */
  onEditorReady?: (editor: BlockNoteEditor) => void;
}

/** Plain text of a BlockNote block's inline content. */
function blockText(block: { content?: unknown } | undefined): string {
  const content = (block?.content ?? []) as Array<{ type?: string; text?: string }>;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("")
    .trim();
}

export function CollaborativeEditor({
  connection,
  user,
  theme = "light",
  onFirstHeadingChange,
  editable = true,
  onEditorReady,
}: CollaborativeEditorProps) {
  const editor = useCreateBlockNote(
    withCollaboration({
      collaboration: {
        provider: connection.provider,
        fragment: connection.fragment,
        user,
      },
    }),
  );

  useEffect(() => {
    onEditorReady?.(editor as unknown as BlockNoteEditor);
  }, [editor, onEditorReady]);

  const handleChange = () => {
    if (!onFirstHeadingChange) return;
    const first = editor.document[0] as { type?: string; content?: unknown } | undefined;
    if (first?.type === "heading") {
      const text = blockText(first);
      if (text) onFirstHeadingChange(text);
    }
  };

  return (
    <BlockNoteView editor={editor} theme={theme} editable={editable} onChange={handleChange} />
  );
}

/**
 * Headless Markdown → Yjs converter for bulk import (e.g. an Obsidian vault).
 * Reuses one editor instance; returns a base64 Yjs update the API can seed a
 * document with, without opening a live editor per page.
 */
export interface MarkdownImporter {
  toUpdateBase64(markdown: string): Promise<string>;
}

export function createImporter(): MarkdownImporter {
  const editor = BlockNoteEditor.create();
  return {
    async toUpdateBase64(markdown: string) {
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      const ydoc = blocksToYDoc(editor, blocks, FRAGMENT_NAME);
      return toBase64(Y.encodeStateAsUpdate(ydoc));
    },
  };
}
