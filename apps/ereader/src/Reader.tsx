/**
 * The reader screen: hosts the bundled reader document in a WebView and owns the
 * database side of the conversation. The page renders; this file decides what is
 * true.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import RNWebView, { type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
// The legacy entry point on purpose: it reads a file straight to base64 natively.
// The current File API exposes only arrayBuffer(), which would mean base64-encoding
// a multi-megabyte book in JS on the main thread every time it opens.
import * as FileSystem from "expo-file-system/legacy";
import { pdfReaderHtml, readerHtml } from "@selfnote/reader";

/** Stable identity on purpose: a fresh {html} object per render invites the
 * WebView to treat a re-render as a navigation. */
const READER_SOURCE = { html: readerHtml };
const PDF_SOURCE = { html: pdfReaderHtml };
import { PagePicker } from "./PagePicker";
import { sendHighlights, type Connection } from "./selfnote";
import {
  addHighlight,
  bookUri,
  deleteHighlight,
  addNotePage,
  deleteNotePage,
  getBook,
  listNotePages,
  markSynced,
  saveNoteStrokes,
  setSyncTarget,
  unsyncedHighlights,
  listHighlights,
  loadPosition,
  recordSession,
  saveLocations,
  savePosition,
  touchOpened,
  updateBookMeta,
  type Book,
  type Highlight,
  type NotePage,
} from "./db";

/** What we actually call on the WebView instance. */
interface WebViewHandle {
  injectJavaScript: (js: string) => void;
}

/**
 * react-native-webview 14.0.1 declares `class WebView<P = undefined> extends
 * Component<WebViewProps & P>`, and `WebViewProps & undefined` collapses to
 * `never`, so every prop fails to typecheck against the default generic. This
 * restores the real prop type. Upstream typing bug, not a local one.
 */
const WebView = RNWebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<WebViewHandle> }
>;

