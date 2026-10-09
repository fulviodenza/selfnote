/**
 * The PDF reader surface, bridge-compatible with the EPUB one.
 *
 * Its own page on purpose: a PDF session should not carry epub.js in memory
 * and an EPUB session should not carry pdf.js, which is the larger of the two.
 * Unlike EPUB there is no iframe anywhere here: pdf.js renders a canvas and a
 * text layer straight into this document, so the sandbox event problems that
 * plagued EPUB selection on iOS structurally cannot occur.
 *
 * One page is rendered at a time, matching the pager and keeping a 400-page
 * book's memory at one page's worth of canvas.
 */
// The LEGACY build on purpose: the modern one assumes iteration and promise
// APIs WKWebView does not ship, and renderPage dies with "undefined is not a
// function" only on device. Legacy carries its own compatibility layer.
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";


declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (s: string) => void };
    selfnoteReader?: { receive: (raw: string) => void };
    /** The worker bundle, inlined by build.mjs so the page needs no network. */
    __PDFJS_WORKER_SRC__?: string;
  }
}

/* ----------------------------------------------------------- bridge types */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PdfLocator {
  page: number;
  /** Selection rectangles as fractions of the page box, so they survive any
   * future zoom or a different screen without recomputation. */
  rects: Rect[];
}

interface WireHighlight {
  id: string;
  locator?: PdfLocator | null;
  color?: string | null;
}

/** A blank page inserted after a book page, drawn on with the Pencil. */
interface NotePageWire {
  id: string;
  after_page: number;
  position: number;
  strokes: string;
}

/** x, y as fractions of the page box; pressure 0..1. */
type Point = [number, number, number];
interface Stroke {
  c: string;
  w: number;
  p: Point[];
}

type Inbound =
  | { type: "open"; data: string; position?: number | null }
  | { type: "notes"; items: NotePageWire[] }
  | { type: "showNote"; id: string }
  | { type: "noteTool"; tool: "pen" | "eraser" }
  | { type: "noteUndo" }
  | { type: "highlights"; items: WireHighlight[] }
  | { type: "goto"; page?: number }
  | { type: "turn"; direction: "next" | "prev" }
  | { type: "fontSize"; percent: number }
  | { type: "theme"; mode: "light" | "dark" };

let pdf: PDFDocumentProxy | null = null;
let pageNum = 1;
let rendering = false;
let wanted: number | null = null;
let highlights: WireHighlight[] = [];
let pending: { locator: PdfLocator; text: string } | null = null;
let lastSelectionAt = 0;

/* Inserted pages. `noteIndex` is null while the book page itself is showing,
 * otherwise an index into the inserts anchored after the current page. The
 * book page never changes while stepping through them, which is what keeps the
 * progress percentage still across the detour. */
let notes: NotePageWire[] = [];
let noteIndex: number | null = null;
let strokes: Stroke[] = [];
let tool: "pen" | "eraser" = "pen";
/** Once a pen is seen, touches stop drawing: that is the palm rejection. */
let penSeen = false;

function notesAfter(page: number): NotePageWire[] {
  return notes.filter((n) => n.after_page === page).sort((a, b) => a.position - b.position);
}

function currentNote(): NotePageWire | null {
  if (noteIndex === null) return null;
  return notesAfter(pageNum)[noteIndex] ?? null;
}

function send(message: unknown): void {
  const json = JSON.stringify(message);
  if (window.ReactNativeWebView?.postMessage) window.ReactNativeWebView.postMessage(json);
  else window.parent?.postMessage(json, "*");
}

function fail(where: string, err: unknown): void {
  send({ type: "error", where, message: err instanceof Error ? err.message : String(err) });
}

/* ------------------------------------------------------------------ open */

function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function open(base64: string, position?: number | null): Promise<void> {
  if (window.__PDFJS_WORKER_SRC__) {
    GlobalWorkerOptions.workerSrc = URL.createObjectURL(
      new Blob([window.__PDFJS_WORKER_SRC__], { type: "text/javascript" }),
    );
  }
  pdf = await getDocument({
    data: bytesFromBase64(base64),
    useSystemFonts: true,
  }).promise;

  let title: string | null = null;
  let author: string | null = null;
  try {
    const meta = (await pdf.getMetadata()) as { info?: { Title?: string; Author?: string } };
    title = meta.info?.Title?.trim() || null;
    author = meta.info?.Author?.trim() || null;
  } catch {
    /* metadata is a nicety; the book still reads */
  }

  pageNum = Math.min(Math.max(position ?? 1, 1), pdf.numPages);
  await renderPage();
  send({ type: "opened", title, author, pages: pdf.numPages });
}

