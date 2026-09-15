/**
 * Server-side math support (display blocks and inline math).
 *
 * A port of packages/editor/src/mathMarkdown.ts (see also the mobile twin in
 * apps/mobile/src/editor/editorHtml.ts); keep the three in sync. The logic is
 * pure functions over plain block objects, so this file is that module verbatim
 * apart from this header; it is duplicated rather than imported because the MCP
 * server does not depend on the editor package.
 *
 * Without it, every AI proposal and MCP write that touched a note with a
 * formula in it would drop the math, and `$$ … $$` in incoming Markdown would
 * arrive as literal dollar signs.
 */

/** Blocks as far as this module cares. */
interface Block {
  type?: string;
  props?: { latex?: string };
  content?: unknown;
  children?: unknown;
}

interface InlineNode {
  type?: string;
  text?: string;
  props?: { latex?: string };
  styles?: unknown;
}

/**
 * Sentinels, deliberately free of characters BlockNote's serializer escapes
 * beyond `@` (which the patterns below tolerate, exactly as the callout
 * sentinels do).
 */
const BLOCK_SENTINEL = (i: number) => `@@MATHB-${i}@@`;
const INLINE_SENTINEL = (i: number) => `@@MATHI-${i}@@`;

/** Matches a sentinel even if the serializer escaped its punctuation. */
function sentinelPattern(kind: "B" | "I", i: number): RegExp {
  return new RegExp(`\\\\?@\\\\?@MATH${kind}-${i}\\\\?@\\\\?@`, "g");
}

/**
 * Blocks whose BlockNote content model is `"plain"` (`text*`), which therefore
 * cannot hold an `inlineMath` node: inserting one produces a document
 * ProseMirror will not accept, and the code the user wrote is silently mangled.
 * Code is also the one place where `$VAR` syntax is routine.
 */
const PLAIN_CONTENT_TYPES = new Set(["codeBlock"]);

/** Map `fn` over a block tree, recursing through `children`. */
function mapBlocks(blocks: unknown[], fn: (block: unknown) => unknown): unknown[] {
  return (blocks ?? []).map((block) => {
    const mapped = fn(block);
    const kids = (block as Block)?.children;
    if (!Array.isArray(kids) || kids.length === 0) return mapped;
    return { ...(mapped as object), children: mapBlocks(kids, fn) };
  });
}

/* ----------------------------------------------------------------- export -- */

/**
 * Replace every math node in `blocks` with a sentinel, returning the rewritten
 * blocks plus a function that puts the LaTeX back into the serialized Markdown.
 *
 * Runs before the callout pass so that math inside a callout is handled too:
 * the callout exporter re-serializes `block.content`, and by then the inline
 * math in it is already a sentinel text run.
 */
export function stripMathForExport(blocks: unknown[]): {
  blocks: unknown[];
  restore: (markdown: string) => string;
} {
  const blockMath: string[] = [];
  const inlineMath: string[] = [];

  const stripInline = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    return content.map((node) => {
      const n = node as InlineNode;
      if (n?.type !== "inlineMath") return node;
      const i = inlineMath.length;
      inlineMath.push(n.props?.latex ?? "");
      return { type: "text", text: INLINE_SENTINEL(i), styles: {} };
    });
  };

  const out = mapBlocks(blocks, (block) => {
    const b = block as Block;
    if (b?.type === "math") {
      const i = blockMath.length;
      blockMath.push(b.props?.latex ?? "");
      return { type: "paragraph", content: [{ type: "text", text: BLOCK_SENTINEL(i), styles: {} }] };
    }
    const content = stripInline(b?.content);
    return content === b?.content ? block : { ...b, content };
  });

  const restore = (markdown: string): string => {
    let md = markdown;
    for (let i = 0; i < blockMath.length; i++) {
      // The sentinel sits alone on its paragraph line; the whole line becomes
      // a fenced display block.
      md = md.replace(sentinelPattern("B", i), () => `$$\n${blockMath[i]}\n$$`);
    }
    for (let i = 0; i < inlineMath.length; i++) {
      md = md.replace(sentinelPattern("I", i), () => `$${inlineMath[i]}$`);
    }
    return md;
  };

  return { blocks: out, restore };
}

/* ----------------------------------------------------------------- import -- */

interface BlockMathMatch {
  placeholder: string;
  latex: string;
}

/** A fenced code block opens or closes here. */
const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * Pull `$$ … $$` display runs out of `markdown`, replacing each with a
 * placeholder paragraph line.
 *
 * Only runs whose `$$` opens a line are taken, and never inside a blockquote or
 * a fenced code block: a `$$` in a callout body belongs to the callout pass, and
 * a `$$` inside a fence is code. Hoisting either would delete those lines from
 * their block and leave the fence unbalanced.
 */
