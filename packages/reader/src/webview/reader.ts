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
import ePub, { EpubCFI, type Book, type Rendition } from "epubjs";

/* ----------------------------------------------------------- bridge types */

type Inbound =
  | { type: "open"; data: string; locations?: string | null; fontSize?: number | null }
  | { type: "highlights"; items: Highlight[] }
  | { type: "goto"; cfi: string }
  | { type: "turn"; direction: "next" | "prev" }
  | { type: "notes"; items: NotePageWire[] }
  | { type: "showNote"; id: string }
  | { type: "fontSize"; pct: number }
  | { type: "theme"; mode: "light" | "dark" };

interface Highlight {
  id: string;
  cfi: string;
  color?: string | null;
}

/** A blank page inserted after a spine section. after_page is the section's
 * spine index; the name is shared with PDF books, where it is a page number. */
interface NotePageWire {
  id: string;
  after_page: number;
  position: number;
  strokes: string;
}

let book: Book | null = null;
let rendition: Rendition | null = null;
/** Drawn highlights, so a re-send can remove what is gone instead of stacking. */
const drawn = new Map<string, Highlight>();

/* Inserted pages. They sit after the last page of their section. While one
 * shows, epub.js stays wherever it was and every location report repeats that
 * position's cfi and progress, which is what keeps an insert from moving the
 * progress percentage.
 *
 * `noteFrom` records which side of the inserts the book is parked on: "before"
 * when they were reached by turning forward (or jumped to from inside their own
 * section), "after" when reached by turning back from the start of the next
 * section. Leaving the run of inserts toward the parked side only hides them;
 * leaving toward the other side is a real page turn. */
let notes: NotePageWire[] = [];
let noteSection: number | null = null;
let noteIndex: number | null = null;
let noteFrom: "before" | "after" = "before";
/** The last position epub.js reported, repeated while an insert covers it. */
let lastLoc: { cfi: string | null; progress: number; section: number | null } = {
  cfi: null,
  progress: 0,
  section: null,
};

function notesAfter(section: number): NotePageWire[] {
  return notes.filter((n) => n.after_page === section).sort((a, b) => a.position - b.position);
}

function currentNote(): NotePageWire | null {
  if (noteSection === null || noteIndex === null) return null;
  return notesAfter(noteSection)[noteIndex] ?? null;
}

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

