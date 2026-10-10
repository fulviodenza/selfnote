/**
 * The reader screen: hosts the bundled reader document in a WebView and owns the
 * database side of the conversation. The page renders; this file decides what is
 * true.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import RNWebView, { type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
// The legacy entry point on purpose: it reads a file straight to base64 natively.
// The current File API exposes only arrayBuffer(), which would mean base64-encoding
// a multi-megabyte book in JS on the main thread every time it opens.
import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { captureRef } from "react-native-view-shot";
import { pdfReaderHtml, readerHtml } from "@selfnote/reader";

/** Stable identity on purpose: a fresh {html} object per render invites the
 * WebView to treat a re-render as a navigation. */
const READER_SOURCE = { html: readerHtml };
const PDF_SOURCE = { html: pdfReaderHtml };
import { PagePicker } from "./PagePicker";
// Ink goes through PencilKit, not the WebView: pointer events in WKWebView are
// batched to display rate with no low-latency path, which reads as lag under a
// Pencil, and the web view's internal recognizers can still swallow touches.
import { PencilPageView, type PencilChange } from "../modules/pencil-page";
import { sendHighlights, type Connection } from "./selfnote";
import {
  addHighlight,
  bookUri,
  deleteHighlight,
  addNotePage,
  docUri,
  deleteNotePage,
  getBook,
  getNumberSetting,
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
  setNumberSetting,
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

/** A page region copied onto an insert. The box is in fractions of the paper,
 * the file relative to the documents directory. */
interface NoteImage {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The paper's inset inside the book area: the notePaper style and the
 * fallback for placing an image before the paper has ever been laid out. */
const PAPER_INSET = { x: 28, y: 12 };
const IMAGE_GAP = 0.02;

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
  /** The EPUB spine section showing, or the section of the insert showing. */
  const currentSection = useRef(0);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [progress, setProgress] = useState(0);
  const pendingCount = highlights.filter((h) => h.synced_at === null).length;
  const isPdf = book.file_path.toLowerCase().endsWith(".pdf");
  const [notePages, setNotePages] = useState<NotePage[]>([]);
  const notePagesRef = useRef(notePages);
  notePagesRef.current = notePages;
  // Which insert is showing, if any. The reader reports it with every location.
  const [onNote, setOnNote] = useState<string | null>(null);
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
        // The pinched text size rides on the open, so the first layout is
        // already at it.
        const pct = await getNumberSetting(`fontsize:${current.id}`, 0);
        if (cancelled) return;
        post({ type: "open", data, locations: current.locations, fontSize: pct || null });
        if (saved) post({ type: "goto", cfi: saved });
      }
      const pages = await listNotePages(current.id);
      if (cancelled) return;
      setNotePages(pages);
      post({ type: "notes", items: pages });
      const rows = await listHighlights(book.id);
      if (cancelled) return;
      setHighlights(rows);
      setMarksLoaded(true);
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

  // How to highlight, said once when an EPUB with none opens. On the status
  // strip because it overlays the book: a hint line of its own in the layout
  // would resize the WebView and repaginate it.
  const [marksLoaded, setMarksLoaded] = useState(false);
  const hinted = useRef(false);
  useEffect(() => {
    if (isPdf || loading || !marksLoaded || hinted.current) return;
    hinted.current = true;
    if (highlights.length) return;
    setSyncNote((n) => n ?? { kind: "ok", text: "Select text, then tap Save highlight" });
  }, [isPdf, loading, marksLoaded, highlights.length]);

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
        case "noteStrokes": {
          // The web insert canvas only ever writes legacy vectors. Once the
          // native canvas has saved a note its row carries pk, and a stray
          // web stroke (a touch below the native paper, say) must not
          // overwrite that drawing with a bare array.
          const stored = notePagesRef.current.find((p) => p.id === msg.id);
          if (stored && hasPencilKit(stored.strokes)) return;
          const images = noteImages(stored?.strokes);
          const strokes: string = images.length ? withImages(msg.strokes, images) : msg.strokes;
          void saveNoteStrokes(msg.id, strokes);
          setNotePages((pages) => pages.map((p) => (p.id === msg.id ? { ...p, strokes } : p)));
          return;
        }
        case "location":
          setOnNote(msg.noteId ?? null);
          if (isPdf && msg.cfi) currentPage.current = Number(msg.cfi) || 1;
          if (!isPdf && typeof msg.section === "number") currentSection.current = msg.section;
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
        case "fontSize":
          // A pinch in an EPUB; the page has already applied it.
          if (typeof msg.pct === "number") void setNumberSetting(`fontsize:${book.id}`, msg.pct);
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

  /** Where a new insert anchors: the PDF page, or the EPUB spine section. Both
   * are tracked from the reader's own location messages, so an insert lands
   * after what is actually on screen. */
  const anchor = useCallback(
    () => (isPdf ? currentPage.current : currentSection.current),
    [isPdf],
  );

  const insertNotePage = useCallback(async () => {
    const page = await addNotePage(book.id, anchor());
    const pages = await listNotePages(book.id);
    setNotePages(pages);
    post({ type: "notes", items: pages });
    post({ type: "showNote", id: page.id });
  }, [anchor, book.id, post]);

  const activeNote = onNote ? (notePages.find((p) => p.id === onNote) ?? null) : null;
  // The active insert's stored ink, split for the native surface: the
  // PKDrawing binary when one exists, else legacy web-canvas vectors to raise
  // into PKStrokes so nothing already written is lost.
  //
  // Frozen per note on purpose. The canvas owns the ink while a page is open;
  // these props are its starting content only. Deriving them from live state
  // handed the drawing back to the canvas after every save, and a reload
  // landing between saves rolled back whatever was written in the gap, while
  // one landing mid-stroke cancelled the stroke outright: fast handwriting
  // lost characters.
  const initialInk = useMemo(() => {
    const note = onNote ? (notePagesRef.current.find((p) => p.id === onNote) ?? null) : null;
    if (!note) return { drawing: null as string | null, vectors: null as string | null };
    try {
      const parsed = JSON.parse(note.strokes || "[]") as unknown[] | { pk?: string; v?: unknown[] };
      if (Array.isArray(parsed)) {
        return { drawing: null, vectors: parsed.length ? JSON.stringify(parsed) : null };
      }
      return {
        drawing: parsed.pk ?? null,
        vectors: parsed.v?.length ? JSON.stringify(parsed.v) : null,
      };
    } catch {
      /* unreadable ink loses to a blank page, not a crash */
      return { drawing: null, vectors: null };
    }
  }, [onNote]);

  const onInk = useCallback((noteId: string, e: { nativeEvent: PencilChange }) => {
    let v: unknown = [];
    try {
      v = JSON.parse(e.nativeEvent.v);
    } catch {
      /* the pk binary is still the full drawing */
    }
    // The canvas reports ink only. The page's copied images ride along from
    // the stored row, or the first stroke after a copy would delete them. The
    // ref is current here: images are only added while no insert is open.
    const images = noteImages(notePagesRef.current.find((p) => p.id === noteId)?.strokes);
    const envelope = JSON.stringify(
      images.length ? { pk: e.nativeEvent.pk, v, images } : { pk: e.nativeEvent.pk, v },
    );
    void saveNoteStrokes(noteId, envelope);
    // Keep local state current too, or reopening this insert in the same
    // session would load the ink as it was when the book opened.
    setNotePages((pages) =>
      pages.map((p) => (p.id === noteId ? { ...p, strokes: envelope } : p)),
    );
  }, []);

  // Images on the insert showing. Keyed on the note alone, like initialInk:
  // they change only by a copy, which happens with no insert open.
  const activeImages = useMemo(
    () => noteImages(notePagesRef.current.find((p) => p.id === onNote)?.strokes),
    [onNote],
  );
  const [paperBox, setPaperBox] = useState({ w: 0, h: 0 });

  /* Copy area: drag a rectangle over the book, snapshot the web view, crop,
   * and drop the result onto an insert. Host side, so pdf.js canvas and epub.js
   * frame are the same pixels to it. */
  const shot = useRef<View>(null);
  const [bookBox, setBookBox] = useState({ w: 0, h: 0 });
  const bookBoxRef = useRef(bookBox);
  bookBoxRef.current = bookBox;
  const [capturing, setCapturing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const dragFrom = useRef({ x: 0, y: 0 });
  const drawRect = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          dragFrom.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
          setRect({ ...dragFrom.current, w: 0, h: 0 });
        },
        onPanResponderMove: (_e, g) => {
          const { w: bw, h: bh } = bookBoxRef.current;
          const { x: x0, y: y0 } = dragFrom.current;
          const x1 = clamp(x0 + g.dx, 0, bw);
          const y1 = clamp(y0 + g.dy, 0, bh);
          setRect({
            x: Math.min(x0, x1),
            y: Math.min(y0, y1),
            w: Math.abs(x1 - x0),
            h: Math.abs(y1 - y0),
          });
        },
      }),
    [],
  );

  const startCapture = useCallback(() => {
    setRect(null);
    setCapturing(true);
  }, []);

  const cancelCapture = useCallback(() => {
    setCapturing(false);
    setRect(null);
  }, []);

  // Capture is modal: the pager is inert while it runs, but a location message
  // can still open an insert under the overlay, and a copy made then would land
  // on a page whose images are already frozen for display.
  useEffect(() => {
    if (capturing && onNote) cancelCapture();
  }, [capturing, onNote, cancelCapture]);

  const copyArea = useCallback(async () => {
    if (!rect || rect.w < MIN_RECT || rect.h < MIN_RECT || !bookBox.w || !bookBox.h) return;
    setCopying(true);
    let snapshot: string | null = null;
    // The cropped PNG while it is still a temporary file, then where it moved.
    let png: string | null = null;
    let moved: string | null = null;
    let show: string | null = null;
    try {
      snapshot = await captureRef(shot, { format: "png", result: "tmpfile" });
      // Read from the file's header, so the snapshot is decoded once, for the
      // crop. It is in pixels and the rectangle in points.
      const full = await Image.getSize(snapshot);
      const scale = full.width / bookBox.w;
      const originX = clamp(Math.round(rect.x * scale), 0, full.width - 1);
      const originY = clamp(Math.round(rect.y * scale), 0, full.height - 1);
      const crop = {
        originX,
        originY,
        width: Math.max(1, Math.min(Math.round(rect.w * scale), full.width - originX)),
        height: Math.max(1, Math.min(Math.round(rect.h * scale), full.height - originY)),
      };
      // Both hold native image memory until released, which the garbage
      // collector gets round to whenever it likes.
      const context = ImageManipulator.manipulate(snapshot).crop(crop);
      try {
        const cropped = await context.renderAsync();
        try {
          png = (await cropped.saveAsync({ format: SaveFormat.PNG })).uri;
        } finally {
          cropped.release();
        }
      } finally {
        context.release();
      }

      const paper = paperBox.w
        ? paperBox
        : { w: bookBox.w - 2 * PAPER_INSET.x, h: bookBox.h - 2 * PAPER_INSET.y };
      const aspect = crop.height / crop.width;
      const at = anchor();
      // The first insert after this page with room takes it. Only when every
      // one is full does the image start a new one, rather than hang off the
      // bottom of a full page.
      let target: NotePage | null = null;
      let box: Omit<NoteImage, "file"> | null = null;
      for (const p of notePagesRef.current
        .filter((n) => n.after_page === at)
        .sort((a, b) => a.position - b.position)) {
        box = placeImage(noteImages(p.strokes), aspect, paper);
        if (box) {
          target = p;
          break;
        }
      }
      if (!target || !box) {
        target = await addNotePage(book.id, at);
        box = placeImage([], aspect, paper)!;
      }

      const dir = `notes/${target.id}`;
      const file = `${dir}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`;
      await FileSystem.makeDirectoryAsync(docUri(dir), { intermediates: true });
      await FileSystem.moveAsync({ from: png, to: docUri(file) });
      png = null;
      moved = docUri(file);

      const envelope = withImages(target.strokes, [...noteImages(target.strokes), { file, ...box }]);
      await saveNoteStrokes(target.id, envelope);
      moved = null;
      setCapturing(false);
      setRect(null);
      show = target.id;
    } catch (err) {
      // An image no row points at is never shown and never cleaned up.
      if (moved) await FileSystem.deleteAsync(moved, { idempotent: true }).catch(() => undefined);
      Alert.alert("Could not copy this area", err instanceof Error ? err.message : String(err));
    } finally {
      setCopying(false);
      for (const tmp of [snapshot, png]) {
        if (tmp) FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => undefined);
      }
      // Refreshed either way: a failure can still leave a new insert behind,
      // and the list must show what the database holds.
      try {
        const pages = await listNotePages(book.id);
        setNotePages(pages);
        post({ type: "notes", items: pages });
      } catch {
        /* the next open reloads the list */
      }
      if (show) post({ type: "showNote", id: show });
    }
  }, [anchor, book.id, bookBox, paperBox, post, rect]);

  const removeNotePage = useCallback(() => {
    if (!onNote) return;
    Alert.alert("Delete this page?", "Anything written on it is removed.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteNotePage(onNote);
          try {
            await FileSystem.deleteAsync(docUri(`notes/${onNote}`), { idempotent: true });
          } catch {
            /* an orphaned image costs disk, not correctness */
          }
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
        {onNote ? (
          // Up here because the floating tool picker owns the bottom of the
          // screen while writing, and it already carries undo and redo.
          <TouchableOpacity onPress={removeNotePage} hitSlop={10}>
            <Text style={[styles.action, styles.toolDanger]}>Delete page</Text>
          </TouchableOpacity>
        ) : null}
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
      <View
        style={styles.bookArea}
        onLayout={(e) =>
          setBookBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
        }
      >
        {/* The snapshot source for Copy area: the web view alone, so nothing
            laid over the book (status strip, the capture overlay) is copied. */}
        <View ref={shot} collapsable={false} style={styles.fill}>
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
        </View>
        {activeNote ? (
          // The writing surface. Native PencilKit over the WebView, which
          // keeps rendering the book underneath and never sees the pen. The
          // system tool picker floats over this and carries the pens.
          <View
            style={styles.notePaper}
            onLayout={(e) =>
              setPaperBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
            }
          >
            {Array.from({ length: 40 }, (_, i) => (
              <View key={i} style={[styles.noteRule, { top: 72 + i * 34 }]} />
            ))}
            {paperBox.w > 0
              ? activeImages.map((img) => (
                  <Image
                    key={img.file}
                    source={{ uri: docUri(img.file) }}
                    resizeMode="contain"
                    style={{
                      position: "absolute",
                      left: img.x * paperBox.w,
                      top: img.y * paperBox.h,
                      width: img.w * paperBox.w,
                      height: img.h * paperBox.h,
                    }}
                  />
                ))
              : null}
            <PencilPageView
              key={activeNote.id}
              style={StyleSheet.absoluteFill}
              drawing={initialInk.drawing}
              vectors={initialInk.vectors}
              onChange={(e) => onInk(activeNote.id, e)}
            />
          </View>
        ) : null}
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
        {capturing ? (
          <View style={StyleSheet.absoluteFill}>
            <View style={[StyleSheet.absoluteFill, styles.captureDim]} {...drawRect.panHandlers}>
              {rect ? (
                <View
                  pointerEvents="none"
                  style={[
                    styles.captureRect,
                    { left: rect.x, top: rect.y, width: rect.w, height: rect.h },
                  ]}
                />
              ) : null}
            </View>
            <View style={styles.captureBar}>
              <Text style={styles.captureHint}>Drag over the part of the page to copy</Text>
              <TouchableOpacity style={styles.addPageBtn} onPress={cancelCapture} disabled={copying}>
                <Text style={styles.addPageText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.addPageBtn,
                  styles.captureGo,
                  (!rect || rect.w < MIN_RECT || rect.h < MIN_RECT || copying) && styles.disabled,
                ]}
                onPress={() => void copyArea()}
                disabled={!rect || rect.w < MIN_RECT || rect.h < MIN_RECT || copying}
              >
                <Text style={[styles.addPageText, styles.captureGoText]}>
                  {copying ? "Copying" : "Copy"}
                </Text>
              </TouchableOpacity>
            </View>
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
          onPress={() => {
            if (!capturing) post({ type: "turn", direction: "prev" });
          }}
          hitSlop={14}
          accessibilityLabel="Previous page"
        >
          <Text style={styles.chevron}>‹</Text>
        </TouchableOpacity>

        <View style={styles.pagerCentre}>
          {/* Available on an insert too: several pages of working after one
              exercise is normal. The writing tools themselves live in the
              floating system picker, and Delete page sits in the top bar. */}
          {/* Inert during capture, like the chevrons: an insert opened under
              the overlay would take the copy without showing it. */}
          <TouchableOpacity
            style={styles.addPageBtn}
            onPress={() => {
              if (!capturing) void insertNotePage();
            }}
          >
            <Text style={styles.addPageText}>+ Blank page</Text>
          </TouchableOpacity>
          {!onNote && !loading ? (
            <TouchableOpacity
              style={styles.addPageBtn}
              onPress={() => {
                if (!capturing) startCapture();
              }}
              disabled={capturing}
            >
              <Text style={styles.addPageText}>Copy area</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <TouchableOpacity
          style={styles.pageBtn}
          onPress={() => {
            if (!capturing) post({ type: "turn", direction: "next" });
          }}
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
/** Below this, in points, a drag reads as a tap and copies nothing useful. */
const MIN_RECT = 12;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** The images on an insert, whichever envelope shape its ink is stored in. */
function noteImages(strokes: string | undefined): NoteImage[] {
  if (!strokes) return [];
  try {
    const parsed = JSON.parse(strokes);
    return !Array.isArray(parsed) && Array.isArray(parsed?.images) ? parsed.images : [];
  } catch {
    return [];
  }
}

/** Whether an insert's ink is already a PencilKit drawing. */
function hasPencilKit(strokes: string | undefined): boolean {
  if (!strokes) return false;
  try {
    const parsed = JSON.parse(strokes);
    return !Array.isArray(parsed) && typeof parsed?.pk === "string";
  } catch {
    return false;
  }
}

/** Store `images` on an insert, keeping its ink in whatever form it is in. */
function withImages(strokes: string, images: NoteImage[]): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(strokes || "[]");
    if (Array.isArray(parsed)) base = parsed.length ? { v: parsed } : {};
    else if (parsed && typeof parsed === "object") base = parsed;
  } catch {
    /* unreadable ink is already lost to the renderers; keep the image */
  }
  return JSON.stringify({ ...base, images });
}

/**
 * Where a new image goes on an insert: 90% of the paper wide, centred, below
 * the lowest image already there, its aspect kept in paper points. Shrunk to
 * fit the space left, or null when too little is left to be worth it.
 */
function placeImage(
  existing: NoteImage[],
  aspect: number,
  paper: { w: number; h: number },
): Omit<NoteImage, "file"> | null {
  const y = existing.reduce((low, i) => Math.max(low, i.y + i.h), 0) + IMAGE_GAP;
  const room = 1 - IMAGE_GAP - y;
  let w = 0.9;
  let h = (w * paper.w * aspect) / paper.h;
  if (h > room) {
    if (room < 0.15) return null;
    w *= room / h;
    h = room;
  }
  return { x: (1 - w) / 2, y, w, h };
}

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
  toolDanger: { color: "#8c2f27" },
  // The native writing surface, styled as the same paper the web insert draws
  // so the page does not change character when the surface goes native.
  notePaper: {
    position: "absolute",
    top: PAPER_INSET.y, bottom: PAPER_INSET.y, left: PAPER_INSET.x, right: PAPER_INSET.x,
    backgroundColor: "#fffdf8", borderRadius: 2, overflow: "hidden",
    shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 7,
    shadowOffset: { width: 0, height: 2 },
  },
  noteRule: {
    position: "absolute", left: 0, right: 0, height: 1,
    backgroundColor: "rgba(43, 65, 98, 0.08)",
  },
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
  pagerCentre: { flexDirection: "row", alignItems: "center", gap: 10 },
  captureDim: { backgroundColor: "rgba(20, 17, 14, 0.28)" },
  captureRect: {
    position: "absolute", borderWidth: 2, borderColor: "#3730c4",
    backgroundColor: "rgba(255, 255, 255, 0.18)",
  },
  captureBar: {
    position: "absolute", top: 16, alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: "#faf5ef",
    shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  captureHint: { fontSize: 13, color: "#6b6b6b", paddingHorizontal: 4 },
  captureGo: { backgroundColor: "#2b4162", borderColor: "#2b4162" },
  captureGoText: { color: "#faf5ef" },
  disabled: { opacity: 0.45 },
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
