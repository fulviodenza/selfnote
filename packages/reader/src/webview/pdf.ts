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
  | { type: "fontSize"; pct: number }
  | { type: "theme"; mode: "light" | "dark" };

let pdf: PDFDocumentProxy | null = null;
let pageNum = 1;
let rendering = false;
let wanted: number | null = null;
let highlights: WireHighlight[] = [];
let pending: { locator: PdfLocator; text: string } | null = null;
let lastSelectionAt = 0;
/** Magnification over the fitted width, 1 to 4. Session state only. */
let zoom = 1;
const MAX_ZOOM = 4;
/** A zoom commit is re-rendering; gestures wait it out. */
let zoomBusy = false;

/* Inserted pages. `noteIndex` is null while the book page itself is showing,
 * otherwise an index into the inserts anchored after the current page. The
 * book page never changes while stepping through them, which is what keeps the
 * progress percentage still across the detour. */
/** The rendered page's box, captured while it is visible. An insert is sized
 * from this: measuring #page after hiding it returns 0 and the note canvas
 * came out 0x0, which is a surface with nothing to draw on and no pointer
 * events to receive. */
let pageBox = { w: 0, h: 0 };
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

/** The page the canvas last finished drawing, so a change of page can land at
 * the top instead of wherever the previous page was scrolled to. */
let shownPage = 0;

async function renderPage(): Promise<void> {
  if (!pdf) return;
  if (rendering) {
    // A turn during a render queues the latest target instead of overlapping
    // two renders on one canvas.
    wanted = pageNum;
    return;
  }
  rendering = true;
  const target = pageNum;
  try {
    const page: PDFPageProxy = await pdf.getPage(target);
    const holder = document.getElementById("page")!;
    const base = page.getViewport({ scale: 1 });
    const fit = fitWidth() / base.width;
    const viewport = page.getViewport({ scale: fit * zoom });
    // WebKit refuses canvases past about 16.7M pixels and paints them blank,
    // which a zoomed page at device resolution overshoots. Past this cap zoom
    // upscales rather than adds detail: on a 2x screen, sharpness stops
    // improving at roughly 2x zoom.
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      Math.sqrt(16e6 / (viewport.width * viewport.height)),
    );

    // Drawn off screen and swapped in whole, so the old page stays up until
    // the new one is ready: no blank flash on a turn, and a pinch's live
    // transform can hold until the sharp render replaces it.
    const canvas = document.createElement("canvas");
    canvas.id = "canvas";
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    // Transparent real text over the canvas is what makes selection work.
    const textHost = document.createElement("div");
    textHost.id = "text";
    textHost.className = "textLayer";
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
      container: textHost,
      viewport,
    });
    await layer.render();

    const old = document.getElementById("canvas") as HTMLCanvasElement;
    old.replaceWith(canvas);
    // A detached canvas holds its backing store, up to 64MB at the cap, until
    // GC. Zeroing it frees that now, so fast turns at high zoom cannot pile up
    // past WebKit's canvas memory budget and stop rendering.
    old.width = old.height = 0;
    document.getElementById("text")!.replaceWith(textHost);
    holder.style.height = `${viewport.height}px`;
    holder.style.width = zoom > 1 ? `${viewport.width}px` : "";
    const scroller = document.getElementById("scroll")!;
    // At 1 the page fits the width, so there is nothing to the side to reach.
    scroller.style.overflowX = zoom > 1 ? "auto" : "hidden";
    if (target !== shownPage) scroller.scrollTo(0, 0);
    shownPage = target;
    // The fitted box, whatever the zoom: inserts are sized from it.
    pageBox = { w: viewport.width / zoom, h: viewport.height / zoom };

    drawHighlights();
    sendLocation();
  } catch (err) {
    fail("renderPage", err);
  } finally {
    rendering = false;
    // Compared with the page this render drew: pageNum has usually moved on
    // already by the time a turn queues behind a render.
    if (wanted !== null && wanted !== target) {
      pageNum = wanted;
      wanted = null;
      void renderPage();
    } else {
      wanted = null;
    }
  }
}

/** The width a page fills at zoom 1: the scroller's content box. */
function fitWidth(): number {
  const scroll = document.getElementById("scroll")!;
  const cs = getComputedStyle(scroll);
  return scroll.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
}

/* ------------------------------------------------------------------ zoom */

