/**
 * @selfnote/core — platform-agnostic document/sync layer.
 *
 * Pure TypeScript, zero React/DOM-framework deps, so the exact same module powers
 * the web app, the Tauri desktop shell, and React Native. It wires a Yjs document
 * to a WebSocket sync provider and a pluggable local persistence layer, and exposes
 * a small connection-status API for the UI.
 */
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";

/** Yjs XML fragment name the editor binds to. Must match across all clients. */
export const FRAGMENT_NAME = "document-store";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "offline";

/**
 * Build a throwaway `Y.Doc` from an ordered list of base64 v1 Yjs updates (the
 * shape returned by `GET /documents/:id/content` and by a version-history
 * checkpoint's `updates`). Used to render a past state read-only without a live
 * sync connection — the caller owns the returned doc and must `destroy()` it.
 */
export function docFromUpdatesBase64(updates: string[]): Y.Doc {
  const doc = new Y.Doc();
  for (const u of updates) applyUpdateBase64(doc, u);
  return doc;
}

/**
 * Decode a standard-alphabet base64 v1 Yjs update (the API's convention) and
 * apply it to a doc. Used to converge the live editor immediately after a
 * version-history restore, without waiting for the update to round-trip the
 * sync socket.
 */
export function applyUpdateBase64(doc: Y.Doc, update: string): void {
  const bin = atob(update);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  Y.applyUpdate(doc, bytes);
}

/**
 * Local persistence for a document. Web uses IndexedDB; React Native provides a
 * SQLite-backed implementation. Both just need to hydrate the doc on start and
 * persist subsequent changes.
 */
export interface DocPersistence {
  /** Resolves once the stored state has been loaded into the doc. */
  whenSynced: Promise<unknown>;
  destroy(): void | Promise<void>;
}

export type PersistenceFactory = (docId: string, doc: Y.Doc) => DocPersistence;

/** Built-in IndexedDB persistence (browser / WebView). */
export const indexedDbPersistence: PersistenceFactory = (docId, doc) =>
  new IndexeddbPersistence(`selfnote:${docId}`, doc);

export interface CreateDocOptions {
  /** Base WebSocket URL, e.g. "ws://localhost:4444/ws". The doc id is appended. */
  serverUrl: string;
  /** Room token issued by the API; sent as a `?token=` query param. */
  token?: string;
  /** Provide a WebSocket implementation in non-browser runtimes (Node, RN). */
  WebSocketPolyfill?: typeof WebSocket;
  /**
   * Local persistence factory. `undefined` = auto (IndexedDB when available),
   * `null` = disabled, or pass a custom factory (e.g. SQLite on mobile).
   */
  persistence?: PersistenceFactory | null;
}

export interface DocConnection {
  readonly doc: Y.Doc;
  readonly provider: WebsocketProvider;
  readonly persistence: DocPersistence | null;
  readonly fragment: Y.XmlFragment;
  status(): ConnectionStatus;
  /** Subscribe to status changes; fires immediately with the current value. */
  onStatus(cb: (s: ConnectionStatus) => void): () => void;
  /** Subscribe to sync completion (true once the initial diff is applied). */
  onSynced(cb: (synced: boolean) => void): () => void;
  /** Simulate/force going offline (keeps editing locally). */
  goOffline(): void;
  /** Reconnect and resync. */
  goOnline(): void;
  destroy(): void;
}

/**
 * Create a live connection to a collaborative document.
 *
 * Local edits are persisted immediately (offline-first) and synced to the server
 * when connected. Conflict resolution is handled by the Yjs CRDT, so concurrent /
 * offline edits merge without loss.
 */
export function createDocConnection(docId: string, opts: CreateDocOptions): DocConnection {
  const doc = new Y.Doc();

  let factory = opts.persistence;
  if (factory === undefined) {
    factory = typeof indexedDB !== "undefined" ? indexedDbPersistence : null;
  }
  const persistence = factory ? factory(docId, doc) : null;

  const provider = new WebsocketProvider(opts.serverUrl, docId, doc, {
    connect: true,
    WebSocketPolyfill: opts.WebSocketPolyfill,
    params: opts.token ? { token: opts.token } : {},
  });

  const fragment = doc.getXmlFragment(FRAGMENT_NAME);

  let current: ConnectionStatus = "connecting";
  let manualOffline = false;
  const statusCbs = new Set<(s: ConnectionStatus) => void>();

  const emit = (s: ConnectionStatus) => {
    current = s;
    for (const cb of statusCbs) cb(s);
  };

  provider.on("status", (e: { status: ConnectionStatus }) => {
    if (manualOffline) return;
    emit(e.status);
  });

  return {
    doc,
    provider,
    persistence,
    fragment,
    status: () => current,
    onStatus(cb) {
      statusCbs.add(cb);
      cb(current);
      return () => {
        statusCbs.delete(cb);
      };
    },
    onSynced(cb) {
      const handler = (synced: boolean) => cb(synced);
      provider.on("sync", handler);
      return () => provider.off("sync", handler);
    },
    goOffline() {
      manualOffline = true;
      provider.disconnect();
      emit("offline");
    },
    goOnline() {
      manualOffline = false;
      provider.connect();
      emit("connecting");
    },
    destroy() {
      statusCbs.clear();
      provider.destroy();
      void persistence?.destroy();
      doc.destroy();
    },
  };
}
