/**
 * Server-side callout support (GitHub alert syntax).
 *
 * The editors define a custom `callout` block (see packages/editor/src/callout.tsx
 * — its CONFIG is CRDT-shared and must stay byte-for-byte identical here). The
 * default ServerBlockNoteEditor schema doesn't know it, so without this module
 * every AI proposal / MCP write that touched a note (a) crashed or dropped
 * existing callout blocks and (b) turned `> [!NOTE]` alerts in incoming Markdown
 * into plain quote blocks.
 *
 * This is a port of packages/editor/src/calloutMarkdown.ts (see also the mobile
 * twin in apps/mobile/src/editor/editorHtml.ts) — keep the three in sync:
 *
 *  - `calloutSchema` — the default blocks plus a vanilla `callout` spec.
 *  - IMPORT: `markdownToBlocksWithCallouts` converts alert blockquotes into
 *    callout blocks, folding the WHOLE body into the callout (hard line breaks
 *    between lines); a bodyless marker produces nothing (no empty box).
 *  - EXPORT: `blocksToMarkdownWithCallouts` renders callout blocks back to
 *    `> [!KIND]` alerts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BlockNoteSchema, createBlockSpec, defaultBlockSpecs } from "@blocknote/core";

// The render callback only runs inside server-util's DOM shim; Node's tsconfig
// has no DOM lib, so declare the global loosely.
declare const document: any;

/** The five callout kinds (GitHub alert parity). MUST match the clients. */
export const CALLOUT_KINDS = ["note", "tip", "warning", "important", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** SHARED block config — byte-for-byte identical to CALLOUT_CONFIG on the clients. */
const CALLOUT_CONFIG = {
  type: "callout" as const,
  propSchema: {
    kind: { default: "note" as const, values: CALLOUT_KINDS },
  },
  content: "inline" as const,
};

/**
 * Minimal vanilla render — only used if the server ever exports blocks through
 * HTML (server-util provides a DOM at that point); markdown export below swaps
 * callouts out before BlockNote sees them.
 */
const calloutBlockFactory = createBlockSpec(CALLOUT_CONFIG, {
  render: (block: any) => {
    const kind = (block?.props?.kind as string) || "note";
    const dom = document.createElement("div");
    dom.className = `callout callout-${kind}`;
    const body = document.createElement("div");
    body.className = "callout-body";
    dom.appendChild(body);
    return { dom, contentDOM: body };
  },
});

/** The server schema: default blocks + callout (matches the clients' schemas). */
export const calloutSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: (calloutBlockFactory as any)(),
  },
} as any);

/** Uppercase GitHub label for the alert marker (`[!NOTE]`, `[!TIP]`, …). */
function calloutLabel(kind: CalloutKind): string {
  return kind.toUpperCase();
}

/** Parse a `[!kind]` marker (case-insensitive) into a known kind, else null. */
function parseMarker(raw: string): CalloutKind | null {
  const m = /^\s*(?:>\s*)?\[!(\w+)\]/i.exec(raw);
  if (!m) return null;
  const k = m[1].toLowerCase();
  return (CALLOUT_KINDS as readonly string[]).includes(k) ? (k as CalloutKind) : null;
}

/** Structural subset of the (server) BlockNote editor the round-trip needs. */
export interface MarkdownEditor {
  blocksToMarkdownLossy: (blocks: unknown[]) => Promise<string>;
  tryParseMarkdownToBlocks: (markdown: string) => Promise<unknown[]>;
}

interface Block {
  type?: string;
  props?: { kind?: string };
  content?: unknown;
}

/**
 * Placeholder deliberately free of `_` and other Markdown-escapable characters
 * (the serializer turns ` CALLOUT_0 ` into `CALLOUT\_0`, breaking the replace).
 */
const SENTINEL = (i: number) => `@@CALLOUT-${i}@@`;

/** Regex matching SENTINEL(i) even if the serializer escaped its punctuation. */
const sentinelPattern = (i: number) => new RegExp(`\\\\?@\\\\?@CALLOUT-${i}\\\\?@\\\\?@`);

/** Export `blocks` to Markdown, emitting callout blocks as GitHub alerts. */
export async function blocksToMarkdownWithCallouts(
  editor: MarkdownEditor,
  blocks: unknown[],
): Promise<string> {
  const list = blocks as Block[];
  const callouts: string[] = [];

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
    const inner = await editor.blocksToMarkdownLossy([
      { type: "paragraph", content: block.content },
    ]);
    const body = inner.replace(/\s+$/, "");
    const lines = body.length ? body.split("\n") : [""];
    const quoted = lines.map((l) => (l ? `> ${l}` : ">")).join("\n");
    callouts.push(`> [!${calloutLabel(kind)}]\n${quoted}`);
    patched.push({ type: "paragraph", content: [{ type: "text", text: SENTINEL(i), styles: {} }] });
  }

  let md = await editor.blocksToMarkdownLossy(patched);
  for (let i = 0; i < callouts.length; i++) {
    md = md.replace(sentinelPattern(i), () => callouts[i]);
  }
  return md;
}

interface AlertMatch {
  placeholder: string;
  kind: CalloutKind;
  body: string;
}

/**
 * If a line starts a GitHub-alert (`> [!NOTE]`, optionally with trailing text),
 * return the kind plus any same-line body text.
 */
function markerLine(line: string): { kind: CalloutKind; rest: string } | null {
  if (!/^\s*>/.test(line)) return null;
  const inner = line.replace(/^\s*>\s?/, "");
  const kind = parseMarker(inner);
  if (!kind) return null;
  const m = new RegExp(`^\\s*\\[!${calloutLabel(kind)}\\]\\s*(.*)$`, "i").exec(inner);
  if (!m) return null;
  return { kind, rest: m[1].trim() };
}

/** Pull alert blockquotes out of `markdown`, replacing each with a placeholder. */
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
    // A bodyless marker produces nothing — no empty callout box.
    i = j - 1;
  }

  return { rewritten: out.join("\n"), alerts };
}

/**
 * Flatten a multi-line alert body into ONE Markdown paragraph joined by hard
 * line breaks, so the whole body fits the callout's inline content.
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
  return lines.join("  \n");
}

/**
 * Parse `markdown` into blocks, converting GitHub-alert blockquotes into
 * callout blocks with the whole body folded inside.
 */
export async function markdownToBlocksWithCallouts(
  editor: MarkdownEditor,
  markdown: string,
): Promise<unknown[]> {
  const { rewritten, alerts } = extractAlerts(markdown);
  const blocks = (await editor.tryParseMarkdownToBlocks(rewritten)) as Block[];
  if (alerts.length === 0) return blocks;

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
