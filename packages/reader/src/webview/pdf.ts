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
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
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

type Inbound =
  | { type: "open"; data: string; position?: number | null }
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
    const layer = new TextLayer({
      textContentSource: await page.getTextContent(),
      container: textHost as HTMLDivElement,
      viewport,
    });
    await layer.render();

    drawHighlights();
    send({
      type: "location",
      cfi: String(pageNum), // the host stores one opaque position string
      progress: pdf.numPages ? pageNum / pdf.numPages : 0,
    });
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

/* -------------------------------------------------------------- selection */

function pill(): HTMLElement | null {
  return document.getElementById("save-highlight");
}

function prepareSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text) return;
  const holder = document.getElementById("page")!;
  const box = holder.getBoundingClientRect();
  const rects: Rect[] = [];
  for (const r of Array.from(sel.getRangeAt(0).getClientRects())) {
    if (r.width < 2 || r.height < 2) continue;
    rects.push({
      x: (r.left - box.left) / box.width,
      y: (r.top - box.top) / box.height,
      w: r.width / box.width,
      h: r.height / box.height,
    });
  }
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
      const next = pageNum + (msg.direction === "next" ? 1 : -1);
      if (next < 1 || next > pdf.numPages) return;
      pageNum = next;
      await renderPage();
      return;
    }
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
  resizeTimer = window.setTimeout(() => void renderPage(), 300);
});

pill()?.addEventListener("click", commitPending);

send({ type: "ready" });
