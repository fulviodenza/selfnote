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
import { useCallback, useEffect, useMemo, useState } from "react";
import { BlockNoteEditor } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { blocksToYDoc, yDocToBlocks, withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { FRAGMENT_NAME, type DocConnection } from "@selfnote/core";
import * as Y from "yjs";
import { fromBase64, toBase64 } from "lib0/buffer";
import { LinkNotePopover, type LinkNoteDoc, type LinkNoteProvider } from "./LinkNotePopover";

export type { LinkNoteDoc, LinkNoteProvider } from "./LinkNotePopover";

export interface EditorUser {
  name: string;
  color: string;
  /** BlockNote's CollaborationUser allows arbitrary extra string fields. */
  [key: string]: string;
}

/**
 * Runs the `/ai-summarize` slash command: given the note's plain text, returns
 * the model's summary as Markdown. Wired by the host to `POST /ai/complete`
 * (`intent:"summarize"`). Throwing surfaces an error toast; the editor inserts
 * nothing. Omitting this (or `aiFeatures` lacking `"summarize"`) hides the item.
 */
export type SummarizeFn = (context: string) => Promise<string>;

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

  // ---- Slash commands (see docs/features/editor-slash-commands.md) ----
  /**
   * Injected note picker data source that powers the `/link-note` slash command
   * and the `[[` / `@` triggers (backed by `GET /documents/link-search`).
   */
  linkNoteProvider?: LinkNoteProvider;
  /** Navigate to a linked note when its inline `selfnote:<id>` link is activated. */
  onNavigateToDoc?: (id: string) => void;
  /**
   * Fired (debounced by the host) with the current set of outgoing note
   * references whenever the document changes — the host persists it via
   * `PUT /documents/:id/links`. See {@link extractDocLinks}.
   */
  onLinksChange?: (links: ExtractedLink[]) => void;
  /**
   * AI feature flags from `GET /ai/status` — `/ai-summarize` only appears when
   * this includes `"summarize"` and `summarize` is provided.
   */
  aiFeatures?: string[];
  /** Runs `/ai-summarize`; see {@link SummarizeFn}. */
  summarize?: SummarizeFn;
  /** Surface a transient error to the user (e.g. AI `409`/network failure). */
  onError?: (message: string) => void;
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

/**
 * Note-reference href scheme. An inline link whose href is `selfnote:<docId>`
 * is a note reference; the host intercepts clicks to navigate in-app instead of
 * handing the URL to the browser/OS, and reports the extracted set to
 * `PUT /documents/:id/links`.
 */
const DOC_SCHEME = "selfnote:";

/** In-app note reference for a doc; the click handler intercepts it. */
function docHref(id: string): string {
  return `${DOC_SCHEME}${id}`;
}

/** The doc id of a `selfnote:<id>` href, or null for any other href. */
function docIdFromHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith(DOC_SCHEME)) return null;
  const id = href.slice(DOC_SCHEME.length);
  return /^[\w-]+$/.test(id) ? id : null;
}

/** One extracted outgoing note reference (mirrors the API's LinkInput). */
export interface ExtractedLink {
  target_id: string;
  label: string | null;
}

/**
 * Scan a BlockNote document for inline note-reference links (href
 * `selfnote:<id>`) and return the deduped outgoing set. `label` is the anchor
 * text of the link (last one wins on duplicate targets). Host code feeds this to
 * `PUT /documents/:id/links` (debounced). Recurses into nested block children.
 */
export function extractDocLinks(blocks: unknown): ExtractedLink[] {
  const byTarget = new Map<string, string | null>();
  const walkInline = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const node of content as Array<Record<string, unknown>>) {
      if (node?.type === "link") {
        const id = docIdFromHref(node.href as string | undefined);
        if (id) byTarget.set(id, inlineText(node.content) || null);
      }
    }
  };
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const block of list as Array<Record<string, unknown>>) {
      walkInline(block?.content);
      if (Array.isArray(block?.children)) walk(block.children);
    }
  };
  walk(blocks);
  return [...byTarget].map(([target_id, label]) => ({ target_id, label }));
}