/* ------------------------------------------------------------- rendering */

async function renderPage(): Promise<void> {
  if (!pdf) return;
  if (rendering) {
    // A turn during a render queues the latest target instead of overlapping
    // two renders on one canvas.
    wanted = pageNum;
    return;
  }
  rendering = true;
  try {
    const page: PDFPageProxy = await pdf.getPage(pageNum);
    const holder = document.getElementById("page")!;
    const base = page.getViewport({ scale: 1 });
    const scale = holder.clientWidth / base.width;
    const viewport = page.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;

    const canvas = document.getElementById("canvas") as HTMLCanvasElement;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    holder.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    // Transparent real text over the canvas is what makes selection work.
    const textHost = document.getElementById("text")!;
    textHost.textContent = "";
    // pdf.js sizes text layer spans against this CSS variable and misbehaves
    // without it; setting it is part of the TextLayer contract, not styling.
    textHost.style.setProperty("--scale-factor", String(viewport.scale));
    textHost.style.width = `${viewport.width}px`;
    textHost.style.height = `${viewport.height}px`;
    // The stream form, not the awaited TextContent object: TextLayer iterates
    // its source, and handing it the plain object dies inside render with
    // "undefined is not a function" after the canvas has already painted.
    const layer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textHost as HTMLDivElement,
      viewport,
    });
    await layer.render();

    drawHighlights();
    sendLocation();
  } catch (err) {
    fail("renderPage", err);
  } finally {
    rendering = false;
    if (wanted !== null && wanted !== pageNum) {
      pageNum = wanted;
      wanted = null;
      void renderPage();
    } else {
      wanted = null;
    }
  }
}

function drawHighlights(): void {
  const overlay = document.getElementById("marks")!;
  overlay.textContent = "";
  const holder = document.getElementById("page")!;
  const w = holder.clientWidth;
  const h = holder.clientHeight;
  for (const hl of highlights) {
    if (!hl.locator || hl.locator.page !== pageNum) continue;
    for (const r of hl.locator.rects ?? []) {
      const div = document.createElement("div");
      div.className = "mark";
      div.style.left = `${r.x * w}px`;
      div.style.top = `${r.y * h}px`;
      div.style.width = `${r.w * w}px`;
      div.style.height = `${r.h * h}px`;
      div.style.background = hl.color || "#f2c94c";
      div.addEventListener("click", () => send({ type: "highlightTapped", id: hl.id }));
      overlay.appendChild(div);
    }
  }
}

/* ------------------------------------------------------------ note page */

function noteEls() {
  return {
    wrap: document.getElementById("note") as HTMLDivElement | null,
    canvas: document.getElementById("notecanvas") as HTMLCanvasElement | null,
  };
}

/** Size the note canvas to the book page, so an insert feels like a leaf of
 * the same book rather than a floating pad. */
function sizeNoteCanvas(): void {
  const { wrap, canvas } = noteEls();
  const holder = document.getElementById("page");
  if (!wrap || !canvas || !holder) return;
  const w = holder.clientWidth;
  const h = holder.clientHeight || Math.round(w * 1.294);
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(w * ratio);
  canvas.height = Math.floor(h * ratio);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  redrawStrokes();
}

function redrawStrokes(): void {
  const { canvas } = noteEls();
  if (!canvas) return;
  const ctx = canvas.getContext("2d")!;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const st of strokes) drawStroke(ctx, st, w, h);
}

function drawStroke(ctx: CanvasRenderingContext2D, st: Stroke, w: number, h: number): void {
  if (st.p.length === 0) return;
  ctx.strokeStyle = st.c;
  if (st.p.length === 1) {
    const [x, y, pr] = st.p[0];
    ctx.beginPath();
    ctx.arc(x * w, y * h, Math.max(0.6, (st.w * (0.4 + pr)) / 2), 0, Math.PI * 2);
    ctx.fillStyle = st.c;
    ctx.fill();
    return;
  }
  // Width follows pressure per segment, so a stroke tapers the way a pen does.
  for (let i = 1; i < st.p.length; i++) {
    const [x0, y0, p0] = st.p[i - 1];
    const [x1, y1, p1] = st.p[i];
    ctx.lineWidth = st.w * (0.4 + (p0 + p1) / 2);
    ctx.beginPath();
    ctx.moveTo(x0 * w, y0 * h);
    ctx.lineTo(x1 * w, y1 * h);
    ctx.stroke();
  }
}