async function open(
  base64: string,
  cachedLocations?: string | null,
  fontSize?: number | null,
): Promise<void> {
  if (rendition) {
    rendition.destroy();
    rendition = null;
  }
  if (book) {
    book.destroy();
    book = null;
  }
  drawn.clear();
  hideNote();
  lastLoc = { cfi: null, progress: 0, section: null };
  fontPct = fontSize ? clampFont(fontSize) : 100;

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
    // allow-scripts is load-bearing on iOS, not a nicety. Without it the book
    // iframe is sandbox="allow-same-origin" only, and WKWebView delivers neither
    // the selection events nor the touch events inside such a frame: text selects
    // visually (that part is the OS) but no JS ever hears about it, so
    // highlighting and swipe both go dead ONLY on device. Desktop browsers do not
    // have this restriction, which is how the bug passed browser verification.
    allowScriptedContent: true,
  });

  // Selection and page turning share one touch surface, so they are arbitrated
  // in one place, by the rules every reader uses: a long-press belongs to
  // selection, a short tap turns the page only when no selection is anywhere
  // near, and saving a highlight is an explicit act, never a side effect of
  // pausing. The first version auto-saved after a 600ms lull and bound "click"
  // for edge taps; iOS dispatches a click when the finger lifts from the
  // long-press that STARTS a selection, so beginning to select a paragraph on
  // the left half of the page turned the page backwards out from under it.
  rendition.on("selected", (_cfi: string, contents: any) => prepareSelection(contents));

  rendition.hooks.content.register((contents: any) => {
    const doc: Document = contents.document;

    // selectionchange is the one signal iOS fires reliably (the system gesture
    // swallows touchend), so it drives the pill. Debounced just enough not to
    // thrash while the handles are moving.
    let selTimer: number | undefined;
    doc.addEventListener("selectionchange", () => {
      window.clearTimeout(selTimer);
      const sel = contents.window?.getSelection?.();
      if (!sel || sel.isCollapsed) {
        clearPending();
        return;
      }
      lastSelectionAt = Date.now();
      selTimer = window.setTimeout(() => prepareSelection(contents), 250);
    });

    // Tap vs swipe, decided from raw touches rather than synthetic clicks.
    // A pinch is two fingers and steps the text size once, on lift; whatever
    // its fingers do on the way out is neither a tap nor a swipe.
    let sx = 0, sy = 0, st = 0, selAtStart = false;
    let pinch: { d0: number; d: number } | null = null;
    let multiTouch = false;
    const spread = (e: TouchEvent) =>
      Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
    doc.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (e.touches.length >= 2) {
          multiTouch = true;
          if (!pinch && !currentNote()) {
            const d = Math.max(spread(e), 1);
            pinch = { d0: d, d };
          }
          return;
        }
        multiTouch = false;
        const t = e.changedTouches[0];
        sx = t.clientX; sy = t.clientY; st = Date.now();
        const sel = contents.window?.getSelection?.();
        selAtStart = Boolean(sel && !sel.isCollapsed);
      },
      { passive: true },
    );
    doc.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (!pinch || e.touches.length < 2) return;
        // Not passive only for this: two fingers must not reach the web view's
        // own zoom or scroll. One finger is left alone.
        e.preventDefault();
        pinch.d = spread(e);
      },
      { passive: false },
    );
    const pinchEnd = (e: TouchEvent) => {
      if (!pinch || e.touches.length >= 2) return;
      const ratio = pinch.d / pinch.d0;
      pinch = null;
      if (currentNote()) return;
      if (ratio > 1.15) stepFontSize(1);
      else if (ratio < 0.87) stepFontSize(-1);
    };
    doc.addEventListener("touchcancel", pinchEnd, { passive: true });
    doc.addEventListener(
      "touchend",
      (e: TouchEvent) => {
        pinchEnd(e);
        if (multiTouch) return;
        if (!rendition) return;
        // Nothing turns pages while selection is in play: active now, active
        // when the touch began, or active moments ago. Handle drags end with
        // the selection briefly collapsed, which is what the grace window is for.
        const sel = contents.window?.getSelection?.();
        if (sel && !sel.isCollapsed) return;
        if (selAtStart || Date.now() - lastSelectionAt < 600) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        const dt = Date.now() - st;
        if (dt < 600 && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          requestTurn(dx < 0 ? "next" : "prev");
          return;
        }
        // A tap is short and still. A long-press is neither, and belongs to
        // selection even when it ends up selecting nothing.
        if (dt < 300 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
          const width = contents.window?.innerWidth ?? window.innerWidth;
          if (t.clientX < width / 3) requestTurn("prev");
          else if (t.clientX > width - width / 3) requestTurn("next");
        }
      },
      { passive: true },
    );

    // Mouse-driven hosts (desktop web, later) have no touch events, and a click
    // is unambiguous there because selection is drag-based, not press-based.
    if (!("ontouchstart" in window)) {
      doc.addEventListener("click", (e: MouseEvent) => {
        if (!rendition) return;
        const sel = contents.window?.getSelection?.();
        if (sel && !sel.isCollapsed) return;
        if (Date.now() - lastSelectionAt < 600) return;
        const width = contents.window?.innerWidth ?? window.innerWidth;
        if (e.clientX < width / 3) requestTurn("prev");
        else if (e.clientX > width - width / 3) requestTurn("next");
      });
      doc.addEventListener("mouseup", () =>
        window.setTimeout(() => prepareSelection(contents), 50),
      );
    }
  });

  rendition.on("relocated", (location: any) => {
    lastLoc = {
      cfi: location?.start?.cfi ?? null,
      progress: location?.start?.percentage ?? 0,
      section: typeof location?.start?.index === "number" ? location.start.index : null,
    };
    sendLocation();
  });

  applyTypography(rendition);
  // The stored size goes in before the first layout, so the book never
  // paints at the default and then reflows.
  if (fontPct !== 100) rendition.themes.fontSize(`${BASE_REM * fontPct}%`);
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
const BASE_REM = 1.25;