/** Plain text of a BlockNote inline-content array (styled-text + link nodes). */
function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((n) => {
      if (typeof n?.text === "string") return n.text;
      // Nested inline content (e.g. a link's own styled content).
      if (Array.isArray(n?.content)) return inlineText(n.content);
      return "";
    })
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
  linkNoteProvider,
  onNavigateToDoc,
  onLinksChange,
  aiFeatures,
  summarize,
  onError,
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

  // Anchored `/link-note` picker; null when closed. Coordinates come from the
  // caret's client rect at the moment the command runs.
  const [linkPicker, setLinkPicker] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    onEditorReady?.(editor as unknown as BlockNoteEditor);
  }, [editor, onEditorReady]);

  const handleChange = () => {
    const first = editor.document[0] as { type?: string; content?: unknown } | undefined;
    if (onFirstHeadingChange && first?.type === "heading") {
      const text = blockText(first);
      if (text) onFirstHeadingChange(text);
    }
    // Report the current outgoing note-reference set; the host debounces and
    // persists it via `PUT /documents/:id/links`.
    onLinksChange?.(extractDocLinks(editor.document));
  };

  const aiSummarizeEnabled = !!summarize && !!aiFeatures?.includes("summarize");

  // Open the note picker anchored to the current caret position.
  const openLinkPicker = useCallback(() => {
    const rect = window.getSelection()?.rangeCount
      ? window.getSelection()!.getRangeAt(0).getBoundingClientRect()
      : null;
    setLinkPicker(
      rect && (rect.top || rect.left)
        ? { top: rect.bottom + 4, left: rect.left }
        : { top: window.innerHeight / 3, left: window.innerWidth / 3 },
    );
  }, []);

  // Run `/ai-summarize`: show an inline placeholder, call the host, then insert
  // the parsed Markdown as block(s) after the current block. Errors → toast.
  const runSummarize = useCallback(async () => {
    if (!summarize) return;
    const current = editor.getTextCursorPosition().block;
    const [placeholder] = editor.insertBlocks(
      [{ type: "paragraph", content: "Summarizing…" }],
      current,
      "after",
    );
    try {
      const context = await editor.blocksToMarkdownLossy(editor.document);
      const text = await summarize(context);
      const blocks = await editor.tryParseMarkdownToBlocks(text);
      editor.replaceBlocks([placeholder], blocks);
    } catch (e) {
      editor.removeBlocks([placeholder]);
      onError?.(errorMessage(e));
    }
  }, [editor, summarize, onError]);

  // Build the slash menu: the BlockNote defaults plus our three commands. The
  // list is recomputed as its inputs change (AI gating, provider availability).
  const getSlashItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const items: DefaultReactSuggestionItem[] = [
        ...getDefaultReactSlashMenuItems(editor),
        {
          title: "Table",
          aliases: ["table", "grid"],
          group: "Blocks",
          onItemClick: () => {
            const current = editor.getTextCursorPosition().block;
            editor.insertBlocks(
              [{ type: "table", content: { type: "tableContent", rows: emptyTableRows() } }],
              current,
              "after",
            );
          },
        },
      ];

      if (linkNoteProvider) {
        items.push({
          title: "Link note",
          aliases: ["link", "note", "mention"],
          group: "Blocks",
          onItemClick: openLinkPicker,
        });
      }

      if (aiSummarizeEnabled) {
        items.push({
          title: "AI summarize",
          aliases: ["ai", "summary", "summarize"],
          group: "AI",
          onItemClick: () => {
            void runSummarize();
          },
        });
      }

      return filterSuggestionItems(items, query);
    },
    [editor, linkNoteProvider, openLinkPicker, aiSummarizeEnabled, runSummarize],
  );

  // Insert an inline link (text = note title, href = `selfnote:<id>`) at the caret.
  const insertLink = useCallback(
    (doc: LinkNoteDoc) => {
      editor.insertInlineContent([
        {
          type: "link",
          href: docHref(doc.id),
          content: doc.title || "Untitled",
        },
        " ",
      ]);
      setLinkPicker(null);
      editor.focus();
      // A programmatic insert doesn't fire BlockNote's onChange in every path,
      // so re-report the outgoing set explicitly.
      onLinksChange?.(extractDocLinks(editor.document));
    },
    [editor, onLinksChange],
  );

  // `[[` / `@` trigger: a native BlockNote suggestion menu backed by the note
  // picker's workspace search (wired by the host to `GET /documents/link-search`).
  // Selecting a result inserts the same inline `selfnote:<id>` link.
  const getLinkItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      if (!linkNoteProvider) return [];
      const q = query.trim();
      let docs: LinkNoteDoc[] = [];
      try {
        docs = q
          ? await linkNoteProvider.search(q)
          : (await linkNoteProvider.recents()).slice(0, 10);
      } catch {
        docs = [];
      }
      return docs.map((d) => ({
        title: d.title || "Untitled",
        icon: <span>{d.icon || "📄"}</span>,
        onItemClick: () => insertLink(d),
      }));
    },
    [linkNoteProvider, insertLink],
  );

  // Activating an inserted note link navigates in-app instead of following the
  // `selfnote:<id>` href (which the OS/Tauri shell would otherwise try to open).
  // Hosts that also intercept these clicks converge on the same route.
  const onLinkClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onNavigateToDoc) return;
      const anchor = (e.target as HTMLElement).closest("a");
      const id = docIdFromHref(anchor?.getAttribute("href"));
      if (id) {
        e.preventDefault();
        onNavigateToDoc(id);
      }
    },
    [onNavigateToDoc],
  );

  return (
    <div onClickCapture={onLinkClick}>
      <BlockNoteView
        editor={editor}
        theme={theme}
        editable={editable}
        onChange={handleChange}
        // We supply our own slash menu (defaults + Table / Link note / AI
        // summarize) instead of BlockNote's built-in one.
        slashMenu={false}
      >
        <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} />
        {linkNoteProvider && (
          <>
            {/* `[[` / `@` link picker (see docs/features/backlinks-graph.md §4). */}
            <SuggestionMenuController triggerCharacter="[" getItems={getLinkItems} />
            <SuggestionMenuController triggerCharacter="@" getItems={getLinkItems} />
          </>
        )}
      </BlockNoteView>
      {editable && linkPicker && linkNoteProvider && (
        <LinkNotePopover
          provider={linkNoteProvider}
          anchor={linkPicker}
          onSelect={insertLink}
          onClose={() => setLinkPicker(null)}
        />
      )}
    </div>
  );
}