let drawing: Stroke | null = null;
let saveTimer: number | undefined;

function persistStrokes(): void {
  const note = currentNote();
  if (!note) return;
  window.clearTimeout(saveTimer);
  // On pointerup rather than per sample, and debounced: a page of working is
  // hundreds of strokes and each one does not need its own write.
  saveTimer = window.setTimeout(
    () => send({ type: "noteStrokes", id: note.id, strokes: JSON.stringify(strokes) }),
    400,
  );
}

function pointFrom(e: PointerEvent, box: DOMRect): Point {
  const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
  return [
    (e.clientX - box.left) / box.width,
    (e.clientY - box.top) / box.height,
    Math.min(1, Math.max(0.05, pressure)),
  ];
}

/** True when this pointer should draw. A pen always does; a finger only while
 * no pen has ever been seen, so a resting hand is ignored on a Pencil iPad but
 * the feature still works without one. */
function canDraw(e: PointerEvent): boolean {
  if (e.pointerType === "pen") {
    penSeen = true;
    return true;
  }
  return !penSeen && e.pointerType !== "mouse" ? true : e.pointerType === "mouse";
}

function eraseAt(pt: Point): void {
  const before = strokes.length;
  strokes = strokes.filter((st) => !st.p.some(([x, y]) => Math.hypot(x - pt[0], y - pt[1]) < 0.02));
  if (strokes.length !== before) {
    redrawStrokes();
    persistStrokes();
  }
}

