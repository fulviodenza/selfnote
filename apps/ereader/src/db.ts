/**
 * The local store, which is authoritative.
 *
 * Selfnote sync is optional and additive: everything here works with no server
 * and no account, and `synced_at` is the only column that knows the difference.
 */
import * as SQLite from "expo-sqlite";
import * as FileSystem from "expo-file-system/legacy";

export interface Book {
  id: string;
  title: string;
  author: string | null;
  /**
   * Path RELATIVE to the document directory, e.g. "books/<id>.epub".
   *
   * Never absolute. iOS reassigns the app's container UUID on reinstall and on
   * some updates, so an absolute path stored today dangles tomorrow and the book
   * stops opening with a file-not-readable error. Resolve it through `bookUri`.
   */
  file_path: string;
  added_at: number;
  /**
   * epub.js locations index, cached as JSON. Building it parses every chapter,
   * which is seconds of CPU and a lot of garbage on a novel, so it is done once
   * and reused. Null until the first open finishes generating it.
   */
  locations: string | null;
  /** Set when the user marks the book finished; counted by the yearly goal. */
  finished_at: number | null;
  /** Orders the shelf and powers Continue Reading. */
  last_opened_at: number | null;
  /** Selfnote page this book's highlights go to, null until the user picks one. */
  sync_document_id: string | null;
  /** Remembered only so the UI can say where highlights are going. */
  sync_page_title: string | null;
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

/**
 * Absolute URI for a book, rebuilt against the CURRENT container every time.
 *
 * Tolerates rows written before `file_path` became relative: anything that still
 * looks absolute is reduced to its "books/<name>" tail and re-rooted, so an
 * existing shelf survives the change instead of silently losing every book.
 */
export function bookUri(book: Pick<Book, "file_path">): string {
  const dir = FileSystem.documentDirectory ?? "";
  const stored = book.file_path;
  if (!stored.startsWith("file://") && !stored.startsWith("/")) return dir + stored;
  const tail = stored.slice(stored.lastIndexOf("/books/") + 1);
  return dir + (tail.startsWith("books/") ? tail : `books/${stored.split("/").pop()}`);
}

let handle: SQLite.SQLiteDatabase | null = null;

export async function db(): Promise<SQLite.SQLiteDatabase> {
  if (handle) return handle;
  handle = await SQLite.openDatabaseAsync("ereader.db");
  await handle.execAsync(`
    pragma journal_mode = WAL;
    -- SQLite leaves foreign key enforcement OFF per connection, so every
    -- "on delete cascade" below was decorative until this line. Deleting a
    -- book is the first thing that depends on them actually firing.
    pragma foreign_keys = on;
    create table if not exists books (
      id        text primary key,
      title     text not null,
      author    text,
      file_path text not null,
      added_at  integer not null,
      locations text,
      sync_document_id text,
      sync_page_title  text
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
    create table if not exists reading_sessions (
      id         integer primary key autoincrement,
      book_id    text not null references books(id) on delete cascade,
      started_at integer not null,
      seconds    integer not null
    );
    create index if not exists sessions_started_idx on reading_sessions (started_at);
    create table if not exists settings (key text primary key, value text not null);
    -- Blank pages inserted into a book to work on with the Pencil. Deliberately
    -- not part of the book: nothing here feeds progress or reading goals.
    create table if not exists note_pages (
      id         text primary key,
      book_id    text not null references books(id) on delete cascade,
      after_page integer not null,
      position   integer not null default 0,
      strokes    text not null default '[]',
      created_at integer not null,
      updated_at integer not null
    );
    create index if not exists note_pages_book_idx
      on note_pages (book_id, after_page, position);
    create table if not exists reading_position (
      book_id    text primary key references books(id) on delete cascade,
      cfi        text not null,
      updated_at integer not null
    );
  `);
  // Added after the first release; `create table if not exists` will not add it
  // to a table that already exists.
  const cols = await handle.getAllAsync<{ name: string }>("pragma table_info(books)");
  for (const [name, decl] of [
    ["locations", "text"],
    ["sync_document_id", "text"],
    ["sync_page_title", "text"],
    ["finished_at", "integer"],
    ["last_opened_at", "integer"],
  ] as const) {
    if (!cols.some((c) => c.name === name)) {
      await handle.execAsync(`alter table books add column ${name} ${decl}`);
    }
  }
  return handle;
}

export async function saveLocations(bookId: string, locations: string): Promise<void> {
  await (await db()).runAsync("update books set locations = ? where id = ?", locations, bookId);
}

export async function listBooks(): Promise<Book[]> {
  // The book being read belongs on top; untouched books fall back to added order.
  return (await db()).getAllAsync<Book>(
    "select * from books order by coalesce(last_opened_at, added_at) desc",
  );
}

/** Remove the row; foreign keys cascade to highlights, position and sessions.
 * The caller deletes the file, because only it knows the resolved path. */
export async function deleteBookRow(id: string): Promise<void> {
  await (await db()).runAsync("delete from books where id = ?", id);
}

export async function setFinished(id: string, finished: boolean): Promise<void> {
  await (
    await db()
  ).runAsync("update books set finished_at = ? where id = ?", finished ? Date.now() : null, id);
}

export async function touchOpened(id: string): Promise<void> {
  await (await db()).runAsync("update books set last_opened_at = ? where id = ?", Date.now(), id);
}

/** The book reports its real title and author the first time it opens; keep
 * them, so the shelf stops showing the filename. */
export async function updateBookMeta(
  id: string,
  title: string,
  author: string | null,
): Promise<void> {
  if (!title.trim()) return;
  await (
    await db()
  ).runAsync("update books set title = ?, author = ? where id = ?", title.trim(), author, id);
}

/* ------------------------------------------------------- reading goals --- */

export async function recordSession(
  bookId: string,
  startedAt: number,
  seconds: number,
): Promise<void> {
  await (
    await db()
  ).runAsync(
    "insert into reading_sessions (book_id, started_at, seconds) values (?, ?, ?)",
    bookId,
    startedAt,
    seconds,
  );
}

export async function readingSecondsSince(since: number): Promise<number> {
  const row = await (
    await db()
  ).getFirstAsync<{ total: number | null }>(
    "select sum(seconds) as total from reading_sessions where started_at >= ?",
    since,
  );
  return row?.total ?? 0;
}

export async function booksFinishedSince(since: number): Promise<number> {
  const row = await (
    await db()
  ).getFirstAsync<{ n: number }>(
    "select count(*) as n from books where finished_at is not null and finished_at >= ?",
    since,
  );
  return row?.n ?? 0;
}

export async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const row = await (
    await db()
  ).getFirstAsync<{ value: string }>("select value from settings where key = ?", key);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function setNumberSetting(key: string, value: number): Promise<void> {
  await (
    await db()
  ).runAsync("insert or replace into settings (key, value) values (?, ?)", key, String(value));
}

export async function addBook(book: Book): Promise<void> {
  await (
    await db()
  ).runAsync(
    "insert or replace into books (id, title, author, file_path, added_at, locations) \
     values (?, ?, ?, ?, ?, ?)",
    book.id,
    book.title,
    book.author,
    book.file_path,
    book.added_at,
    book.locations,
  );
}

/** Point a book's highlights at a Selfnote page, or clear the target with null. */
export async function setSyncTarget(
  bookId: string,
  documentId: string | null,
  pageTitle: string | null,
): Promise<void> {
  await (
    await db()
  ).runAsync(
    "update books set sync_document_id = ?, sync_page_title = ? where id = ?",
    documentId,
    pageTitle,
    bookId,
  );
}

export async function getBook(id: string): Promise<Book | null> {
  return (await db()).getFirstAsync<Book>("select * from books where id = ?", id);
}

/** Highlights for a book that have not reached Selfnote yet. */
export async function unsyncedHighlights(bookId: string): Promise<Highlight[]> {
  return (await db()).getAllAsync<Highlight>(
    "select * from highlights where book_id = ? and synced_at is null order by created_at",
    bookId,
  );
}

export async function markSynced(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  const now = Date.now();
  const placeholders = ids.map(() => "?").join(",");
  await d.runAsync(
    `update highlights set synced_at = ? where id in (${placeholders})`,
    now,
    ...ids,
  );
}

/* --------------------------------------------------------- note pages --- */

export interface NotePage {
  id: string;
  book_id: string;
  after_page: number;
  position: number;
  /** JSON array of strokes, each {c, w, p:[[x,y,pressure],...]} in page fractions. */
  strokes: string;
  created_at: number;
  updated_at: number;
}

export async function listNotePages(bookId: string): Promise<NotePage[]> {
  return (await db()).getAllAsync<NotePage>(
    "select * from note_pages where book_id = ? order by after_page, position",
    bookId,
  );
}

/** Add a blank page after `afterPage`, stacking below any already there. */
export async function addNotePage(bookId: string, afterPage: number): Promise<NotePage> {
  const row = await (
    await db()
  ).getFirstAsync<{ n: number | null }>(
    "select max(position) as n from note_pages where book_id = ? and after_page = ?",
    bookId,
    afterPage,
  );
  const page: NotePage = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    book_id: bookId,
    after_page: afterPage,
    position: (row?.n ?? -1) + 1,
    strokes: "[]",
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await (
    await db()
  ).runAsync(
    "insert into note_pages (id, book_id, after_page, position, strokes, created_at, updated_at) \
     values (?, ?, ?, ?, ?, ?, ?)",
    page.id,
    page.book_id,
    page.after_page,
    page.position,
    page.strokes,
    page.created_at,
    page.updated_at,
  );
  return page;
}

export async function saveNoteStrokes(id: string, strokes: string): Promise<void> {
  await (
    await db()
  ).runAsync(
    "update note_pages set strokes = ?, updated_at = ? where id = ?",
    strokes,
    Date.now(),
    id,
  );
}

export async function deleteNotePage(id: string): Promise<void> {
  await (await db()).runAsync("delete from note_pages where id = ?", id);
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
