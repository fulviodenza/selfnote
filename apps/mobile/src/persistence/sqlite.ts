/**
 * SQLite-backed local persistence for React Native, plugged into @selfnote/core's
 * `PersistenceFactory` interface — the mobile counterpart to IndexedDB on web.
 *
 * Strategy: hydrate the doc from the last saved full state on start, then debounce
 * a full-state write on every change. Simple and robust for a client-side cache;
 * the server keeps the authoritative append-only log.
 */
import * as SQLite from "expo-sqlite";
import * as Y from "yjs";
import { fromBase64, toBase64 } from "lib0/buffer";
import type { DocPersistence, PersistenceFactory } from "@selfnote/core";

export const sqlitePersistence: PersistenceFactory = (docId, doc): DocPersistence => {
  let db: SQLite.SQLiteDatabase | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const persist = () => {
    if (!db || destroyed) return;
    const state = toBase64(Y.encodeStateAsUpdate(doc));
    db.runAsync("INSERT OR REPLACE INTO ydoc (id, state) VALUES (?, ?)", docId, state).catch(
      () => undefined,
    );
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  };

  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === "sqlite") return; // don't re-save our own hydration
    scheduleSave();
  };

  const whenSynced = (async () => {
    db = await SQLite.openDatabaseAsync("selfnote.db");
    await db.execAsync("CREATE TABLE IF NOT EXISTS ydoc (id TEXT PRIMARY KEY, state TEXT)");
    const row = await db.getFirstAsync<{ state: string }>(
      "SELECT state FROM ydoc WHERE id = ?",
      docId,
    );
    if (row?.state) {
      Y.applyUpdate(doc, fromBase64(row.state), "sqlite");
    }
    doc.on("update", onUpdate);
  })();

  return {
    whenSynced,
    async destroy() {
      destroyed = true;
      if (saveTimer) clearTimeout(saveTimer);
      doc.off("update", onUpdate);
      persist();
    },
  };
};
