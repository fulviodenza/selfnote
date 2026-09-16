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
/**
 * Labels that still tag at least one active document. Shared by the web and
 * mobile sidebars so the filter chips stay in lockstep across platforms:
 * shelving a label's last page hides its chip.
 */
export function activeUsedLabels<L extends { id: string }>(
  labels: L[],
  docLabelIds: ReadonlyMap<string, Iterable<string>>,
  activeDocIds: ReadonlySet<string>,
): L[] {
  const used = new Set<string>();
  for (const [docId, ids] of docLabelIds) {
    if (!activeDocIds.has(docId)) continue;
    for (const id of ids) used.add(id);
  }
  return labels.filter((l) => used.has(l.id));
}

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
  const statusCbs = new Set<(s: ConnectionStatus) => void>();

  const emit = (s: ConnectionStatus) => {
    current = s;
    for (const cb of statusCbs) cb(s);
  };

  provider.on("status", (e: { status: ConnectionStatus }) => {
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
    goOnline() {
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

/* ------------------------------------------------------- page moves ------- */

/** The minimum a page needs to take part in a move. */
export interface MovablePage {
  id: string;
  parent_id: string | null;
  position: number;
}

/** Where a drop lands relative to the row under the cursor. */
export type DropPlacement = "before" | "after" | "inside";

/** The patch a move produces: both fields, always, so the write is atomic. */
export interface MoveResult {
  parent_id: string | null;
  position: number;
}

/**
 * True when `target` is `page` itself or one of its descendants.
 *
 * Dropping a page into its own subtree would strand that subtree: the tree is
 * only ever rendered from the root, so it vanishes while its rows remain, and
 * the server's recursive shelf query would follow the cycle. The server rejects
 * it too; this exists so the UI can refuse the drop rather than let the user
 * make a gesture that is going to fail.
 */
export function isSelfOrDescendant(
  pages: readonly MovablePage[],
  pageId: string,
  targetId: string,
): boolean {
  if (pageId === targetId) return true;
  const childrenOf = new Map<string | null, MovablePage[]>();
  for (const p of pages) {
    const list = childrenOf.get(p.parent_id) ?? [];
    list.push(p);
    childrenOf.set(p.parent_id, list);
  }
  const stack = [...(childrenOf.get(pageId) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (next.id === targetId) return true;
    stack.push(...(childrenOf.get(next.id) ?? []));
  }
  return false;
}

/** Siblings under `parentId`, in display order, excluding `excludeId`. */
function siblingsOf(
  pages: readonly MovablePage[],
  parentId: string | null,
  excludeId: string,
): MovablePage[] {
  return pages
    .filter((p) => p.parent_id === parentId && p.id !== excludeId)
    .sort((a, b) => a.position - b.position);
}

/**
 * The midpoint between two positions, which is what makes a reorder a
 * single-row write: no sibling but the moved one ever changes.
 *
 * Repeatedly halving the same gap exhausts float precision after roughly 50
 * insertions between one pair, at which point the two compare equal and the
 * server's `created_at` tiebreaker decides. That is far beyond real use and the
 * failure is benign, so there is no renormalisation pass; it is written down
 * here so the limit is known rather than discovered.
 */
function between(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/**
 * Work out the patch for dropping `pageId` relative to `targetId`.
 *
 * Returns null when the move is not allowed (into its own subtree) or would
 * change nothing, so callers can skip the request entirely rather than send a
 * write that is either rejected or pointless.
 */
export function computeMove(
  pages: readonly MovablePage[],
  pageId: string,
  targetId: string | null,
  placement: DropPlacement,
): MoveResult | null {
  const page = pages.find((p) => p.id === pageId);
  if (!page) return null;

  // Dropping on empty space below the tree: move to the top level, at the end.
  if (targetId === null) {
    const roots = siblingsOf(pages, null, pageId);
    if (page.parent_id === null && roots[roots.length - 1]?.position === undefined) return null;
    return { parent_id: null, position: between(roots[roots.length - 1]?.position, undefined) };
  }

  if (isSelfOrDescendant(pages, pageId, targetId)) return null;
  const target = pages.find((p) => p.id === targetId);
  if (!target) return null;

  if (placement === "inside") {
    const kids = siblingsOf(pages, targetId, pageId);
    return { parent_id: targetId, position: between(kids[kids.length - 1]?.position, undefined) };
  }

  const sibs = siblingsOf(pages, target.parent_id, pageId);
  const i = sibs.findIndex((p) => p.id === targetId);
  if (i === -1) return null;
  const [before, after] =
    placement === "before"
      ? [sibs[i - 1]?.position, sibs[i].position]
      : [sibs[i].position, sibs[i + 1]?.position];
  const position = between(before, after);
  // Nothing to do when the page is already exactly there.
  if (page.parent_id === target.parent_id && page.position === position) return null;
  return { parent_id: target.parent_id, position };
}
