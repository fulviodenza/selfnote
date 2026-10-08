/**
 * The local store, which is authoritative.
 *
 * Selfnote sync is optional and additive: everything here works with no server
 * and no account, and `synced_at` is the only column that knows the difference.
 */
import * as SQLite from "expo-sqlite";

export interface Book {
  id: string;
  title: string;
  author: string | null;
  file_path: string;
  added_at: number;
}

export interface Highlight {
  id: string;
  book_id: string;
  text: string;
  note: string | null;
  color: string | null;
  /** JSON: {cfi, spine} today, {page, quads} when PDF lands. Opaque to storage. */
  locator: string;
  created_at: number;
  synced_at: number | null;
}

let handle: SQLite.SQLiteDatabase | null = null;

export async function db(): Promise<SQLite.SQLiteDatabase> {
  if (handle) return handle;
  handle = await SQLite.openDatabaseAsync("ereader.db");
  await handle.execAsync(`
    pragma journal_mode = WAL;
    create table if not exists books (
      id        text primary key,
      title     text not null,
      author    text,
      file_path text not null,
      added_at  integer not null
    );
    create table if not exists highlights (
      id         text primary key,
      book_id    text not null references books(id) on delete cascade,
      text       text not null,
      note       text,
      color      text,
      locator    text not null,
      created_at integer not null,
      -- Nullable rather than a boolean so "never synced" and "synced at a known
      -- time" are distinguishable, which is what makes a sync log debuggable.
      synced_at  integer
    );
    create index if not exists highlights_book_idx on highlights (book_id);
    create table if not exists reading_position (
      book_id    text primary key references books(id) on delete cascade,
      cfi        text not null,
      updated_at integer not null
    );
  `);
  return handle;
}

export async function listBooks(): Promise<Book[]> {
  return (await db()).getAllAsync<Book>("select * from books order by added_at desc");
}

export async function addBook(book: Book): Promise<void> {
  await (
    await db()
  ).runAsync(
    "insert or replace into books (id, title, author, file_path, added_at) values (?, ?, ?, ?, ?)",
    book.id,
    book.title,
    book.author,
    book.file_path,
    book.added_at,
  );
}

export async function listHighlights(bookId: string): Promise<Highlight[]> {
  return (await db()).getAllAsync<Highlight>(
    "select * from highlights where book_id = ? order by created_at",
    bookId,
  );
}

/**
 * `id` is generated once here and never re-derived. The ingest endpoint keys its
 * idempotency ledger on it, so an id computed per sync (from a content hash, say)
 * would duplicate every highlight the first time its note was edited.
 */
export async function addHighlight(h: Highlight): Promise<void> {
  await (
    await db()
  ).runAsync(
    "insert into highlights (id, book_id, text, note, color, locator, created_at, synced_at) \
     values (?, ?, ?, ?, ?, ?, ?, ?)",
    h.id,
    h.book_id,
    h.text,
    h.note,
    h.color,
    h.locator,
    h.created_at,
    h.synced_at,
  );
}

export async function deleteHighlight(id: string): Promise<void> {
  await (await db()).runAsync("delete from highlights where id = ?", id);
}

export async function savePosition(bookId: string, cfi: string): Promise<void> {
  await (
    await db()
  ).runAsync(
    "insert or replace into reading_position (book_id, cfi, updated_at) values (?, ?, ?)",
    bookId,
    cfi,
    Date.now(),
  );
}

export async function loadPosition(bookId: string): Promise<string | null> {
  const row = await (
    await db()
  ).getFirstAsync<{ cfi: string }>("select cfi from reading_position where book_id = ?", bookId);
  return row?.cfi ?? null;
}