function applyTypography(r: Rendition): void {
  r.themes.default({
    body: {
      // 20px against a ~717px page lands near 70 characters per line, which is
      // the measure print settled on for good reason.
      "font-size": `${BASE_REM}rem`,
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

/* ------------------------------------------------------------- selection */

/** The selection currently on offer, until the pill commits or it collapses. */
let pending: { cfi: string; text: string; contents: any } | null = null;
/** When a selection was last alive, so page turns keep off its back. */
let lastSelectionAt = 0;

function pill(): HTMLElement | null {
  return document.getElementById("save-highlight");
}

/**
 * Offer the current selection for saving. Nothing is written yet: saving is the
 * tap on the pill. Auto-saving on a pause was tried and is wrong, because
 * pausing is what adjusting the selection handles looks like, so it committed
 * half-made highlights and yanked the handles away mid-drag.
 */
function prepareSelection(contents: any): void {
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
  pending = { cfi, text, contents };
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
  const { cfi, text, contents } = pending;
  clearPending();
  send({ type: "selection", cfi, text });
  // The saved highlight is drawn underneath; leaving the blue overlay on top
  // makes it look like nothing happened.
  try {
    contents.window?.getSelection?.()?.removeAllRanges();
  } catch {
    /* iOS sometimes refuses; the highlight still lands */
  }
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

/* --------------------------------------------------------------- inserts */

function noteEl(): HTMLElement | null {
  return document.getElementById("note");
}

/** The note is drawn over #viewer, never instead of it: hiding or resizing the
 * viewer makes epub.js repaginate and lose its place. */
function showNote(section: number, index: number, from: "before" | "after"): void {
  noteSection = section;
  noteIndex = index;
  noteFrom = from;
  clearPending();
  const el = noteEl();
  if (el) el.style.display = "block";
  sendLocation();
}

function hideNote(): void {
  noteSection = null;
  noteIndex = null;
  const el = noteEl();
  if (el) el.style.display = "none";
}

/** Progress and cfi always describe the book position, insert or not. The
 * section is the insert's own while one shows, so a new blank page added from
 * an insert lands beside it, as it does in a PDF. */
function sendLocation(): void {
  const note = currentNote();
  send({
    type: "location",
    cfi: lastLoc.cfi,
    progress: lastLoc.progress,
    section: note ? noteSection : lastLoc.section,
    noteId: note?.id ?? null,
  });
}

/** Move epub.js one page and wait for it to report where it landed. Its
 * promise settles before the deferred "relocated", and deciding the next turn
 * from the stale location would skip a section's inserts. */
async function move(direction: "next" | "prev"): Promise<void> {
  const r = rendition;
  if (!r) return;
  await landing(r, () => (direction === "next" ? r.next() : r.prev()));
}

async function turn(direction: "next" | "prev"): Promise<void> {
  if (!rendition || !book) return;
  const loc: any = (rendition as any).location;
  if (direction === "next") {
    if (noteSection !== null && noteIndex !== null) {
      const here = notesAfter(noteSection);
      if (noteIndex + 1 < here.length) return showNote(noteSection, noteIndex + 1, noteFrom);
      if (noteFrom === "after") {
        hideNote();
        return sendLocation();
      }
      // Past the book's last page there is nothing to turn to; stay on paper.
      if (loc?.atEnd) return;
      hideNote();
      return move("next");
    }
    const end = loc?.end;
    if (end && end.displayed && end.displayed.page >= end.displayed.total) {
      if (notesAfter(end.index).length) return showNote(end.index, 0, "before");
    }
    return move("next");
  }
  if (noteSection !== null && noteIndex !== null) {
    if (noteIndex > 0) return showNote(noteSection, noteIndex - 1, noteFrom);
    if (noteFrom === "before") {
      hideNote();
      return sendLocation();
    }
    hideNote();
    return move("prev");
  }
  // At a section start the previous section's inserts come first. This has to
  // be decided before moving: once epub.js is on the previous section's last
  // page, nothing says the turn crossed a boundary.
  const start = loc?.start;
  if (start && start.displayed && start.displayed.page === 1) {
    const prev = (book.spine.get(start.index) as any)?.prev?.();
    const before = prev ? notesAfter(prev.index) : [];
    if (before.length) return showNote(prev.index, before.length - 1, "after");
  }
  return move("prev");
}

/** Jump to an insert. Inside its own section the book stays where it is, so
 * turning back off the insert returns to the page the user came from. From
 * anywhere else the book parks at the start of the next section, which is
 * where an insert sits in reading order. */
async function jumpToNote(id: string): Promise<void> {
  if (!rendition || !book) return;
  const target = notes.find((n) => n.id === id);
  if (!target) return;
  const index = notesAfter(target.after_page).findIndex((n) => n.id === id);
  if (index < 0) return;
  if (lastLoc.section === target.after_page) return showNote(target.after_page, index, "before");
  const section = book.spine.get(target.after_page) as any;
  const next = section?.next?.();
  hideNote();
  await rendition.display((next ?? section)?.href);
  showNote(target.after_page, index, next ? "after" : "before");
}

/* -------------------------------------------------------------- text size */

const FONT_MIN = 70;
const FONT_MAX = 200;
const FONT_STEP = 10;
let fontPct = 100;

/** Wait for the "relocated" that follows whatever `act` does to the view. */
async function landing(r: Rendition, act: () => Promise<unknown> | void): Promise<void> {
  const landed = new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      r.off("relocated", done);
      resolve();
    };
    const timer = window.setTimeout(done, 1500);
    r.on("relocated", done);
  });
  await act();
  await landed;
}

/** True when `cfi` is on the page epub.js says it is showing. */
function showing(r: Rendition, cfi: string): boolean {
  const loc: any = (r as any).location;
  if (!loc?.start?.cfi || !loc?.end?.cfi) return false;
  const cmp = new EpubCFI();
  return cmp.compare(loc.start.cfi, cfi) <= 0 && cmp.compare(cfi, loc.end.cfi) <= 0;
}

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (k: number) => (k ? requestAnimationFrame(() => step(k - 1)) : resolve());
    step(n);
  });