function bindNoteDrawing(): void {
  const { canvas } = noteEls();
  if (!canvas) return;

  canvas.addEventListener("pointerdown", (e: PointerEvent) => {
    if (!canDraw(e)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const box = canvas.getBoundingClientRect();
    if (tool === "eraser") {
      eraseAt(pointFrom(e, box));
      return;
    }
    drawing = { c: "#1b2a3a", w: 3.2, p: [pointFrom(e, box)] };
    strokes.push(drawing);
  });

  canvas.addEventListener("pointermove", (e: PointerEvent) => {
    if (!drawing && tool !== "eraser") return;
    if (!canDraw(e)) return;
    e.preventDefault();
    const box = canvas.getBoundingClientRect();
    if (tool === "eraser") {
      if (e.buttons) eraseAt(pointFrom(e, box));
      return;
    }
    if (!drawing) return;
    // Coalesced events carry the samples the OS batched between frames, which
    // is the difference between a smooth fast stroke and a polygon.
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) drawing.p.push(pointFrom(ev, box));
    const ctx = canvas.getContext("2d")!;
    drawStroke(ctx, { ...drawing, p: drawing.p.slice(-(events.length + 1)) }, box.width, box.height);
  });

  const finish = (e: PointerEvent) => {
    if (!drawing) return;
    drawing = null;
    persistStrokes();
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
}

/** Show the book page, or the insert at `index` after it. */
function showNoteAt(index: number | null): void {
  noteIndex = index;
  const { wrap } = noteEls();
  const holder = document.getElementById("page");
  const note = currentNote();
  if (note && wrap && holder) {
    try {
      strokes = JSON.parse(note.strokes) as Stroke[];
    } catch {
      strokes = [];
    }
    holder.style.display = "none";
    wrap.style.display = "block";
    sizeNoteCanvas();
  } else {
    noteIndex = null;
    strokes = [];
    if (wrap) wrap.style.display = "none";
    if (holder) holder.style.display = "block";
  }
  sendLocation();
}

/** Progress comes from the book page only, which is what keeps an insert from
 * lengthening the book. */
function sendLocation(): void {
  send({
    type: "location",
    cfi: String(pageNum),
    progress: pdf && pdf.numPages ? pageNum / pdf.numPages : 0,
    noteId: currentNote()?.id ?? null,
  });
}

/* -------------------------------------------------------------- selection */

function pill(): HTMLElement | null {
  return document.getElementById("save-highlight");
}

/**
 * Rectangles that hug the selected glyphs.
 *
 * Range.getClientRects() returns LINE BOXES, which in a pdf.js text layer run
 * the full width of each span including its trailing whitespace, so a highlight
 * drawn from them overshoots the text into the right margin. Measuring each
 * text node's selected slice with its whitespace trimmed off keeps the marks on
 * the words.
 */
function glyphRects(range: Range, box: DOMRect): Rect[] {
  const nodes: Text[] = [];
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) {
    nodes.push(root as Text);
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  }

  const out: Rect[] = [];
  for (const node of nodes) {
    const data = node.data;
    let start = node === range.startContainer ? range.startOffset : 0;
    let end = node === range.endContainer ? range.endOffset : data.length;
    while (start < end && /\s/.test(data[start])) start++;
    while (end > start && /\s/.test(data[end - 1])) end--;
    if (start >= end) continue; // whitespace-only slice contributes nothing
    const sub = document.createRange();
    sub.setStart(node, start);
    sub.setEnd(node, end);
    for (const r of Array.from(sub.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      out.push({
        x: (r.left - box.left) / box.width,
        y: (r.top - box.top) / box.height,
        w: r.width / box.width,
        h: r.height / box.height,
      });
    }
  }
  return mergeRects(out);
}

/** Join the per-span boxes on each line into one bar, so a highlight reads as a
 * stroke across the words rather than a row of tiles. */
function mergeRects(rects: Rect[]): Rect[] {
  const lines = new Map<string, Rect[]>();
  for (const r of rects) {
    // Group by line: same top within a hair, same height within a hair.
    const key = `${r.y.toFixed(3)}:${r.h.toFixed(3)}`;
    const bucket = lines.get(key);
    if (bucket) bucket.push(r);
    else lines.set(key, [r]);
  }
  const out: Rect[] = [];
  for (const bucket of lines.values()) {
    bucket.sort((a, b) => a.x - b.x);
    let cur = { ...bucket[0] };
    for (const r of bucket.slice(1)) {
      // A word gap is small; anything wider is a genuine break worth keeping.
      if (r.x <= cur.x + cur.w + 0.012) {
        cur.w = Math.max(cur.x + cur.w, r.x + r.w) - cur.x;
      } else {
        out.push(cur);
        cur = { ...r };
      }
    }
    out.push(cur);
  }
  return out;
}

function prepareSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text) return;
  const holder = document.getElementById("page")!;
  const rects = glyphRects(sel.getRangeAt(0), holder.getBoundingClientRect());
  if (!rects.length) return;
  pending = { locator: { page: pageNum, rects }, text };
  const el = pill();
  if (el) el.style.display = "flex";
}

function clearPending(): void {
  pending = null;
  const el = pill();
  if (el) el.style.display = "none";
}

function commitPending(): void {
  if (!pending) return;
  const { locator, text } = pending;
  clearPending();
  send({ type: "selection", text, locator });
  try {
    window.getSelection()?.removeAllRanges();
  } catch {
    /* the highlight still lands */
  }
}

/* --------------------------------------------------------------- dispatch */

