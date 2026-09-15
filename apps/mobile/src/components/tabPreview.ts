/**
 * Plain-text excerpts for the tab switcher's cards.
 *
 * A real thumbnail would mean one WebView per card, which is far too expensive
 * for a grid. Instead we read the page's last-saved Yjs state out of the local
 * SQLite cache and walk it for text, with no network, no WebView and no
 * BlockNote: a `Y.Doc` plus the shared `document-store` fragment is enough,
 * because every client writes the same fragment.
 *
 * A page never opened on this device has no cached state and yields "", which
 * the card renders as no excerpt at all. That is honest: we genuinely do not
 * know what is in it yet.
 */
import * as Y from "yjs";
import { fromBase64 } from "lib0/buffer";
import { FRAGMENT_NAME } from "@selfnote/core";

/** Characters kept per card. A few lines' worth; the card clips the rest. */
const PREVIEW_CHARS = 280;

/** Mutable walk budget, so a huge page stops being read once we have enough. */
interface Budget {
  left: number;
}

/**
 * Depth-first text collection over a Yjs XML tree.
 *
 * `Y.XmlText.toString()` would re-serialise formatting marks as tags, so we go
 * through `toDelta()` and keep only the string inserts. Element boundaries push
 * a space, which `squash` below collapses: without it "Node inventory" and the
 * table cell after it would run together into one word.
 */
function collect(node: unknown, out: string[], budget: Budget): void {
  if (budget.left <= 0) return;

  if (node instanceof Y.XmlText) {
    for (const op of node.toDelta() as { insert?: unknown }[]) {
      if (typeof op.insert !== "string") continue;
      out.push(op.insert);
      budget.left -= op.insert.length;
      if (budget.left <= 0) return;
    }
    return;
  }

  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    for (const child of node.toArray()) {
      collect(child, out, budget);
      if (budget.left <= 0) return;
    }
    out.push(" ");
  }
}

/** Collapse every run of whitespace (including the walk's separators) to one space. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Excerpt a page body from a base64 Yjs state, as produced by
 * `loadCachedState` in ../persistence/sqlite.
 *
 * Returns "" for missing, malformed or empty state: a tab card with no excerpt
 * is a fine outcome, an exception on the switcher's render path is not.
 */
export function previewFromState(state: string | null, max = PREVIEW_CHARS): string {
  if (!state) return "";
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, fromBase64(state));
    const out: string[] = [];
    collect(doc.getXmlFragment(FRAGMENT_NAME), out, { left: max });
    const text = squash(out.join(""));
    return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
  } catch {
    return "";
  } finally {
    doc.destroy();
  }
}
