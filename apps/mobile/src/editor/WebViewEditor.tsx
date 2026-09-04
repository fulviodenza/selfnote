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
import { EDITOR_HTML } from "./editorHtml";

export interface EditorUser {
  name: string;
  color: string;
}

export interface EditorHandle {
  /** Current document as markdown/plain text (for AI context). */
  getText(): Promise<string>;
  /** Append text to the document (parsed from markdown). */
  insert(text: string): void;
}

export const WebViewEditor = forwardRef<EditorHandle, { connection: DocConnection; user: EditorUser }>(
  function WebViewEditor({ connection, user }, handleRef) {
    const ref = useRef<WebView>(null);
    const post = (obj: unknown) => ref.current?.postMessage(JSON.stringify(obj));

    // Pending getText requests, resolved when the WebView replies with the text.
    const pending = useRef(new Map<number, (text: string) => void>());
    const reqId = useRef(0);

    useImperativeHandle(handleRef, () => ({
      getText() {
        const id = ++reqId.current;
        return new Promise<string>((resolve) => {
          pending.current.set(id, resolve);
          post({ type: "getText", reqId: id });
          // Fail open after 4s so the panel never hangs.
          setTimeout(() => {
            if (pending.current.delete(id)) resolve("");
          }, 4000);
        });
      },
      insert(text: string) {
        post({ type: "insert", text });
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

    const onMessage = (e: WebViewMessageEvent) => {
      let msg: { type?: string; update?: string; level?: string; text?: string; reqId?: number };
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        post({ type: "init", state: toBase64(Y.encodeStateAsUpdate(connection.doc)), user });
      } else if (msg.type === "update" && typeof msg.update === "string") {
        Y.applyUpdate(connection.doc, fromBase64(msg.update), "webview");
      } else if (msg.type === "text" && typeof msg.reqId === "number") {
        const resolve = pending.current.get(msg.reqId);
        if (resolve) {
          pending.current.delete(msg.reqId);
          resolve(msg.text ?? "");
        }
      } else if (msg.type === "console") {
        console.warn(`[webview:${msg.level}] ${msg.text}`);
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
