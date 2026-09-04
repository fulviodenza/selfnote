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

/** The doc's current state vector, base64 — used to detect drift on accept. */
export function stateVectorBase64(updatesBase64: string[]): string {
  const doc = loadDoc(updatesBase64);
  return Buffer.from(Y.encodeStateVector(doc)).toString("base64");
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

/** The staged fields for one AI edit, all derived from the same y-prosemirror path. */
export interface ComputedProposal {
  /** Note body before the edit (Markdown). */
  before_md: string;
  /** Note body after the edit (Markdown). */
  after_md: string;
  /** Incremental Yjs update to apply on accept (base64). */
  diff_base64: string;
  /** State vector the diff was computed against (base64). */
  base_sv: string;
}

/**
 * Compute a full AI-edit proposal from a note's current updates plus the intended
 * change. Shared by proposal creation and the accept-time drift re-derivation:
 * both need the before/after Markdown, the incremental diff, and the base state
 * vector, all off the same reconstructed doc so they stay consistent.
 */
export async function computeProposal(
  updatesBase64: string[],
  op: "append" | "replace",
  markdown: string,
): Promise<ComputedProposal> {
  const ed = editor();
  const doc = loadDoc(updatesBase64);
  const base_sv = Buffer.from(Y.encodeStateVector(doc)).toString("base64");

  const existing = ed.yDocToBlocks(doc, FRAGMENT_NAME);
  const before_md: string = await ed.blocksToMarkdownLossy(existing);

  const added = await ed.tryParseMarkdownToBlocks(markdown);
  const newBlocks = op === "append" ? [...existing, ...added] : added;

  // diffToBlocks mutates `doc` in place, so compute after_md from the same doc
  // once the fragment reflects the new blocks.
  const diff_base64 = diffToBlocks(doc, newBlocks);
  const after_md: string = await ed.blocksToMarkdownLossy(ed.yDocToBlocks(doc, FRAGMENT_NAME));

  return { before_md, after_md, diff_base64, base_sv };
}

/**
 * Merge a note's ordered update log into a single v1 Yjs update (base64) — the
 * full current state as one blob. Used to capture a version-history checkpoint:
 * the merged snapshot is stored and later replayed to reconstruct the past state.
 */
export function mergeUpdatesBase64(updatesBase64: string[]): string {
  const doc = loadDoc(updatesBase64);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

/**
 * Forward update (base64) that transforms the note's *current* state into the
 * *target* checkpoint state. Build a doc at current content, apply the target
 * snapshot, then diff against the current state vector — an additive CRDT update
 * that, once appended to the log, makes every client converge on the target's
 * visible content without deleting history. `target` is a base64 v1 Yjs update.
 */
export function restoreUpdateBase64(updatesBase64: string[], target: string): string {
  const doc = loadDoc(updatesBase64);
  const currentSV = Y.encodeStateVector(doc);
  Y.applyUpdate(doc, Buffer.from(target, "base64"));
  const diff = Y.encodeStateAsUpdate(doc, currentSV);
  return Buffer.from(diff).toString("base64");
}

/** Fresh-doc seed update for a brand-new (empty) note. */
export async function markdownToUpdateBase64(markdown: string): Promise<string> {
  const ed = editor();
  const blocks = await ed.tryParseMarkdownToBlocks(markdown);
  const ydoc = ed.blocksToYDoc(blocks, FRAGMENT_NAME);
  return Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64");
}