/** Re-render at `next` and scroll so the page point `local` (in the current
 * zoom's page pixels) lands at the client point `screen`. The page is redrawn
 * rather than left CSS-scaled, so the canvas stays sharp and the text layer and
 * marks come out of the same scale handling as any other render. */
async function commitZoom(
  next: number,
  local: { x: number; y: number },
  screen: { x: number; y: number },
): Promise<void> {
  const holder = document.getElementById("page")!;
  const scroll = document.getElementById("scroll")!;
  next = Math.min(MAX_ZOOM, Math.max(1, next));
  if (!pdf || noteIndex !== null || rendering || zoomBusy || Math.abs(next - zoom) < 0.02) {
    holder.style.transform = "";
    return;
  }
  zoomBusy = true;
  const page = pageNum;
  try {
    const before = zoom;
    zoom = next;
    clearPending();
    await renderPage();
    // Same task as the swap, so the transform and the re-anchor land in one
    // frame. A turn that came in meanwhile owns the scroll instead.
    holder.style.transform = "";
    if (pageNum !== page || shownPage !== page) return;
    const box = holder.getBoundingClientRect();
    scroll.scrollLeft += box.left + (local.x * next) / before - screen.x;
    scroll.scrollTop += box.top + (local.y * next) / before - screen.y;
  } finally {
    holder.style.transform = "";
    zoomBusy = false;
  }
}

/** Two fingers on the page: tracked by hand and shown as a live transform,
 * committed on lift. One finger is never touched here, so native panning and
 * text selection keep working. */
let pinch: {
  d0: number;
  /** The page point under the starting midpoint, in page pixels. */
  local: { x: number; y: number };
  left: number;
  top: number;
  factor: number;
  mid: { x: number; y: number };
} | null = null;
/** Set by any touch with two fingers down, so its leftovers are not a tap. */
let multiTouch = false;

function span(a: Touch, b: Touch) {
  return {
    d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
  };
}

function hasStylus(e: TouchEvent): boolean {
  return Array.from(e.touches).some(
    (t) => (t as Touch & { touchType?: string }).touchType === "stylus",
  );
}

function bindPinch(): void {
  const scroll = document.getElementById("scroll");
  const holder = document.getElementById("page");
  if (!scroll || !holder) return;
  scroll.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      if (e.touches.length === 1) {
        // A live pinch always has two fingers down, so one finger arriving
        // with a pinch still set means its end was lost: the touch target was
        // detached mid-gesture (a text layer swap) and the end never bubbled
        // here. Without this the live transform would stay on the page.
        if (pinch) {
          pinch = null;
          holder.style.transform = "";
        }
        return;
      }
      multiTouch = true;
      // A finger resting while the Pencil selects is not a pinch.
      if (hasStylus(e)) return;
      // A finger added mid-pinch keeps the pinch it joined: restarting would
      // measure a box that already carries the live transform.
      if (pinch) return e.preventDefault();
      if (!pdf || noteIndex !== null || rendering || zoomBusy) return;
      e.preventDefault();
      const { d, mid } = span(e.touches[0], e.touches[1]);
      const box = holder.getBoundingClientRect();
      pinch = {
        d0: Math.max(d, 1),
        local: { x: mid.x - box.left, y: mid.y - box.top },
        left: box.left,
        top: box.top,
        factor: 1,
        mid,
      };
    },
    { passive: false },
  );
  scroll.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      if (!pinch || e.touches.length < 2 || hasStylus(e)) return;
      e.preventDefault();
      const { d, mid } = span(e.touches[0], e.touches[1]);
      const target = Math.min(MAX_ZOOM, Math.max(1, (zoom * d) / pinch.d0));
      pinch.factor = target / zoom;
      pinch.mid = mid;
      // Origin 0 0: the page point under the first midpoint follows the
      // fingers' current midpoint, scaled by the factor so far.
      const tx = mid.x - pinch.left - pinch.factor * pinch.local.x;
      const ty = mid.y - pinch.top - pinch.factor * pinch.local.y;
      holder.style.transformOrigin = "0 0";
      holder.style.transform = `translate(${tx}px, ${ty}px) scale(${pinch.factor})`;
    },
    { passive: false },
  );
  const end = (e: TouchEvent) => {
    if (!pinch || e.touches.length >= 2) return;
    const p = pinch;
    pinch = null;
    void commitZoom(zoom * p.factor, p.local, p.mid);
  };
  scroll.addEventListener("touchend", end);
  scroll.addEventListener("touchcancel", end);
}