function extractBlockMath(markdown: string): { rewritten: string; found: BlockMathMatch[] } {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const found: BlockMathMatch[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const opener = inFence ? null : /^\s*\$\$(.*)$/.exec(line);
    if (!opener || /^\s*>/.test(line)) {
      out.push(line);
      continue;
    }

    // `$$ x = 1 $$` on one line.
    const oneLine = /^(.*?)\$\$\s*$/.exec(opener[1]);
    if (oneLine) {
      pushMath(oneLine[1]);
      continue;
    }

    // Otherwise consume until the closing `$$`, stopping at a fence so a run can
    // never swallow one.
    const body: string[] = opener[1].trim() ? [opener[1]] : [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      if (FENCE_RE.test(lines[j])) break;
      const close = /^(.*?)\$\$\s*$/.exec(lines[j]);
      if (close) {
        if (close[1].trim()) body.push(close[1]);
        closed = true;
        break;
      }
      body.push(lines[j]);
    }
    if (!closed) {
      // An unterminated `$$` is just text; do not swallow the rest of the note.
      out.push(line);
      continue;
    }
    pushMath(body.join("\n"));
    i = j;
  }

  function pushMath(raw: string) {
    const latex = raw.trim();
    if (!latex) return; // `$$ $$` produces nothing rather than an empty box
    const placeholder = BLOCK_SENTINEL(found.length);
    out.push("", placeholder, "");
    found.push({ placeholder, latex });
  }

  return { rewritten: out.join("\n"), found };
}

/**
 * Inline `$ … $`.
 *
 * The body must begin and end with a non-space, which is the rule remark-math
 * uses and the reason "$5 for lunch and $10 for dinner" survives: the text
 * between those two dollars ends in a space, so it is not a closing delimiter.
 * A `$` escaped as `\$` is skipped.
 */
const INLINE_RE = /(^|[^\\$])\$([^\s$][^$]*?[^\s$]|[^\s$])\$/g;

/**
 * Bodies that are only digits and arithmetic punctuation, with nothing that
 * distinguishes mathematics from money. "$5-$10 range" satisfies the delimiter
 * rule above ("5-" opens and closes on a non-space) but is a price range, and
 * prices are far more common in notes than a formula whose entire content is
 * "5-". The cost is that `$1+1$` stays literal; write `$1 + 1 = 2$` or use a
 * display block for arithmetic that really is meant as math.
 *
 * Kept identical to NOT_MATH_RE in mathInputRule.ts, so typing a formula and
 * pasting the same formula produce the same result.
 */
const NOT_MATH_RE = /^[\d.,\-+/*\s]*$/;

/** Split a text run on inline math, returning the resulting inline nodes. */
function splitInlineMath(node: InlineNode): InlineNode[] {
  const text = node.text;
  if (typeof text !== "string" || !text.includes("$")) return [node];

  const out: InlineNode[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(text); m; m = INLINE_RE.exec(text)) {
    // Checked before anything is emitted: a rejected match must leave `last`
    // where it was, so the text it spans is written out by the next accepted
    // match (or by the tail below) exactly once.
    if (NOT_MATH_RE.test(m[2])) continue;
    const start = m.index + m[1].length;
    if (start > last) {
      out.push({ ...node, text: text.slice(last, start) });
    }
    out.push({ type: "inlineMath", props: { latex: m[2] } });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return [node];
  if (last < text.length) out.push({ ...node, text: text.slice(last) });
  return out;
}

/** Apply `splitInlineMath` across a block's inline content. */
function withInlineMath(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out: InlineNode[] = [];
  for (const node of content) {
    const n = node as InlineNode;
    if (n?.type !== "text" || typeof n.text !== "string") {
      out.push(n);
      continue;
    }
    const split = splitInlineMath(n);
    if (split.length !== 1) changed = true;
    out.push(...split);
  }
  return changed ? out : content;
}

/**
 * Lift display math out of raw Markdown before BlockNote parses it. Returns the
 * rewritten Markdown and a function that restores the math into the parsed
 * blocks (and splits inline `$ … $` in the rest).
 */
export function prepareMathForImport(markdown: string): {
  markdown: string;
  restore: (blocks: unknown[]) => unknown[];
} {
  const { rewritten, found } = extractBlockMath(markdown);

  const restore = (blocks: unknown[]): unknown[] =>
    mapBlocks(blocks, (block) => {
      const b = block as Block;
      const sole = soleText(b);
      const idx = sole ? found.findIndex((f) => f.placeholder === sole) : -1;
      if (idx !== -1) return { type: "math", props: { latex: found[idx].latex } };
      // Code holds `$VAR` legitimately, and cannot hold an inline node at all.
      if (b?.type && PLAIN_CONTENT_TYPES.has(b.type)) return block;
      const content = withInlineMath(b?.content);
      return content === b?.content ? block : { ...b, content };
    });

  return { markdown: rewritten, restore };
}

/** If a block is a paragraph whose only inline content is one text run, return it. */
function soleText(block: Block): string | null {
  if (block?.type !== "paragraph") return null;
  const content = block.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const node = content[0] as InlineNode;
  return typeof node.text === "string" ? node.text.trim() : null;
}
