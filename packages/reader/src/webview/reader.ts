/**
 * The reader surface, as it runs inside the page.
 *
 * This file is bundled with epub.js into one self-contained HTML document, so it
 * works with no network. That is not a nicety: a reader that needs the internet to
 * open a book already sitting on the device is broken. It also means the host only
 * ever hands this a string, so there are no shared runtime libraries between the
 * page and its host and no module-duplication problem to manage.
 *
 * The host talks to it over postMessage. Keeping the host authoritative over
 * highlights (it owns the database) and this file authoritative over rendering is
 * what lets the same bundle serve a WebView on mobile and a plain iframe on web.
 */
import ePub, { type Book, type Rendition } from "epubjs";

/* ----------------------------------------------------------- bridge types */

type Inbound =
  | { type: "open"; data: string; locations?: string | null }
  | { type: "highlights"; items: Highlight[] }
  | { type: "goto"; cfi: string }
  | { type: "turn"; direction: "next" | "prev" }
  | { type: "fontSize"; percent: number }
  | { type: "theme"; mode: "light" | "dark" };

interface Highlight {
  id: string;
  cfi: string;
  color?: string | null;
}

let book: Book | null = null;
let rendition: Rendition | null = null;
/** Drawn highlights, so a re-send can remove what is gone instead of stacking. */
const drawn = new Map<string, Highlight>();

/** Post to whichever host is embedding us: RN WebView, or a parent frame on web. */
function send(message: unknown): void {
  const json = JSON.stringify(message);
  const rn = (window as any).ReactNativeWebView;
  if (rn?.postMessage) rn.postMessage(json);
  else window.parent?.postMessage(json, "*");
}

function fail(where: string, err: unknown): void {
  send({ type: "error", where, message: err instanceof Error ? err.message : String(err) });
}

/* ------------------------------------------------------------------ open */

function bytesFromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function open(base64: string, cachedLocations?: string | null): Promise<void> {
  if (rendition) {
    rendition.destroy();
    rendition = null;
  }
  if (book) {
    book.destroy();
    book = null;
  }
  drawn.clear();

  book = ePub(bytesFromBase64(base64));
  rendition = book.renderTo("viewer", {
    width: "100%",
    height: "100%",
    // Two pages side by side only when the page is genuinely wide enough to carry
    // two comfortable measures, one otherwise. epub.js defaults this threshold to
    // 800px; a portrait iPad page cleared it by a hair, so an upright page was
    // being split into two half-width columns.
    spread: "auto",
    minSpreadWidth: 1000,
    allowScriptedContent: false,
  });

  // Every way a selection can be noticed funnels through one place, deduped.
  rendition.on("selected", (_cfi: string, contents: any) => emitSelection(contents));

  // epub.js listens for "selectionchange" on the book's document and nothing
  // else, and WebKit fires that unreliably for subframes, so on iOS a selection
  // made by touch never reached us: the text highlighted blue and then nothing
  // happened. touchend and mouseup are what actually mark the end of a selection
  // gesture, so bind those too and let the dedupe sort out the overlap.
  //
  // Clicks are bound here for the same reason. A click inside the book is inside
  // the iframe and never bubbles to the host document, so the edge-tap page turn
  // bound out there could not fire over the text either.
  rendition.hooks.content.register((contents: any) => {
    const doc: Document = contents.document;
    const notice = () => window.setTimeout(() => emitSelection(contents), 50);
    doc.addEventListener("touchend", notice, { passive: true });
    doc.addEventListener("mouseup", notice);
    // A collapsed selection means the user cleared it; allow the same passage to
    // be highlighted again after that.
    doc.addEventListener("selectionchange", () => {
      const sel = contents.window?.getSelection?.();
      if (!sel || sel.isCollapsed) lastEmitted = "";
    });
    doc.addEventListener("click", (e: MouseEvent) => turnFromTap(e, contents));

    // Swipe is what people try first on a tablet, and an edge tap is invisible
    // until someone tells you about it. Both work.
    let sx = 0, sy = 0, st = 0;
    doc.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        const t = e.changedTouches[0];
        sx = t.clientX;
        sy = t.clientY;
        st = Date.now();
      },
      { passive: true },
    );
    doc.addEventListener(
      "touchend",
      (e: TouchEvent) => {
        if (!rendition) return;
        const sel = contents.window?.getSelection?.();
        if (sel && !sel.isCollapsed) return;      // ending a selection, not swiping
        const t = e.changedTouches[0];
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        // Horizontal, far enough to be deliberate, and quick enough to be a
        // flick rather than a slow drag that was probably a mis-selection.
        if (Date.now() - st > 600) return;
        if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        void (dx < 0 ? rendition.next() : rendition.prev());
      },
      { passive: true },
    );
  });

  rendition.on("relocated", (location: any) => {
    send({
      type: "location",
      cfi: location?.start?.cfi ?? null,
      progress: location?.start?.percentage ?? 0,
    });
  });

  applyTypography(rendition);
  await rendition.display();

  const meta = await book.loaded.metadata;
  // Locations give a real progress percentage rather than a per-chapter one, but
  // building them parses every chapter of the book. On a novel that is seconds of
  // CPU and a lot of garbage, and doing it on every open is the most wasteful
  // thing an e-reader can do to a battery. Generate once, hand the result to the
  // host to store, and load it from then on. Never awaited: it must not hold up
  // first paint either way.
  if (cachedLocations) {
    try {
      book.locations.load(cachedLocations);
      send({ type: "locationsReady", cached: true });
    } catch {
      // A stale or corrupt cache costs a regeneration, never the progress bar.
      void generateLocations();
    }
  } else {
    void generateLocations();
  }

  send({
    type: "opened",
    title: meta?.title ?? null,
    author: meta?.creator ?? null,
  });
}