/** A double tap in the middle third toggles 1x and 2x around the tapped point. */
function toggleZoomAt(x: number, y: number): void {
  const box = document.getElementById("page")!.getBoundingClientRect();
  void commitZoom(zoom > 1 ? 1 : 2, { x: x - box.left, y: y - box.top }, { x, y });
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
    live: document.getElementById("livecanvas") as HTMLCanvasElement | null,
  };
}

/** Size the note canvas to the book page, so an insert feels like a leaf of
 * the same book rather than a floating pad. */
function sizeNoteCanvas(): void {
  const { wrap, canvas, live } = noteEls();
  if (!wrap || !canvas) return;
  // From the remembered page box, never from #page itself: by the time an
  // insert is showing, #page is display:none and measures zero.
  const w = Math.round(pageBox.w || fitWidth());
  const h = Math.round(pageBox.h || w * 1.294);
  if (w <= 0 || h <= 0) return;
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;
  const ratio = window.devicePixelRatio || 1;
  for (const c of [canvas, live]) {
    if (!c) continue;
    c.width = Math.floor(w * ratio);
    c.height = Math.floor(h * ratio);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    c.getContext("2d")!.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
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
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (st.p.length === 1) {
    const [x, y, pr] = st.p[0];
    ctx.beginPath();
    ctx.arc(x * w, y * h, Math.max(0.6, (st.w * (0.4 + pr)) / 2), 0, Math.PI * 2);
    ctx.fillStyle = st.c;
    ctx.fill();
    return;
  }
  if (st.p.length === 2) {
    const [x0, y0, p0] = st.p[0];
    const [x1, y1, p1] = st.p[1];
    ctx.lineWidth = st.w * (0.4 + (p0 + p1) / 2);
    ctx.beginPath();
    ctx.moveTo(x0 * w, y0 * h);
    ctx.lineTo(x1 * w, y1 * h);
    ctx.stroke();
    return;
  }
  // Each sample becomes the control point of a quadratic from one segment
  // midpoint to the next: the samples are too sparse to connect with straight
  // lines without the stroke reading as a polygon. Width still follows
  // pressure per piece, so a stroke tapers the way a pen does, and the round
  // caps hide the joins between pieces of different width.
  const first = st.p[0];
  const second = st.p[1];
  ctx.lineWidth = st.w * (0.4 + (first[2] + second[2]) / 2);
  ctx.beginPath();
  ctx.moveTo(first[0] * w, first[1] * h);
  ctx.lineTo(((first[0] + second[0]) / 2) * w, ((first[1] + second[1]) / 2) * h);
  ctx.stroke();
  for (let i = 1; i < st.p.length - 1; i++) {
    const [x0, y0, p0] = st.p[i - 1];
    const [x1, y1, p1] = st.p[i];
    const [x2, y2, p2] = st.p[i + 1];
    ctx.lineWidth = st.w * (0.4 + (p0 + 2 * p1 + p2) / 4);
    ctx.beginPath();
    ctx.moveTo(((x0 + x1) / 2) * w, ((y0 + y1) / 2) * h);
    ctx.quadraticCurveTo(x1 * w, y1 * h, ((x1 + x2) / 2) * w, ((y1 + y2) / 2) * h);
    ctx.stroke();
  }
  const [xa, ya, pa] = st.p[st.p.length - 2];
  const [xb, yb, pb] = st.p[st.p.length - 1];
  ctx.lineWidth = st.w * (0.4 + (pa + pb) / 2);
  ctx.beginPath();
  ctx.moveTo(((xa + xb) / 2) * w, ((ya + yb) / 2) * h);
  ctx.lineTo(xb * w, yb * h);
  ctx.stroke();
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
  if (e.pointerType === "mouse") return true;
  return !penSeen; // a finger draws only until a Pencil shows up
}

function eraseAt(pt: Point): void {
  const before = strokes.length;
  strokes = strokes.filter((st) => !st.p.some(([x, y]) => Math.hypot(x - pt[0], y - pt[1]) < 0.02));
  if (strokes.length !== before) {
    redrawStrokes();
    persistStrokes();
  }
}

/** Points the OS expects the pen to reach before the next frame. Painted on
 * the overlay and replaced every frame, never kept. */
let predicted: Point[] = [];
let liveFrame = 0;

/** Repaint the in-progress stroke, whole, on the overlay canvas. Painting the
 * live stroke in per-event increments is what made writing feel chopped: each
 * increment was a straight piece with its own width, and nothing covered the
 * gap between the pen tip and the last delivered sample. A full repaint per
 * frame keeps the curve continuous, and the predicted tail keeps the ink
 * under the tip instead of trailing it. */
function renderLive(): void {
  liveFrame = 0;
  const { live } = noteEls();
  if (!live || !drawing) return;
  const ctx = live.getContext("2d")!;
  const w = live.clientWidth;
  const h = live.clientHeight;
  ctx.clearRect(0, 0, w, h);
  drawStroke(ctx, drawing, w, h);
  if (predicted.length) {
    const last = drawing.p[drawing.p.length - 1];
    drawStroke(ctx, { ...drawing, p: [last, ...predicted] }, w, h);
  }
}

function scheduleLive(): void {
  if (!liveFrame) liveFrame = requestAnimationFrame(renderLive);
}

/** Append a sample, smoothing pressure against the previous point: raw Pencil
 * pressure jitters sample to sample, and unsmoothed it renders as a stroke
 * whose width flickers. */
function appendPoint(st: Stroke, pt: Point): void {
  const prev = st.p[st.p.length - 1];
  if (prev) pt[2] = prev[2] * 0.6 + pt[2] * 0.4;
  st.p.push(pt);
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
    scheduleLive();
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
    // is the difference between a smooth fast stroke and a polygon. The count
    // can be zero, so fall back to the event itself.
    const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const samples = list.length ? list : [e];
    for (const ev of samples) appendPoint(drawing, pointFrom(ev, box));
    predicted =
      typeof e.getPredictedEvents === "function"
        ? e.getPredictedEvents().map((ev) => pointFrom(ev, box))
        : [];
    scheduleLive();
  });

  // pointercancel keeps what was written too: WKWebView fires it when a
  // system gesture claims the touch, and half a word on the page beats none.
  const finish = (e: PointerEvent) => {
    if (!drawing) return;
    if (liveFrame) {
      cancelAnimationFrame(liveFrame);
      liveFrame = 0;
    }
    const { canvas: committed, live } = noteEls();
    if (live) live.getContext("2d")!.clearRect(0, 0, live.clientWidth, live.clientHeight);
    const st = drawing;
    drawing = null;
    predicted = [];
    // The stroke joins the page only now. While it was live it existed solely
    // on the overlay, so a mid-stroke resize or undo never painted it twice.
    strokes.push(st);
    if (committed)
      drawStroke(committed.getContext("2d")!, st, committed.clientWidth, committed.clientHeight);
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
      // Either a bare stroke array, or the envelope {pk, v} written since the
      // writing surface went native: pk is the PKDrawing binary only PencilKit
      // can read, v is the same ink as vectors for every other renderer.
      const parsed = JSON.parse(note.strokes) as Stroke[] | { v?: Stroke[] };
      strokes = Array.isArray(parsed) ? parsed : (parsed.v ?? []);
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
      // Zoom is the pinch, and it never leaves the page.
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
let lastTap = { at: 0, x: 0, y: 0 };
document.addEventListener(
  "touchstart",
  (e: TouchEvent) => {
    // Set here as well as on #scroll: a second finger landing outside it (on
    // the pill, say) must still keep the first finger's lift from reading as
    // a tap or a swipe measured between two different fingers.
    if (e.touches.length === 1) multiTouch = false;
    else if (e.touches.length >= 2) multiTouch = true;
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
    if (multiTouch) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (selAtStart || Date.now() - lastSelectionAt < 600) return;
    if ((e.target as HTMLElement | null)?.id === "save-highlight") return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const dt = Date.now() - st;
    const go = (dir: "next" | "prev") => void handle({ type: "turn", direction: dir });
    // Zoomed, a sideways drag is a pan across the page, not a swipe.
    if (zoom === 1 && dt < 600 && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(dx < 0 ? "next" : "prev");
      return;
    }
    if (dt < 300 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      const third = window.innerWidth / 3;
      if (t.clientX < third) go("prev");
      else if (t.clientX > window.innerWidth - third) go("next");
      else if ((t as Touch & { touchType?: string }).touchType !== "stylus") {
        const now = Date.now();
        if (now - lastTap.at < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30) {
          lastTap = { at: 0, x: 0, y: 0 };
          toggleZoomAt(t.clientX, t.clientY);
        } else {
          lastTap = { at: now, x: t.clientX, y: t.clientY };
        }
      }
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
bindPinch();

send({ type: "ready" });
