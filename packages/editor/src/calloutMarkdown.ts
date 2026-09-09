/**
 * Markdown round-trip for callout blocks (GitHub alert syntax).
 *
 * BlockNote's built-in Markdown converters don't know about our custom `callout`
 * block, so we bracket their calls:
 *
 *  - EXPORT: walk `editor.document`; for each callout, render its inline content
 *    to Markdown and splice a GitHub alert (`> [!NOTE]` + `> …` body lines) into
 *    the output in the block's position. Non-callout blocks pass through
 *    BlockNote's own `blocksToMarkdownLossy` unchanged.
 *
 *  - IMPORT: pre-scan the Markdown for `> [!kind]` alert blockquotes, hand the
 *    rest to BlockNote's `tryParseMarkdownToBlocks`, then re-insert callout
 *    blocks (parsed from the alert body) at the right positions. The WHOLE alert
 *    body lands inside the callout (paragraphs joined by hard line breaks, list
 *    markers rendered as `•`), never as stray quote blocks after it. A marker
 *    with no body produces no block at all — no empty callout boxes.
 *
 * Both directions keep everything else byte-identical to BlockNote's behavior.
 *
 * NOTE: apps/mobile/src/editor/editorHtml.ts and tools/mcp-server/src/callouts.ts
 * carry ports of this logic — keep the three in sync.
 */
import {
  CALLOUT_KINDS,
  calloutToMarkdown,
  parseCalloutMarker,
  type CalloutKind,
} from "./callout";

/** Structural subset of the BlockNote editor the round-trip needs. */
export interface MarkdownEditor {
  document: unknown[];
  blocksToMarkdownLossy: (blocks?: unknown[]) => Promise<string>;
  tryParseMarkdownToBlocks: (markdown: string) => Promise<unknown[]>;
}

interface Block {
  type?: string;
  props?: { kind?: string };
  content?: unknown;
}

/**
 * A unique placeholder line we can safely splice into intermediate Markdown.
 * Deliberately free of `_` and other characters BlockNote's serializer escapes
 * (` CALLOUT_0 ` came back as `CALLOUT\_0`, so the replace never matched).
 */
const SENTINEL = (i: number) => `@@CALLOUT-${i}@@`;

/**
 * Export `blocks` (default: the whole document) to Markdown, emitting callouts as
 * GitHub alerts. Callout blocks are temporarily swapped for a placeholder
 * paragraph so BlockNote lays them out in order; we then substitute each
 * placeholder with the rendered alert.
 */
export async function blocksToMarkdownWithCallouts(
  editor: MarkdownEditor,
  blocks?: unknown[],
): Promise<string> {
  const list = (blocks ?? editor.document) as Block[];
  const callouts: string[] = [];

  // Replace each callout with a sentinel paragraph, remembering its alert text.
  // Sequential on purpose: an async map would read `callouts.length` for every
  // callout before any push, giving them all the same sentinel index.
  const patched: unknown[] = [];
  for (const block of list) {
    if (block?.type !== "callout") {
      patched.push(block);
      continue;
    }
    const i = callouts.length;
    const kind = (block.props?.kind || "note") as CalloutKind;
    // Render just this callout's inline content by wrapping it as a paragraph.
    const inner = await editor.blocksToMarkdownLossy([
      { type: "paragraph", content: block.content },
    ]);
    callouts.push(calloutToMarkdown(kind, inner.trim()));
    patched.push({ type: "paragraph", content: [{ type: "text", text: SENTINEL(i), styles: {} }] });
  }

  let md = await editor.blocksToMarkdownLossy(patched);
  for (let i = 0; i < callouts.length; i++) {
    // The sentinel sits alone on its paragraph line; swap the whole line.
    // Tolerate serializer escaping (e.g. `\@`) around the sentinel characters.
    md = md.replace(sentinelPattern(i), () => callouts[i]);
  }
  return md;
}

/** Regex matching SENTINEL(i) even if the serializer escaped its punctuation. */
function sentinelPattern(i: number): RegExp {
  return new RegExp(`\\\\?@\\\\?@CALLOUT-${i}\\\\?@\\\\?@`);
}

/** A GitHub-alert block extracted from raw Markdown, plus its body text. */
interface AlertMatch {
  placeholder: string;
  kind: CalloutKind;
  body: string;
}