/** Build the locations index and hand it to the host to cache. */
async function generateLocations(): Promise<void> {
  if (!book) return;
  try {
    await book.locations.generate(1024);
    send({ type: "locationsReady", locations: book.locations.save(), cached: false });
  } catch (err) {
    fail("locations", err);
  }
}

/**
 * Typography inside the book's own document.
 *
 * A book that ships no CSS inherits the iframe default: ~16px, tight leading,
 * ragged right, running the full column. That reads like a web page, not a book.
 * Set as defaults rather than with !important, so a book that has designed its own
 * typography still wins.
 */
function applyTypography(r: Rendition): void {
  r.themes.default({
    body: {
      // 20px against a ~717px page lands near 70 characters per line, which is
      // the measure print settled on for good reason.
      "font-size": "1.25rem",
      "line-height": "1.62",
      // Justification without hyphenation opens rivers of whitespace in a narrow
      // measure, so the two belong together.
      "text-align": "justify",
      "-webkit-hyphens": "auto",
      hyphens: "auto",
      "overflow-wrap": "break-word",
    },
    p: { margin: "0 0 0.85em" },
    "h1, h2, h3, h4": { "line-height": "1.25", "text-align": "left", hyphens: "manual" },
    img: { "max-width": "100%", height: "auto" },
    "pre, code": { "white-space": "pre-wrap", hyphens: "manual" },
  });
}

/** The last range sent, so the several listeners below cannot double-send one. */
let lastEmitted = "";

/**
 * Report a selection, whichever listener noticed it.
 *
 * The native selection is cleared afterwards: the highlight that replaces it is
 * drawn underneath, and leaving the blue overlay on top makes it look like
 * nothing happened.
 */
function emitSelection(contents: any): void {
  const sel = contents?.window?.getSelection?.();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;
  const text = sel.toString().trim();
  if (!text) return;

  let cfi: string;
  try {
    cfi = contents.cfiFromRange(range);
  } catch (err) {
    return fail("cfiFromRange", err);
  }
  if (!cfi || cfi === lastEmitted) return;
  lastEmitted = cfi;
  send({ type: "selection", cfi, text });
  try {
    sel.removeAllRanges();
  } catch {
    /* iOS sometimes refuses; the highlight still lands */
  }
}

