/**
 * The reader screen: hosts the bundled reader document in a WebView and owns the
 * database side of the conversation. The page renders; this file decides what is
 * true.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import RNWebView, { type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
// The legacy entry point on purpose: it reads a file straight to base64 natively.
// The current File API exposes only arrayBuffer(), which would mean base64-encoding
// a multi-megabyte book in JS on the main thread every time it opens.
import * as FileSystem from "expo-file-system/legacy";
import { readerHtml } from "@selfnote/reader";
import { PagePicker } from "./PagePicker";
import { sendHighlights, type Connection } from "./selfnote";
import {
  addHighlight,
  bookUri,
  deleteHighlight,
  getBook,
  markSynced,
  setSyncTarget,
  unsyncedHighlights,
  listHighlights,
  loadPosition,
  saveLocations,
  savePosition,
  type Book,
  type Highlight,
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
  const [picking, setPicking] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const web = useRef<WebViewHandle>(null);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [progress, setProgress] = useState(0);

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
      const data = await FileSystem.readAsStringAsync(bookUri(book), {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (cancelled) return;
      post({ type: "open", data, locations: book.locations });
      const saved = await loadPosition(book.id);
      if (saved && !cancelled) post({ type: "goto", cfi: saved });
      const rows = await listHighlights(book.id);
      if (cancelled) return;
      setHighlights(rows);
      post({ type: "highlights", items: rows.map(toWire) });
    })().catch((err) => Alert.alert("Could not open this book", String(err)));
    return () => {
      cancelled = true;
    };
  }, [ready, book, post]);

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
      setSyncNote(res.applied > 0 ? `Sent ${res.applied}` : null);
    } catch (e) {
      // Staying unsynced is the correct outcome of a failure: the next highlight,
      // or reopening the book, retries the whole backlog.
      setSyncNote(`Not sent: ${e instanceof Error ? e.message : String(e)}`);
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
          return;
        case "location":
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
            locator: JSON.stringify({ cfi: msg.cfi }),
            created_at: Date.now(),
            synced_at: null,
          };
          await addHighlight(row);
          const rows = await listHighlights(book.id);
          setHighlights(rows);
          post({ type: "highlights", items: rows.map(toWire) });
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
                post({ type: "highlights", items: rows.map(toWire) });
              },
            },
          ]);
          return;
        }
        case "error":
          console.warn(`[reader:${msg.where}]`, msg.message);
          return;
      }
    },
    [book, highlights, post, pushPending],
  );

  if (picking && connection) {
    return (
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
    );
  }

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
      <WebView
        ref={web}
        source={{ html: readerHtml }}
        originWhitelist={["*"]}
        onMessage={onMessage}
        // The document is local and needs no network; blocking it means a book
        // that phones home cannot.
        javaScriptEnabled
        allowFileAccess={false}
        style={styles.fill}
      />
      {loading && (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}

function toWire(h: Highlight) {
  let cfi = "";
  try {
    cfi = JSON.parse(h.locator).cfi ?? "";
  } catch {
    /* a locator we cannot read just does not draw */
  }
  return { id: h.id, cfi, color: h.color };
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