async function handle(msg: Inbound): Promise<void> {
  switch (msg.type) {
    case "open":
      return open(msg.data, msg.position);
    case "highlights":
      highlights = msg.items;
      drawHighlights();
      return;
    case "goto":
      if (pdf && msg.page) {
        pageNum = Math.min(Math.max(msg.page, 1), pdf.numPages);
        await renderPage();
      }
      return;
    case "turn": {
      if (!pdf) return;
      const here = notesAfter(pageNum);
      if (msg.direction === "next") {
        // Inserts come after their page, then the next page.
        if (noteIndex === null && here.length) return showNoteAt(0);
        if (noteIndex !== null && noteIndex + 1 < here.length) return showNoteAt(noteIndex + 1);
        if (pageNum + 1 > pdf.numPages) return;
        pageNum += 1;
        showNoteAt(null);
        await renderPage();
        return;
      }
      if (noteIndex !== null && noteIndex > 0) return showNoteAt(noteIndex - 1);
      if (noteIndex === 0) return showNoteAt(null);
      if (pageNum - 1 < 1) return;
      pageNum -= 1;
      showNoteAt(null);
      await renderPage();
      // Coming backwards onto a page lands on its last insert, so the sequence
      // reads the same in both directions.
      const prevNotes = notesAfter(pageNum);
      if (prevNotes.length) showNoteAt(prevNotes.length - 1);
      return;
    }
    case "notes":
      notes = msg.items;
      // The insert showing may have been deleted underneath us.
      if (noteIndex !== null && !currentNote()) showNoteAt(null);
      else if (noteIndex !== null) showNoteAt(noteIndex);
      return;
    case "showNote": {
      const target = notes.find((n) => n.id === msg.id);
      if (!target) return;
      if (target.after_page !== pageNum) {
        pageNum = target.after_page;
        await renderPage();
      }
      const idx = notesAfter(pageNum).findIndex((n) => n.id === msg.id);
      if (idx >= 0) showNoteAt(idx);
      return;
    }
    case "noteTool":
      tool = msg.tool;
      return;
    case "noteUndo":
      if (!currentNote() || !strokes.length) return;
      strokes.pop();
      redrawStrokes();
      persistStrokes();
      return;
    case "fontSize":
      // A PDF page is drawn, not reflowed; type size is the document's own.
      return;
    case "theme":
      document.documentElement.dataset.theme = msg.mode;
      return;
  }
}

function receive(raw: string): void {
  let msg: Inbound;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    return fail("parse", err);
  }
  handle(msg).catch((err) => fail(msg.type, err));
}

window.selfnoteReader = { receive };
window.addEventListener("message", (e: MessageEvent) => {
  if (typeof e.data !== "string" || e.data.charCodeAt(0) !== 123) return;
  let msg: Inbound;
  try {
    msg = JSON.parse(e.data);
  } catch {
    return; // not addressed to us
  }
  handle(msg).catch((err) => fail(msg.type, err));
});

// Same arbitration as the EPUB page: a long-press belongs to selection, a
// short tap turns the page only when no selection is anywhere near, saving is
// the pill. No iframe here, so everything binds to the one document.
let selTimer: number | undefined;
document.addEventListener("selectionchange", () => {
  window.clearTimeout(selTimer);
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    clearPending();
    return;
  }
  lastSelectionAt = Date.now();
  selTimer = window.setTimeout(prepareSelection, 250);
});

let sx = 0, sy = 0, st = 0, selAtStart = false;
document.addEventListener(
  "touchstart",
  (e: TouchEvent) => {
    const t = e.changedTouches[0];
    sx = t.clientX; sy = t.clientY; st = Date.now();
    const sel = window.getSelection();
    selAtStart = Boolean(sel && !sel.isCollapsed);
  },
  { passive: true },
);
document.addEventListener(
  "touchend",
  (e: TouchEvent) => {
    // On an insert the canvas owns the surface: a stroke must never be read as
    // a swipe. The pager buttons still turn pages.
    if (noteIndex !== null) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (selAtStart || Date.now() - lastSelectionAt < 600) return;
    if ((e.target as HTMLElement | null)?.id === "save-highlight") return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const dt = Date.now() - st;
    const go = (dir: "next" | "prev") => void handle({ type: "turn", direction: dir });
    if (dt < 600 && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(dx < 0 ? "next" : "prev");
      return;
    }
    if (dt < 300 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      const third = window.innerWidth / 3;
      if (t.clientX < third) go("prev");
      else if (t.clientX > window.innerWidth - third) go("next");
    }
  },
  { passive: true },
);
if (!("ontouchstart" in window)) {
  document.addEventListener("click", (e: MouseEvent) => {
    if (noteIndex !== null) return;
    if ((e.target as HTMLElement | null)?.closest("#save-highlight")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (Date.now() - lastSelectionAt < 600) return;
    const third = window.innerWidth / 3;
    if (e.clientX < third) void handle({ type: "turn", direction: "prev" });
    else if (e.clientX > window.innerWidth - third) void handle({ type: "turn", direction: "next" });
  });
  document.addEventListener("mouseup", () => window.setTimeout(prepareSelection, 50));
}

let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (noteIndex !== null) sizeNoteCanvas();
    else void renderPage();
  }, 300);
});

pill()?.addEventListener("click", commitPending);
bindNoteDrawing();

send({ type: "ready" });