/** Edge taps turn the page, but only when they are not ending a selection. */
function turnFromTap(e: MouseEvent, contents: any): void {
  if (!rendition) return;
  const sel = contents?.window?.getSelection?.();
  if (sel && !sel.isCollapsed) return;
  // The event is in the book frame, whose width is the page width.
  const width = contents.window?.innerWidth ?? window.innerWidth;
  const third = width / 3;
  if (e.clientX < third) void rendition.prev();
  else if (e.clientX > width - third) void rendition.next();
}

/* ------------------------------------------------------------ highlights */

function applyHighlights(items: Highlight[]): void {
  if (!rendition) return;
  const incoming = new Map(items.map((h) => [h.id, h]));

  // Remove what the host no longer has. Without this, re-sending after a delete
  // leaves the mark on the page with no row behind it.
  for (const [id, h] of drawn) {
    if (!incoming.has(id)) {
      try {
        rendition.annotations.remove(h.cfi, "highlight");
      } catch (err) {
        fail("removeHighlight", err);
      }
      drawn.delete(id);
    }
  }

  for (const h of items) {
    const existing = drawn.get(h.id);
    if (existing) {
      // Already drawn in the colour it should be: leave it alone. Redrawing every
      // highlight on every update would flicker the page on each page turn.
      if (existing.color === h.color) continue;
      // The colour carries meaning (whether it reached Selfnote yet), so a change
      // has to be repainted. epub.js has no recolour, so remove and re-add.
      try {
        rendition.annotations.remove(existing.cfi, "highlight");
      } catch (err) {
        fail("recolourHighlight", err);
      }
      drawn.delete(h.id);
    }
    try {
      rendition.annotations.highlight(
        h.cfi,
        { id: h.id },
        () => send({ type: "highlightTapped", id: h.id }),
        "selfnote-highlight",
        { fill: h.color || "#f6d365", "fill-opacity": "0.35" },
      );
      drawn.set(h.id, h);
    } catch (err) {
      // One bad CFI (a book re-imported with different internals, say) must not
      // take the rest of the page's highlights down with it.
      fail("addHighlight", err);
    }
  }
}

/* --------------------------------------------------------------- dispatch */

async function handle(msg: Inbound): Promise<void> {
  switch (msg.type) {
    case "open":
      return open(msg.data, msg.locations);
    case "highlights":
      return applyHighlights(msg.items);
    case "goto":
      await rendition?.display(msg.cfi);
      return;
    case "turn":
      await (msg.direction === "next" ? rendition?.next() : rendition?.prev());
      return;
    case "fontSize":
      rendition?.themes.fontSize(`${msg.percent}%`);
      return;
    case "theme":
      rendition?.themes.override("color", msg.mode === "dark" ? "#e8e4dc" : "#1b1b1b");
      rendition?.themes.override("background", msg.mode === "dark" ? "#14110e" : "#faf5ef");
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

// RN injects by calling this directly, so anything arriving at `receive` is ours
// and a parse failure there is worth reporting.
(window as any).selfnoteReader = { receive };

// The web host posts instead. This path is NOT ours alone: bundled libraries use
// window.postMessage for their own purposes (the setImmediate polyfill JSZip pulls
// in posts strings like "setImmediate$...$"), so anything that is not recognisably
// one of our JSON objects has to be ignored in silence. Treating every string as a
// bridge message produced an error per tick and buried real failures in noise.
window.addEventListener("message", (e: MessageEvent) => {
  if (typeof e.data !== "string" || e.data.charCodeAt(0) !== 123 /* { */) return;
  let msg: Inbound;
  try {
    msg = JSON.parse(e.data);
  } catch {
    return; // not addressed to us
  }
  handle(msg).catch((err) => fail(msg.type, err));
});

send({ type: "ready" });
