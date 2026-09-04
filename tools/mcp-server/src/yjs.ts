/**
 * Turn Markdown into a base64 Yjs update that Selfnote can append to a note.
 *
 * This mirrors exactly what the app's Obsidian importer does: parse Markdown to
 * BlockNote blocks, encode them into a fresh Yjs doc bound to the same XML
 * fragment the editor uses ("document-store"), and serialize the whole state as
 * one update. Because we only ever seed freshly-created (empty) notes with this,
 * the merge on the server is unambiguous — the note ends up containing exactly
 * these blocks.
 */
import { ServerBlockNoteEditor } from "@blocknote/server-util";
// The editor binds BlockNote to this named fragment (see packages/core).
const FRAGMENT_NAME = "document-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

let editorSingleton: any = null;
function editor(): any {
  if (!editorSingleton) editorSingleton = (ServerBlockNoteEditor as any).create();
  return editorSingleton;
}

/** blocks -> Y.Doc bound to FRAGMENT_NAME, across server-util API variants. */
async function blocksToYDoc(ed: any, blocks: any): Promise<any> {
  if (typeof ed.blocksToYDoc === "function") {
    return ed.blocksToYDoc(blocks, FRAGMENT_NAME);
  }
  // Fall back to the core helper, which needs an object exposing `pmSchema`.
  const { blocksToYDoc: core } = await import("@blocknote/core/yjs");
  const underlying = ed.editor ?? ed._editor ?? ed;
  return (core as any)(underlying, blocks, FRAGMENT_NAME);
}

export async function markdownToUpdateBase64(markdown: string): Promise<string> {
  const Y = await import("yjs");
  const ed = editor();
  const blocks = await ed.tryParseMarkdownToBlocks(markdown);
  const ydoc = await blocksToYDoc(ed, blocks);
  return Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64");
}
