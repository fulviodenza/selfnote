/**
 * WebView editor bridge (React Native side).
 *
 * The authoritative Yjs doc lives here (in @selfnote/core's connection, synced to
 * the server + SQLite). The WebView hosts BlockNote on its own Yjs doc; we exchange
 * binary CRDT updates over postMessage so the two stay in lockstep without shipping
 * a native rich-text editor.
 *
 * The imperative handle (getText/insert) lets the AI Assist panel read the current
 * document as markdown and insert a suggestion — which flows through Yjs to the
 * server like any other edit.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as Y from "yjs";
import { fromBase64, toBase64 } from "lib0/buffer";
import type { DocConnection } from "@selfnote/core";
import { api, type DocumentRef, type OutgoingLinkInput } from "../api";
import { EDITOR_HTML } from "./editorHtml";

export interface EditorUser {
  name: string;
  color: string;
}

/** Note text plus the currently-selected passage (empty when nothing selected). */
export interface EditorSelection {
  text: string;
  selection: string;
}

export interface EditorHandle {
  /** Current document as markdown/plain text (for AI context). */
  getText(): Promise<string>;
  /** Current document markdown + the selected passage (for note-level AI actions). */
  getSelection(): Promise<EditorSelection>;
  /** Render an *other* doc's cached Yjs state (base64) to markdown. */
  renderMarkdown(state: string): Promise<string>;
  /** Append text to the document (parsed from markdown). */
  insert(text: string): void;
  /** Replace the current selection, or the whole document, with markdown text. */
  replace(text: string): void;
  /**
   * Version history (docs/features/version-history.md §5): render a checkpoint's
   * base64 Yjs state read-only in an overlay, without touching the live doc.
   */
  preview(state: string): void;
  /** Dismiss the read-only version-history preview overlay. */
  clearPreview(): void;
  /**
   * Apply a base64 v1 Yjs update to the *live* doc (used by Restore to converge
   * the current editor immediately). Flows to the WebView and the server.
   */
  applyUpdate(update: string): void;
}

export interface WebViewEditorProps {
  connection: DocConnection;
  user: EditorUser;
  /** Current document id — the summarize target and the picker's own note. */
  docId: string;
  /** Workspace scope for the /link-note search + recents. */
  workspaceId: string;
  /** When false, the editor (and its slash commands) is read-only. */
  editable?: boolean;
  /** Whether the server has an AI provider (gates /ai-summarize). */
  aiAvailable?: boolean;
  /** AI feature flags from GET /ai/status (must include "summarize"). */
  aiFeatures?: string[];
  /** Activating an inserted note link navigates to that document. */
  onNavigateToDoc?: (id: string) => void;
  /**
   * Fired after the editor's outgoing "selfnote:<id>" links were re-scanned and
   * stored (PUT /documents/:id/links). `count` is the edges stored after the
   * server's dedupe/filtering; lets the parent refresh its outgoing/backlinks UI.
   */
  onLinksChanged?: (count: number) => void;
  /** Surface a slash-command failure (e.g. AI summarize 409) to the user. */
  onError?: (message: string) => void;
}

