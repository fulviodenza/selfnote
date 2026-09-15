# Math Formulas

Status: implemented · Owner: editor · Target apps: web, desktop, mobile

## 1. Problem and goal

Selfnote had no math support. LaTeX typed or pasted into a page stayed literal
text on every client, so a note deriving a metric read as dollar signs and
backslashes rather than as mathematics. Pages of this shape are common: they are
what the AI assist panel produces when asked to derive a formula, and what gets
pasted in from other tools.

The goal is that both display math (`$$ ... $$`) and inline math (`$ ... $`)
render as formulas in the editor, on web, desktop and mobile, and that Markdown
round-trips through both directions unchanged.

## 2. Data model and migration

None. Math lives in the existing Yjs `document-store` fragment as two new block
schema entries. No new tables, columns or endpoints.

## 3. Renderer

[KaTeX](https://katex.org) 0.18, pinned.

It renders synchronously, needs no layout passes, and ships a self-contained
stylesheet. Decisively, its `throwOnError: false` mode turns a malformed formula
into visible red source instead of an exception, which matters because pasted
math is frequently broken and a broken formula must never take the editor down.

MathJax was considered and rejected: asynchronous typesetting inside a
ProseMirror node view is a much worse fit, and the bundle is far larger.

## 4. Schema, and the parity rule that governs it

Two additions to the shared schema:

```js
MATH_BLOCK_CONFIG  = { type: "math",       propSchema: { latex: { default: "" } }, content: "none" }
MATH_INLINE_CONFIG = { type: "inlineMath", propSchema: { latex: { default: "" } }, content: "none" }
```

> [!IMPORTANT]
> Both configs are part of the shared Yjs schema and are subject to the same
> CRDT parity rule as `CALLOUT_CONFIG`: the config (type, propSchema, content)
> must be byte-for-byte identical between `packages/editor/src/math.tsx` and the
> vanilla mirror in `apps/mobile/src/editor/editorHtml.ts`, or collaboration
> desyncs with "unknown node type".

The LaTeX source lives in a `latex` prop rather than as editable inline content.
Content would mean ProseMirror trying to manage a text selection inside a node
whose DOM is KaTeX's generated span tree, which fights the renderer. A prop keeps
the rendered output non-editable and the source edited deliberately.

The cost is that two people editing the same formula concurrently resolve last
write wins rather than merging character by character. That is the right trade
for a formula: a half-merged LaTeX expression is not a useful intermediate state.

## 5. Editing

A rendered formula is `contenteditable=false`. Clicking or tapping it opens a
source editor:

- **Block**: the block expands into a monospace textarea holding the LaTeX, with
  a live KaTeX preview underneath. Escape or blur commits the prop and collapses
  back to the rendered form.
- **Inline**: the formula is swapped for a single-line input in place, rather
  than a floating popover. It keeps the caret where the user is looking, needs
  no positioning logic, and works on a phone.

An empty formula that loses focus deletes itself, so an accidental `/math`
leaves nothing behind.

## 6. Entry points

| trigger | result |
| --- | --- |
| `/math` slash command | empty math block, source editor open |
| `$$` then space at the start of an empty paragraph | that paragraph becomes a math block |
| a closing `$` completing `$ ... $` in a paragraph | that run becomes inline math |

The inline rule requires a body that both opens and closes on a non-space, which
is the rule remark-math uses. That is what keeps `$5 for lunch and $10 for
dinner` intact: the text between those two dollars ends in a space, so the second
`$` is not a closing delimiter. A body of only digits and arithmetic punctuation
is also rejected, because `$5-$10 range` satisfies the delimiter rule but is a
price. The cost of that second guard is that `$1+1$` stays literal; write
`$1 + 1 = 2$`, or use a display block. `\$` stays literal throughout.

On web both rules are genuine `prosemirror-inputrules` rules, mirroring
`calloutInputRule.ts`. On mobile only the block rule exists, using the keydown
approach `setupCalloutInputRule` already established, because the WebView bundle
carries no `prosemirror-inputrules` import and the inline rule needs to rewrite a
text range, which needs the transaction. Inline math still reaches mobile through
pasted or synced Markdown, and renders and edits identically once there.

## 7. Markdown round-trip

`packages/editor/src/mathMarkdown.ts` follows the sentinel-splice shape that
`calloutMarkdown.ts` already uses for callouts, and the two compose inside the
existing `blocksToMarkdownWithCallouts` / `markdownToBlocksWithCallouts` entry
points, so callers do not change.

| block | Markdown |
| --- | --- |
| `math` | `$$\n<latex>\n$$` |
| `inlineMath` | `$<latex>$` |

Import lifts `$$ ... $$` runs out before handing the rest to BlockNote, then
re-inserts them as math blocks at the right positions; inline `$ ... $` is
matched inside the resulting paragraphs, including inside callout bodies.

A display run must open its own line and must not sit inside a blockquote, so a
`$$` in a callout body is left to the callout pass rather than hoisted out of its
quote. An unterminated `$$` stays literal text rather than swallowing the rest of
the note, and `$$ $$` produces nothing rather than an empty box.

`tools/mcp-server/src/math.ts` carries a port of this module, alongside the
existing callout port, so MCP consumers and AI proposals see the same Markdown
and do not drop formulas.

## 8. AI assist replies

`apps/web/src/AssistPanel.tsx` and `NoteAiActions.tsx` render assistant output
with `react-markdown` and `remark-gfm`. `remark-math` and `rehype-katex` join
that pipeline, so math renders in chat too, which is where much of it is
produced in the first place.

## 9. Per-client notes

- **Web and desktop**: `packages/editor/src/math.tsx` defines both specs through
  `createReactBlockSpec` and `createReactInlineContentSpec`. Desktop is the
  Tauri shell over `apps/web/dist`, so it ships with the web build.
- **Mobile**: `editorHtml.ts` mirrors the configs literally, imports KaTeX and
  its stylesheet from the same pinned CDN as the other editor dependencies, and
  builds the specs with the vanilla `createBlockSpec` API, exactly as it already
  does for `callout`. Math styles join the document's Ink and Paper token block
  so formulas follow the theme.

## 10. Verification

- Paste a note mixing `$$` blocks and inline `$...$` into a page on web: blocks
  render centered, inline renders in place, broken fragments show as red source
  rather than crashing.
- Export to Markdown and confirm the LaTeX comes back unchanged.
- Open the same page on mobile: identical rendering, no schema desync in the
  console.
- Type `$5 for lunch and $10 for dinner` and confirm nothing converts.
- Ask the assistant for a formula and confirm the reply renders.