/**
 * Pull `> [!kind] …` alert blockquotes out of `markdown`, replacing each with a
 * placeholder paragraph line. Returns the rewritten markdown + the extracted
 * alerts (in document order). The marker may carry trailing text on the same
 * line (`> [!NOTE] Title …`, Obsidian-style) — it becomes the first body line.
 * The body is every contiguous `>`-prefixed line after the marker.
 */
function extractAlerts(markdown: string): { rewritten: string; alerts: AlertMatch[] } {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const alerts: AlertMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const marker = markerLine(lines[i]);
    if (!marker) {
      out.push(lines[i]);
      continue;
    }
    // Consume the contiguous blockquote body that follows the marker line.
    const bodyLines: string[] = marker.rest ? [marker.rest] : [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*>/.test(l)) bodyLines.push(l.replace(/^\s*>\s?/, ""));
      else break;
    }
    const body = bodyLines.join("\n").trim();
    if (body) {
      const placeholder = SENTINEL(alerts.length);
      out.push("", placeholder, "");
      alerts.push({ placeholder, kind: marker.kind, body });
    }
    // An empty alert (marker with no body) produces nothing — no empty box.
    i = j - 1;
  }

  return { rewritten: out.join("\n"), alerts };
}

/**
 * If a line starts a GitHub-alert (`> [!NOTE]`, optionally with trailing text),
 * return the kind plus any same-line body text.
 */
function markerLine(line: string): { kind: CalloutKind; rest: string } | null {
  if (!/^\s*>/.test(line)) return null;
  const inner = line.replace(/^\s*>\s?/, "");
  const kind = parseCalloutMarker(inner);
  if (!kind) return null;
  // Match the raw marker token (which may be an alias like `[!info]`, possibly
  // with an Obsidian fold suffix) rather than the canonical label.
  const m = /^\s*\[!\w+\][+-]?\s*(.*)$/.exec(inner);
  if (!m) return null;
  return { kind, rest: m[1].trim() };
}

/**
 * Flatten a multi-line alert body into ONE Markdown paragraph joined by hard
 * line breaks, so the whole body fits a callout's inline content. List markers
 * become visible bullets/numbers; heading markers become bold; blank lines
 * collapse. Inline styling (bold, links, …) survives BlockNote's parse.
 */
function bodyAsSingleParagraph(body: string): string {
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    let l = raw.trim();
    if (!l) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(l);
    if (heading) l = `**${heading[1]}**`;
    else l = l.replace(/^[-*+]\s+/, "• ");
    lines.push(l);
  }
  // Two trailing spaces = Markdown hard break; keeps everything in one block.
  return lines.join("  \n");
}

/**
 * Parse `markdown` into BlockNote blocks, converting GitHub-alert blockquotes
 * into callout blocks. Alert bodies are themselves parsed by BlockNote so inline
 * formatting survives; the whole body is folded into the callout's inline
 * content (hard line breaks between original lines).
 */
export async function markdownToBlocksWithCallouts(
  editor: MarkdownEditor,
  markdown: string,
): Promise<unknown[]> {
  const { rewritten, alerts } = extractAlerts(markdown);
  const blocks = (await editor.tryParseMarkdownToBlocks(rewritten)) as Block[];
  if (alerts.length === 0) return blocks;

  // Pre-parse each alert body (flattened to one paragraph) to inline content.
  const bodyContent = await Promise.all(
    alerts.map(async (a) => {
      try {
        const parsed = (await editor.tryParseMarkdownToBlocks(
          bodyAsSingleParagraph(a.body),
        )) as Block[];
        const content = parsed[0]?.content;
        if (Array.isArray(content) && content.length > 0) return content;
      } catch {
        /* fall through to the plain-text fallback */
      }
      return [{ type: "text", text: a.body, styles: {} }];
    }),
  );

  // Swap any placeholder paragraph for its callout block.
  return blocks.map((block) => {
    const text = soleText(block);
    const idx = text ? alerts.findIndex((a) => a.placeholder === text) : -1;
    if (idx === -1) return block;
    return { type: "callout", props: { kind: alerts[idx].kind }, content: bodyContent[idx] };
  });
}

/** If a block is a paragraph whose only inline content is one text run, return it. */
function soleText(block: Block): string | null {
  if (block?.type !== "paragraph") return null;
  const content = block.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const node = content[0] as { type?: string; text?: string };
  return typeof node.text === "string" ? node.text.trim() : null;
}

/** Re-export for hosts that only import from this module. */
export { CALLOUT_KINDS };