/** Apply a text size and put the book back on the passage it was showing. The
 * reflow changes the page count without moving the scroll offset, so without
 * the redisplay the page would show text from somewhere else entirely. Runs on
 * the turn chain, so a turn queued behind it decides from the settled page. */
async function applyFontSize(pct: number): Promise<void> {
  const r = rendition;
  if (!r) return;
  const keep = lastLoc.cfi;
  fontPct = pct;
  // epub.js puts this inline on the book's body, where a percentage is of the
  // 16px root and replaces the default above. Scaled by the default, 100 is
  // the size the reader opens at.
  r.themes.fontSize(`${BASE_REM * pct}%`);
  if (!keep) return;
  // The frame grows its columns from a resize observer, a frame or two after
  // the style lands. A slow reflow can still beat that, so the landing is
  // checked and redone once the layout has had longer.
  await frames(2);
  await landing(r, () => r.display(keep));
  if (!showing(r, keep)) {
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    await landing(r, () => r.display(keep));
  }
}

function clampFont(pct: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(pct / FONT_STEP) * FONT_STEP));
}

/** One pinch, one step. Reported to the host, which stores it per book. */
function stepFontSize(dir: 1 | -1): void {
  enqueue(async () => {
    const next = clampFont(fontPct + dir * FONT_STEP);
    if (next === fontPct || currentNote()) return;
    await applyFontSize(next);
    send({ type: "fontSize", pct: next });
  }).catch((err) => fail("fontSize", err));
}

/** Turns are serialised: each one decides from where the last one landed. */
let turnChain: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void> | void): Promise<void> {
  const run = turnChain.then(job);
  turnChain = run.catch(() => undefined);
  return run;
}

function requestTurn(direction: "next" | "prev"): void {
  enqueue(() => turn(direction)).catch((err) => fail("turn", err));
}

/* --------------------------------------------------------------- dispatch */

async function handle(msg: Inbound): Promise<void> {
  switch (msg.type) {
    case "open":
      return open(msg.data, msg.locations, msg.fontSize);
    case "highlights":
      return applyHighlights(msg.items);
    case "goto":
      return enqueue(async () => {
        hideNote();
        await rendition?.display(msg.cfi);
      });
    case "turn":
      return enqueue(() => turn(msg.direction));
    case "notes": {
      const shown = currentNote()?.id ?? null;
      notes = msg.items;
      if (shown === null || noteSection === null) return;
      // The insert showing may have been deleted underneath us.
      const index = notesAfter(noteSection).findIndex((n) => n.id === shown);
      if (index < 0) hideNote();
      else noteIndex = index;
      sendLocation();
      return;
    }
    case "showNote":
      return enqueue(() => jumpToNote(msg.id));
    case "fontSize": {
      // The stored size, sent at open. Applied in silence: echoing it back
      // would only rewrite the value the host just read.
      const pct = clampFont(msg.pct);
      return enqueue(() => applyFontSize(pct));
    }
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

// epub.js repaginates on any viewport resize through its own internal listener
// and does not reliably hold the reading position while doing it. Capture the
// position the moment a resize starts, before its debounced repagination has
// run, and put the book back once things settle. This is what keeps a rotation
// from quietly moving the page.
let resizeRestore: number | undefined;
let cfiBeforeResize: string | null = null;
window.addEventListener("resize", () => {
  if (!rendition) return;
  if (cfiBeforeResize === null) {
    try {
      cfiBeforeResize = (rendition as any).currentLocation()?.start?.cfi ?? null;
    } catch {
      cfiBeforeResize = null;
    }
  }
  window.clearTimeout(resizeRestore);
  resizeRestore = window.setTimeout(() => {
    const keep = cfiBeforeResize;
    cfiBeforeResize = null;
    if (keep && rendition) void rendition.display(keep);
  }, 450);
});

// The pill lives in the host document, so its tap arrives here regardless of
// anything the book frame does with events.
pill()?.addEventListener("click", commitPending);

send({ type: "ready" });
