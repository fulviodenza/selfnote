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

const DB_NAME = "selfnote.db";

/** Open the cache database and make sure the ydoc table exists. */
async function openDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync("CREATE TABLE IF NOT EXISTS ydoc (id TEXT PRIMARY KEY, state TEXT)");
  return db;
}

/**
 * Read a doc's last-saved full Yjs state (base64) from the local cache, or null
 * if it was never opened on this device. Used to resolve *other* notes' bodies
 * to Markdown for the AI's extra-context, without opening each one.
 */
export async function loadCachedState(docId: string): Promise<string | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ state: string }>(
      "SELECT state FROM ydoc WHERE id = ?",
      docId,
    );
    return row?.state ?? null;
  } catch {
    return null;
  }
}

/**
 * Read several docs' last-saved states in one go, as an id -> state map (ids
 * with nothing cached are simply absent). The tab switcher reads a preview per
 * open tab, and doing that through `loadCachedState` would open the database
 * once per tab; this opens it once.
 */
export async function loadCachedStates(
  docIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (docIds.length === 0) return out;
  try {
    const db = await openDb();
    const holes = docIds.map(() => "?").join(", ");
    const rows = await db.getAllAsync<{ id: string; state: string }>(
      `SELECT id, state FROM ydoc WHERE id IN (${holes})`,
      ...docIds,
    );
    for (const row of rows) out.set(row.id, row.state);
  } catch {
    /* nothing cached on this device */
  }
  return out;
}

/**
 * Delete the on-device note cache (Settings → "Delete all data on this phone").
 * Dropping the table instead of the database file keeps any open connection
 * valid; the file itself stays but holds nothing.
 */
export async function wipeLocalCache(): Promise<void> {
  try {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync("DROP TABLE IF EXISTS ydoc");
  } catch {
    /* nothing cached on this device */
  }
}

export const sqlitePersistence: PersistenceFactory = (docId, doc): DocPersistence => {
  let db: SQLite.SQLiteDatabase | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  // True once the cached state has been applied to `doc`. Until then the doc
  // does not contain the cached history, so writing it back would not be a
  // save: it would be an erasure. See destroy().
  let hydrated = false;

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
    const opened = await openDb();
    // Teardown can land inside this window (open + hydrate is not instant, and
    // @selfnote/core calls destroy() without awaiting, then destroys the doc).
    // Touching `doc` past that point would hydrate and attach a listener to a
    // Y.Doc that no longer exists.
    if (destroyed) return;
    db = opened;
    const row = await opened.getFirstAsync<{ state: string }>(
      "SELECT state FROM ydoc WHERE id = ?",
      docId,
    );
    if (destroyed) return;
    if (row?.state) {
      Y.applyUpdate(doc, fromBase64(row.state), "sqlite");
    }
    hydrated = true;
    doc.on("update", onUpdate);
  })();

  return {
    whenSynced,
    async destroy() {
      if (saveTimer) clearTimeout(saveTimer);
      doc.off("update", onUpdate);
      if (destroyed) return;
      /*
       * Only ever flush a hydrated doc. Leaving a page before the open and
       * SELECT resolve means `doc` never received the cached state, so it holds
       * at most this session's edits; an INSERT OR REPLACE of that would
       * overwrite a good cache with a near-empty one and lose the page's
       * offline body. Those few edits are not dropped on the floor either: they
       * have already gone to the server over the socket.
       */
      if (!hydrated) {
        destroyed = true;
        return;
      }
      /*
       * Encode synchronously, write asynchronously. The caller does not await
       * this and destroys the doc immediately after, so the state has to be
       * read out before yielding, and the write cannot assume `db` is still the
       * only route to the database.
       */
      const state = toBase64(Y.encodeStateAsUpdate(doc));
      destroyed = true;
      try {
        const target = db ?? (await openDb());
        await target.runAsync(
          "INSERT OR REPLACE INTO ydoc (id, state) VALUES (?, ?)",
          docId,
          state,
        );
      } catch {
        /* nothing to do on the way out */
      }
    },
  };
};