/**
 * A read-only BlockNote render of a past document state, for the version-history
 * time-travel preview (see docs/features/version-history.md §4). Takes the base64
 * v1 Yjs updates a checkpoint returns (`GET …/history/:id → updates`), rebuilds a
 * throwaway `Y.Doc`, converts its `document-store` fragment to blocks, and shows
 * them in a non-editable editor. It never touches the live document — restore is
 * a separate, explicit action in the host. The throwaway doc is destroyed once
 * its content has been read.
 */
export function ReadOnlyPreview({
  updates,
  theme = "light",
}: {
  /** Ordered base64 v1 Yjs updates (a checkpoint's `updates`; one merged element). */
  updates: string[];
  theme?: "light" | "dark";
}) {
  // Convert the past state to blocks once. A fresh headless editor performs the
  // Yjs→blocks conversion; the visible read-only editor is seeded from the result.
  const blocks = useMemo(() => {
    const doc = new Y.Doc();
    try {
      for (const u of updates) Y.applyUpdate(doc, fromBase64(u));
      const scratch = BlockNoteEditor.create();
      return yDocToBlocks(scratch, doc, FRAGMENT_NAME);
    } catch {
      return [];
    } finally {
      doc.destroy();
    }
  }, [updates]);

  const editor = useCreateBlockNote(
    // BlockNote requires at least one block; fall back to a default empty doc.
    { initialContent: blocks.length ? blocks : undefined },
    [blocks],
  );

  return <BlockNoteView editor={editor} theme={theme} editable={false} />;
}

/** Best-effort human message for an error thrown by a slash command. */
function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) {
    // The API client throws with the server body as the message; a 409 carries
    // "no AI provider configured".
    if (/no ai provider/i.test(e.message)) return "No AI provider is configured.";
    return e.message.length < 200 ? e.message : "Couldn't summarize this note.";
  }
  return "Couldn't summarize this note.";
}

/** A blank 3×3 grid for a freshly-inserted `/table` (empty-string cells). */
function emptyTableRows(): { cells: string[] }[] {
  const row = () => ({ cells: ["", "", ""] });
  return [row(), row(), row()];
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

/**
 * Headless Yjs → Markdown renderer, the inverse of the importer. Takes the
 * base64 Yjs updates the content API returns (a snapshot plus later updates),
 * reconstructs the document, and renders it to Markdown — without opening a live
 * editor. Used to resolve a note's body for AI "extra_docs" when it isn't the
 * one currently open in the editor.
 */
export interface MarkdownRenderer {
  fromUpdatesBase64(updates: string[]): Promise<string>;
}

export function createRenderer(): MarkdownRenderer {
  const editor = BlockNoteEditor.create();
  return {
    async fromUpdatesBase64(updates: string[]) {
      const ydoc = new Y.Doc();
      for (const u of updates) Y.applyUpdate(ydoc, fromBase64(u));
      const blocks = yDocToBlocks(editor, ydoc, FRAGMENT_NAME);
      ydoc.destroy();
      return editor.blocksToMarkdownLossy(blocks);
    },
  };
}
