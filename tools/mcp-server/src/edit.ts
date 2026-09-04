/**
 * Read-modify-write for note content. Reconstructs a note's Yjs doc from its
 * update log, mutates the BlockNote fragment in place, and produces a clean
 * *incremental* update (a diff) — so appending or rewriting a note doesn't
 * duplicate its content the way seeding a fresh doc would.
 *
 * The mutation uses y-prosemirror's updateYFragment, the same routine the live
 * editor binding uses, so the diff is minimal and merges correctly on the server.
 */
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { updateYFragment } from "y-prosemirror";

const FRAGMENT_NAME = "document-store";

/* eslint-disable @typescript-eslint/no-explicit-any */
let editorSingleton: any = null;
function editor(): any {
  if (!editorSingleton) editorSingleton = (ServerBlockNoteEditor as any).create();
  return editorSingleton;
}

/** Rebuild a Y.Doc from the ordered base64 updates returned by GET content. */
export function loadDoc(updatesBase64: string[]): Y.Doc {
  const doc = new Y.Doc();
  for (const u of updatesBase64) Y.applyUpdate(doc, Buffer.from(u, "base64"));
  return doc;
}

/** Mutate the doc's fragment to `newBlocks` and return the base64 diff update. */
function diffToBlocks(doc: Y.Doc, newBlocks: any): string {
  const beforeSV = Y.encodeStateVector(doc);
  const fragment = doc.getXmlFragment(FRAGMENT_NAME);
  const pmNode = editor()._blocksToProsemirrorNode(newBlocks);
  doc.transact(() => {
    // BindingMetadata: `mapping` caches PM<->Y node links; `isOMark` tracks
    // overlapping marks (needed as soon as any inline mark — bold, italic — is
    // present). Both must exist or updateYFragment throws on marked text.
    updateYFragment(doc, fragment, pmNode, { mapping: new Map(), isOMark: new Map() } as any);
  });
  const diff = Y.encodeStateAsUpdate(doc, beforeSV);
  return Buffer.from(diff).toString("base64");
}

/** Current note body as Markdown. */
export async function docToMarkdown(updatesBase64: string[]): Promise<string> {
  const doc = loadDoc(updatesBase64);
  const blocks = editor().yDocToBlocks(doc, FRAGMENT_NAME);
  return editor().blocksToMarkdownLossy(blocks);
}

/** Diff that appends `markdown`'s blocks after the note's existing content. */
export async function appendMarkdownDiff(
  updatesBase64: string[],
  markdown: string,
): Promise<string> {
  const doc = loadDoc(updatesBase64);
  const existing = editor().yDocToBlocks(doc, FRAGMENT_NAME);
  const added = await editor().tryParseMarkdownToBlocks(markdown);
  return diffToBlocks(doc, [...existing, ...added]);
}

/** Diff that replaces the whole note body with `markdown`. */
export async function replaceMarkdownDiff(
  updatesBase64: string[],
  markdown: string,
): Promise<string> {
  const doc = loadDoc(updatesBase64);
  const blocks = await editor().tryParseMarkdownToBlocks(markdown);
  return diffToBlocks(doc, blocks);
}

/** Fresh-doc seed update for a brand-new (empty) note. */
export async function markdownToUpdateBase64(markdown: string): Promise<string> {
  const ed = editor();
  const blocks = await ed.tryParseMarkdownToBlocks(markdown);
  const ydoc = ed.blocksToYDoc(blocks, FRAGMENT_NAME);
  return Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64");
}