export const WebViewEditor = forwardRef<EditorHandle, WebViewEditorProps>(
  function WebViewEditor(
    {
      connection,
      user,
      docId,
      workspaceId,
      editable = true,
      aiAvailable = false,
      aiFeatures = [],
      onNavigateToDoc,
      onLinksChanged,
      onError,
    },
    handleRef,
  ) {
    const ref = useRef<WebView>(null);
    const post = (obj: unknown) => ref.current?.postMessage(JSON.stringify(obj));

    // Latest props for the message handler without re-subscribing per keystroke.
    const cfg = useRef({ docId, workspaceId, onNavigateToDoc, onLinksChanged, onError });
    cfg.current = { docId, workspaceId, onNavigateToDoc, onLinksChanged, onError };

    // Pending text/selection requests, resolved when the WebView replies.
    const pending = useRef(new Map<number, (r: EditorSelection) => void>());
    const reqId = useRef(0);

    useImperativeHandle(handleRef, () => ({
      getText() {
        const id = ++reqId.current;
        return new Promise<string>((resolve) => {
          pending.current.set(id, (r) => resolve(r.text));
          post({ type: "getText", reqId: id });
          // Fail open after 4s so the panel never hangs.
          setTimeout(() => {
            if (pending.current.delete(id)) resolve("");
          }, 4000);
        });
      },
      getSelection() {
        const id = ++reqId.current;
        return new Promise<EditorSelection>((resolve) => {
          pending.current.set(id, resolve);
          post({ type: "getSelection", reqId: id });
          // Fail open after 4s so the actions menu never hangs.
          setTimeout(() => {
            if (pending.current.delete(id)) resolve({ text: "", selection: "" });
          }, 4000);
        });
      },
      renderMarkdown(state: string) {
        const id = ++reqId.current;
        return new Promise<string>((resolve) => {
          pending.current.set(id, (r) => resolve(r.text));
          post({ type: "renderMarkdown", reqId: id, state });
          // Fail open after 4s so an unresolvable note never hangs the send.
          setTimeout(() => {
            if (pending.current.delete(id)) resolve("");
          }, 4000);
        });
      },
      insert(text: string) {
        post({ type: "insert", text });
      },
      replace(text: string) {
        post({ type: "replace", text });
      },
      preview(state: string) {
        post({ type: "preview", state });
      },
      clearPreview() {
        post({ type: "clearPreview" });
      },
      applyUpdate(update: string) {
        // Apply to the authoritative RN-side doc; its "update" handler propagates
        // to the WebView, the sync server, and SQLite like any other edit.
        Y.applyUpdate(connection.doc, fromBase64(update));
      },
    }));

    useEffect(() => {
      const onUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === "webview") return; // don't bounce the WebView's own edits back
        post({ type: "update", update: toBase64(update) });
      };
      connection.doc.on("update", onUpdate);
      return () => {
        connection.doc.off("update", onUpdate);
      };
    }, [connection]);

    // AI status resolves after the WebView's initial `init`, so push the
    // slash-command gating whenever it changes (harmless before `ready`).
    useEffect(() => {
      post({ type: "config", editable, aiAvailable, aiFeatures });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editable, aiAvailable, JSON.stringify(aiFeatures)]);

    const onMessage = (e: WebViewMessageEvent) => {
      let msg: {
        type?: string;
        update?: string;
        level?: string;
        text?: string;
        selection?: string;
        reqId?: number;
        requestId?: number;
        q?: string;
        context?: string;
        id?: string;
        links?: OutgoingLinkInput[];
      };
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        post({
          type: "init",
          state: toBase64(Y.encodeStateAsUpdate(connection.doc)),
          user,
          editable,
          aiAvailable,
          aiFeatures,
        });
      } else if (msg.type === "update" && typeof msg.update === "string") {
        Y.applyUpdate(connection.doc, fromBase64(msg.update), "webview");
      } else if (msg.type === "text" && typeof msg.reqId === "number") {
        const resolve = pending.current.get(msg.reqId);
        if (resolve) {
          pending.current.delete(msg.reqId);
          resolve({ text: msg.text ?? "", selection: msg.selection ?? "" });
        }
      } else if (msg.type === "linkNoteQuery" && typeof msg.requestId === "number") {
        // /link-note: search on typing, recents (listDocuments, updated_at desc,
        // top 10) on empty query — the network + auth live here on the RN side.
        void handleLinkNoteQuery(msg.requestId, msg.q ?? "");
      } else if (msg.type === "aiSummarize" && typeof msg.requestId === "number") {
        // /ai-summarize: POST /ai/complete with intent "summarize".
        void handleAiSummarize(msg.requestId, msg.context ?? "");
      } else if (msg.type === "navigateToDoc" && typeof msg.id === "string") {
        cfg.current.onNavigateToDoc?.(msg.id);
      } else if (msg.type === "linksChanged" && Array.isArray(msg.links)) {
        // The editor re-scanned its "selfnote:<id>" links; report the full set.
        void handleLinksChanged(msg.links);
      } else if (msg.type === "console") {
        console.warn(`[webview:${msg.level}] ${msg.text}`);
      }
    };

    // /link-note ("@ / [[") data source: the link-search autocomplete
    // (docs/features/backlinks-graph.md §3.5 / §5), scoped to the workspace and
    // excluding archived docs + the note being edited. Network + auth live here.
    const handleLinkNoteQuery = async (requestId: number, q: string) => {
      const { workspaceId: ws, docId: self } = cfg.current;
      try {
        const docs: DocumentRef[] = await api.linkSearch(ws, q.trim(), self);
        post({
          type: "linkNoteResults",
          requestId,
          docs: docs.map((d) => ({ id: d.id, title: d.title, icon: d.icon })),
        });
      } catch {
        post({ type: "linkNoteResults", requestId, docs: [] });
      }
    };

    // The editor re-scanned its outgoing "selfnote:<id>" links; full-replace the
    // stored set via PUT /documents/:id/links (backlinks-graph.md §3.1/§5). This
    // piggybacks the editor's persistence cadence and simply flushes on reconnect
    // when offline (the next scan re-reports the same set).
    const handleLinksChanged = async (links: OutgoingLinkInput[]) => {
      const { docId: self, onLinksChanged, onError } = cfg.current;
      try {
        const count = await api.putDocLinks(self, links);
        onLinksChanged?.(count);
      } catch (e) {
        // Offline / transient: the next scan re-reports; a viewer (403) simply
        // can't write links. Surface only unexpected non-auth failures quietly.
        const status = (e as { status?: number }).status;
        if (status !== 403 && status !== 401) {
          onError?.("Couldn't save note links.");
        }
      }
    };

    // /ai-summarize data source (docs/features/editor-slash-commands.md §3.3).
    const handleAiSummarize = async (requestId: number, context: string) => {
      try {
        const { text } = await api.aiComplete({
          doc_id: cfg.current.docId,
          intent: "summarize",
          context,
        });
        post({ type: "aiSummarizeResult", requestId, text });
      } catch (e) {
        const status = (e as { status?: number }).status;
        const message =
          status === 409
            ? "AI isn't configured on this server."
            : "Couldn't summarize the note. Try again.";
        post({ type: "aiSummarizeError", requestId, message });
        cfg.current.onError?.(message);
      }
    };

    return (
      <WebView
        ref={ref}
        originWhitelist={["*"]}
        source={{ html: EDITOR_HTML }}
        onMessage={onMessage}
        webviewDebuggingEnabled
        style={{ flex: 1 }}
      />
    );
  },
);