export function Reader({
  book: initialBook,
  connection,
  onClose,
}: {
  book: Book;
  connection: Connection | null;
  onClose: () => void;
}) {
  // Kept in state because picking a sync target changes the row underneath us.
  const [book, setBook] = useState<Book>(initialBook);
  const bookRef = useRef(book);
  bookRef.current = book;
  const [picking, setPicking] = useState(false);
  const [syncNote, setSyncNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const web = useRef<WebViewHandle>(null);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStart = useRef(Date.now());
  /** The book page showing, which stays put while stepping through inserts. */
  const currentPage = useRef(1);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [progress, setProgress] = useState(0);
  const pendingCount = highlights.filter((h) => h.synced_at === null).length;
  const isPdf = book.file_path.toLowerCase().endsWith(".pdf");
  const [notePages, setNotePages] = useState<NotePage[]>([]);
  // Which insert is showing, if any. The reader reports it with every location.
  const [onNote, setOnNote] = useState<string | null>(null);
  const [noteTool, setNoteTool] = useState<"pen" | "eraser">("pen");
  const syncing = Boolean(connection && book.sync_document_id);

  const post = useCallback((msg: unknown) => {
    const json = JSON.stringify(msg).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    web.current?.injectJavaScript(`window.selfnoteReader.receive('${json}');true;`);
  }, []);

  // Send the book once the page says it is listening. Doing this on WebView load
  // instead races the bundle's own startup and silently drops the message.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const current = bookRef.current;
      const data = await FileSystem.readAsStringAsync(bookUri(current), {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (cancelled) return;
      const saved = await loadPosition(current.id);
      if (cancelled) return;
      if (isPdf) {
        // A PDF position is its page number, carried with the open itself.
        post({ type: "open", data, position: saved ? Number(saved) : null });
      } else {
        post({ type: "open", data, locations: current.locations });
        if (saved) post({ type: "goto", cfi: saved });
      }
      if (isPdf) {
        const pages = await listNotePages(current.id);
        if (cancelled) return;
        setNotePages(pages);
        post({ type: "notes", items: pages });
      }
      const rows = await listHighlights(book.id);
      if (cancelled) return;
      setHighlights(rows);
      post({ type: "highlights", items: rows.map((h) => toWire(h, syncing, isPdf)) });
    })().catch((err) => Alert.alert("Could not open this book", String(err)));
    return () => {
      cancelled = true;
    };
    // book.id only: see bookRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, book.id, post]);

  // Turning sync off (or on) changes what the colours mean, so repaint. Without
  // this, clearing a book's target leaves green marks claiming to be saved to a
  // page the book is no longer pointed at.
  useEffect(() => {
    if (!ready || !highlights.length) return;
    post({ type: "highlights", items: highlights.map((h) => toWire(h, syncing, isPdf)) });
    // Only on a change of sync state: re-posting on every highlights change would
    // undo the incremental drawing the page does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing, ready]);

  useEffect(() => {
    if (syncNote?.kind !== "ok") return;
    const t = setTimeout(() => setSyncNote(null), 2500);
    return () => clearTimeout(t);
  }, [syncNote]);

  // Reading time counts while the reader is mounted and the app foregrounded.
  // Sessions are flushed on unmount and on backgrounding, and restart when the
  // app comes back, so nothing ever ticks while the iPad is asleep. Under five
  // seconds is noise, not reading.
  useEffect(() => {
    void touchOpened(book.id);
    const flush = () => {
      const secs = Math.round((Date.now() - sessionStart.current) / 1000);
      sessionStart.current = Date.now();
      if (secs >= 5) void recordSession(book.id, Date.now() - secs * 1000, secs);
    };
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") sessionStart.current = Date.now();
      else flush();
    });
    return () => {
      flush();
      sub.remove();
    };
  }, [book.id]);

  // Flush any pending position write when the reader closes, so stepping back to
  // the shelf does not drop the last page turn.
  useEffect(
    () => () => {
      if (positionTimer.current) clearTimeout(positionTimer.current);
    },
    [],
  );

  const pushPending = useCallback(async () => {
    if (!connection || !book.sync_document_id) return;
    const pending = await unsyncedHighlights(book.id);
    if (!pending.length) return;
    try {
      const res = await sendHighlights(
        connection,
        book.sync_document_id,
        { key: book.id, title: book.title, author: book.author },
        pending.map((h) => ({
          id: h.id,
          text: h.text,
          note: h.note,
          locator: h.locator ? JSON.parse(h.locator) : null,
        })),
      );
      await markSynced(pending.map((h) => h.id));
      const after = await listHighlights(book.id);
      setHighlights(after);
      // Repaint: those highlights are green now, and the page cannot know that.
      post({ type: "highlights", items: after.map((h) => toWire(h, true, isPdf)) });
      if (res.applied > 0) {
        setSyncNote({ kind: "ok", text: `Sent ${res.applied} to ${book.sync_page_title}` });
      }
    } catch (e) {
      // Staying unsynced is the correct outcome of a failure: the next highlight,
      // or reopening the book, retries the whole backlog.
      setSyncNote({ kind: "bad", text: e instanceof Error ? e.message : String(e) });
    }
  }, [connection, book]);

  // Flush the backlog when the book opens, so highlights made offline catch up.
  useEffect(() => {
    void pushPending();
  }, [pushPending]);

  const onMessage = useCallback(
    async (e: WebViewMessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          setReady(true);
          return;
        case "opened":
          setLoading(false);
          // The book knows its own name; the shelf should stop showing the
          // filename from the moment that is true.
          if (typeof msg.title === "string" && msg.title.trim()) {
            void updateBookMeta(book.id, msg.title, msg.author ?? null);
            setBook((b) => ({ ...b, title: msg.title.trim(), author: msg.author ?? b.author }));
          }
          return;
        case "noteStrokes":
          void saveNoteStrokes(msg.id, msg.strokes);
          return;
        case "location":
          setOnNote(msg.noteId ?? null);
          if (isPdf && msg.cfi) currentPage.current = Number(msg.cfi) || 1;
          setProgress(msg.progress ?? 0);
          // Debounced: "relocated" fires on every page turn, and writing to
          // SQLite that often spins the disk for a value only the next launch
          // reads. Losing at most a second of progress on a hard kill is a fair
          // trade for not writing once per page.
          if (msg.cfi) {
            if (positionTimer.current) clearTimeout(positionTimer.current);
            const cfi = msg.cfi;
            positionTimer.current = setTimeout(() => void savePosition(book.id, cfi), 1000);
          }
          return;
        case "locationsReady":
          // Generated rather than loaded from cache, so store it: the next open
          // of this book skips parsing every chapter.
          if (msg.locations) void saveLocations(book.id, msg.locations);
          return;
        case "selection": {
          const row: Highlight = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            book_id: book.id,
            text: msg.text,
            note: null,
            color: "#f6d365",
            locator: JSON.stringify(msg.locator ?? { cfi: msg.cfi }),
            created_at: Date.now(),
            synced_at: null,
          };
          await addHighlight(row);
          const rows = await listHighlights(book.id);
          setHighlights(rows);
          post({ type: "highlights", items: rows.map((h) => toWire(h, syncing, isPdf)) });
          void pushPending();
          return;
        }
        case "highlightTapped": {
          const hit = highlights.find((h) => h.id === msg.id);
          if (!hit) return;
          Alert.alert(hit.text, undefined, [
            { text: "Keep", style: "cancel" },
            {
              text: "Remove",
              style: "destructive",
              onPress: async () => {
                await deleteHighlight(hit.id);
                const rows = await listHighlights(book.id);
                setHighlights(rows);
                post({ type: "highlights", items: rows.map((h) => toWire(h, syncing, isPdf)) });
              },
            },
          ]);
          return;
        }
        case "error":
          console.warn(`[reader:${msg.where}]`, msg.message);
          setSyncNote({ kind: "bad", text: `${msg.where}: ${msg.message}` });
          return;
      }
    },
    [book, highlights, post, pushPending],
  );

  const insertNotePage = useCallback(async () => {
    // currentPage is tracked from the reader's own location messages, so the
    // insert lands after the page actually on screen.
    const page = await addNotePage(book.id, currentPage.current);
    const pages = await listNotePages(book.id);
    setNotePages(pages);
    post({ type: "notes", items: pages });
    post({ type: "showNote", id: page.id });
  }, [book.id, post]);

  const removeNotePage = useCallback(() => {
    if (!onNote) return;
    Alert.alert("Delete this page?", "Anything written on it is removed.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteNotePage(onNote);
          const pages = await listNotePages(book.id);
          setNotePages(pages);
          post({ type: "notes", items: pages });
        },
      },
    ]);
  }, [book.id, onNote, post]);

  return (
    <View style={styles.fill}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Text style={styles.action}>Library</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={styles.title}>
          {book.title}
        </Text>
        {connection ? (
          <TouchableOpacity onPress={() => setPicking(true)} hitSlop={10}>
            <Text style={styles.syncTarget} numberOfLines={1}>
              {book.sync_page_title ? `→ ${book.sync_page_title}` : "Send highlights"}
            </Text>
          </TouchableOpacity>
        ) : null}
        <Text style={styles.meta}>
          {highlights.length > 0 ? `${highlights.length} ` : ""}
          {Math.round(progress * 100)}%
        </Text>
      </View>
      {/* The strip OVERLAYS the book instead of sitting above it in the layout.
          In normal flow its appearance shrank the WebView (epub.js repaginated,
          which read as a reload) and its auto-hide grew it back seconds later,
          snapping the book to the start of the section: a page turn nobody
          asked for. Status must never change the book's geometry. */}
      <View style={styles.bookArea}>
        <WebView
          ref={web}
          source={isPdf ? PDF_SOURCE : READER_SOURCE}
          originWhitelist={["*"]}
          onMessage={onMessage}
          // The document is local and needs no network; blocking it means a book
          // that phones home cannot.
          javaScriptEnabled
          allowFileAccess={false}
          // The document never scrolls natively: the PDF page scrolls an inner
          // div and EPUB paginates. Left enabled, the scroll view's pan and
          // bounce recognizers compete for every touch, and when one claims
          // the Pencil the page gets a pointercancel and the stroke dies
          // mid-word.
          scrollEnabled={false}
          bounces={false}
          style={styles.fill}
        />
        {syncNote || (connection && book.sync_document_id && pendingCount > 0) ? (
          <View
            style={[styles.strip, styles.stripOverlay, syncNote?.kind === "bad" && styles.stripBad]}
          >
            <Text style={[styles.stripText, syncNote?.kind === "bad" && styles.stripTextBad]}>
              {syncNote
                ? syncNote.text
                : `${pendingCount} highlight${pendingCount === 1 ? "" : "s"} waiting to send`}
            </Text>
            {syncNote?.kind === "bad" ? (
              <TouchableOpacity onPress={() => void pushPending()} hitSlop={10}>
                <Text style={styles.retry}>Retry</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
      {loading && (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      )}
      <View style={styles.pager}>
        <TouchableOpacity
          style={styles.pageBtn}
          onPress={() => post({ type: "turn", direction: "prev" })}
          hitSlop={14}
          accessibilityLabel="Previous page"
        >
          <Text style={styles.chevron}>‹</Text>
        </TouchableOpacity>

        {onNote ? (
          // On an insert the middle of the bar becomes its tools: there is
          // nothing to select or highlight on a blank page.
          <View style={styles.noteTools}>
            <TouchableOpacity
              style={[styles.toolBtn, noteTool === "pen" && styles.toolOn]}
              onPress={() => {
                setNoteTool("pen");
                post({ type: "noteTool", tool: "pen" });
              }}
            >
              <Text style={[styles.toolText, noteTool === "pen" && styles.toolTextOn]}>Pen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolBtn, noteTool === "eraser" && styles.toolOn]}
              onPress={() => {
                setNoteTool("eraser");
                post({ type: "noteTool", tool: "eraser" });
              }}
            >
              <Text style={[styles.toolText, noteTool === "eraser" && styles.toolTextOn]}>
                Eraser
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.toolBtn} onPress={() => post({ type: "noteUndo" })}>
              <Text style={styles.toolText}>Undo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.toolBtn} onPress={removeNotePage}>
              <Text style={[styles.toolText, styles.toolDanger]}>Delete page</Text>
            </TouchableOpacity>
          </View>
        ) : isPdf ? (
          <TouchableOpacity style={styles.addPageBtn} onPress={insertNotePage}>
            <Text style={styles.addPageText}>+ Blank page</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.pagerHint}>Swipe to turn. Select text, then tap Save highlight.</Text>
        )}

        <TouchableOpacity
          style={styles.pageBtn}
          onPress={() => post({ type: "turn", direction: "next" })}
          hitSlop={14}
          accessibilityLabel="Next page"
        >
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      </View>
      {picking && connection ? (
        <View style={styles.overlay}>
          <PagePicker
            connection={connection}
            bookTitle={book.title}
            current={
              book.sync_document_id && book.sync_page_title
                ? { id: book.sync_document_id, title: book.sync_page_title }
                : null
            }
            onClose={() => setPicking(false)}
            onPicked={async (page) => {
              await setSyncTarget(book.id, page?.id ?? null, page?.title ?? null);
              const fresh = await getBook(book.id);
              if (fresh) setBook(fresh);
              setPicking(false);
              if (page) void pushPending();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * On the page, a highlight's colour says whether it has reached Selfnote: amber
 * while it is still only on this device, green once the page has it.
 *
 * When a book has no sync target there is nothing to be waiting for, so amber is
 * just the highlight colour and means nothing more than "highlighted". Showing
 * every highlight as permanently unsent would be a warning about a thing the user
 * never asked for.
 */
const PENDING = "#f2c94c";
const SAVED = "#6fcf97";

function toWire(h: Highlight, syncing: boolean, isPdf = false) {
  const color = syncing && h.synced_at ? SAVED : PENDING;
  try {
    const locator = JSON.parse(h.locator);
    return isPdf ? { id: h.id, locator, color } : { id: h.id, cfi: locator.cfi ?? "", color };
  } catch {
    /* a locator we cannot read just does not draw */
    return isPdf ? { id: h.id, locator: null, color } : { id: h.id, cfi: "", color };
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#faf5ef" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 18,
    paddingTop: 58,
    paddingBottom: 12,
    backgroundColor: "#faf5ef",
  },
  action: { fontSize: 16, color: "#3730c4", fontWeight: "600" },
  title: { flex: 1, fontSize: 15, color: "#1b1b1b", fontWeight: "600" },
  meta: { fontSize: 13, color: "#6b6b6b", fontVariant: ["tabular-nums"] },
  pager: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 22, paddingTop: 8, paddingBottom: 26,
    backgroundColor: "#faf5ef",
  },
  noteTools: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, justifyContent: "center" },
  toolBtn: {
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 9,
    backgroundColor: "#f2ece3", borderWidth: 1, borderColor: "#e4dbcd",
  },
  toolOn: { backgroundColor: "#2b4162", borderColor: "#2b4162" },
  toolText: { fontSize: 13, fontWeight: "600", color: "#2b4162" },
  toolTextOn: { color: "#fff" },
  toolDanger: { color: "#8c2f27" },
  addPageBtn: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10,
    backgroundColor: "#f2ece3", borderWidth: 1, borderColor: "#e4dbcd",
  },
  addPageText: { fontSize: 14, fontWeight: "600", color: "#2b4162" },
  pageBtn: {
    width: 54, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: "#f2ece3", borderWidth: 1, borderColor: "#e4dbcd",
  },
  chevron: { fontSize: 26, lineHeight: 30, color: "#2b4162", fontWeight: "600" },
  pagerHint: { fontSize: 12, color: "#9a9183" },
  overlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "#faf5ef",
  },
  bookArea: { flex: 1 },
  stripOverlay: { position: "absolute", top: 0, left: 0, right: 0 },
  strip: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 18, paddingVertical: 9, backgroundColor: "#eef3ea",
    borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#dde5d6",
  },
  stripBad: { backgroundColor: "#fdeceb", borderColor: "#f3cfcc" },
  stripText: { fontSize: 13, color: "#44603a", flex: 1 },
  stripTextBad: { color: "#8c2f27" },
  retry: { fontSize: 13, fontWeight: "700", color: "#8c2f27", paddingLeft: 14 },
  syncTarget: { fontSize: 13, color: "#3730c4", fontWeight: "600", maxWidth: 220 },
  loading: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
