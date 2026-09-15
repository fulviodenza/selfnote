/**
 * Math blocks and inline math, rendered with KaTeX.
 *
 * Display math (`$$ ... $$`) is a block; inline math (`$ ... $`) is custom
 * inline content. Both store their LaTeX in a `latex` prop and render
 * non-editable output, with the source edited deliberately in a text field.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️  CRDT PARITY: both *configs* (type, propSchema, content) are part of the
 * shared Yjs schema. The mobile vanilla editor
 * (apps/mobile/src/editor/editorHtml.ts) MUST define byte-for-byte identical
 * configs, or collaboration desyncs ("unknown node type"). See
 * MATH_BLOCK_CONFIG / MATH_INLINE_CONFIG, and the same warning on
 * CALLOUT_CONFIG in callout.tsx.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import katex from "katex";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";

/**
 * The SHARED block config. Mobile mirrors this exactly.
 * type: "math" · content: "none" · one string prop `latex`.
 *
 * The source lives in a prop rather than as inline content on purpose.
 * Content would mean ProseMirror managing a text selection inside a node whose
 * DOM is KaTeX's generated span tree, which fights the renderer. The cost is
 * that two people editing the same formula at once resolve last write wins
 * instead of merging, which is the right trade: a half-merged LaTeX expression
 * is not a useful intermediate state.
 */
export const MATH_BLOCK_CONFIG = {
  type: "math" as const,
  propSchema: {
    latex: { default: "" as const },
  },
  content: "none" as const,
};

/** The SHARED inline config. Mobile mirrors this exactly. */
export const MATH_INLINE_CONFIG = {
  type: "inlineMath" as const,
  propSchema: {
    latex: { default: "" as const },
  },
  content: "none" as const,
};

/**
 * LaTeX to HTML.
 *
 * `throwOnError: false` is load-bearing rather than defensive: pasted math is
 * frequently malformed (stray continuations, mangled subscripts), and a broken
 * formula must degrade to visible red source, never take the editor down.
 * `strict: false` keeps KaTeX quiet about the Unicode and spacing quirks that
 * survive a copy-paste out of another tool.
 */
export function renderMathHtml(latex: string, displayMode: boolean): string {
  return katex.renderToString(latex, {
    displayMode,
    throwOnError: false,
    errorColor: "#c4392b",
    strict: false,
  });
}

/*
 * Set by the insertion sites (the /math slash item and the `$$` input rule)
 * immediately before they create a block, and consumed by the first render of
 * that block, which is the only one that should open its source field.
 *
 * A module-level latch rather than a block prop because "was just inserted" is
 * local intent, not document state: it must not sync to other clients, and it
 * must not survive a reload.
 */
let mathJustInserted = false;

/** Record that this client is about to insert a formula. */
export function markMathInserted(): void {
  mathJustInserted = true;
}

/** Take the flag, if it is set. */
function consumeMathInsertion(): boolean {
  const was = mathJustInserted;
  mathJustInserted = false;
  return was;
}

/** Rendered formula, or a placeholder when there is nothing to render yet. */
function Rendered({
  latex,
  display,
  onEdit,
  editable,
}: {
  latex: string;
  display: boolean;
  onEdit: () => void;
  editable: boolean;
}) {
  if (!latex) {
    return (
      <span className="math-empty" onClick={editable ? onEdit : undefined}>
        Empty formula
      </span>
    );
  }
  return (
    <span
      className={display ? "math-render math-render-block" : "math-render"}
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={`Math: ${latex}`}
      onClick={editable ? onEdit : undefined}
      onKeyDown={
        editable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onEdit();
              }
            }
          : undefined
      }
      dangerouslySetInnerHTML={{ __html: renderMathHtml(latex, display) }}
    />
  );
}

/**
 * The display math block. Clicking the formula opens a textarea holding the
 * LaTeX with a live preview under it; Escape or blur commits.
 */
export const MathBlock = createReactBlockSpec(MATH_BLOCK_CONFIG, {
  render: ({ block, editor }) => {
    const latex = block.props.latex ?? "";
    const editable = editor.isEditable;
    // A formula this client just inserted opens straight into its source field:
    // nobody wants to insert one and then click it. Gated on the insertion flag
    // rather than on emptiness alone, so an empty formula arriving from a peer,
    // or one re-rendered on load, does not grab focus.
    const [editing, setEditing] = useState(() => editable && latex === "" && consumeMathInsertion());
    const [draft, setDraft] = useState(latex);
    const ref = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
      setDraft(latex);
    }, [latex]);

    useEffect(() => {
      if (editing) ref.current?.focus();
    }, [editing]);

    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      // Emptiness is checked before the no-op short-circuit: for a block that
      // /math just created, `next` and `latex` are both "", so an equality test
      // first would leave the empty block in the document forever, reopening
      // and stealing focus on every mount.
      if (next === "") {
        editor.removeBlocks([block]);
        return;
      }
      if (next === latex) return;
      editor.updateBlock(block, { props: { latex: next } });
    };

    if (!editing) {
      return (
        <div className="math-block" data-latex={latex}>
          <Rendered
            latex={latex}
            display
            editable={editable}
            onEdit={() => setEditing(true)}
          />
        </div>
      );
    }

    return (
      <div className="math-block math-block-editing">
        <textarea
          ref={ref}
          className="math-source"
          value={draft}
          spellCheck={false}
          aria-label="LaTeX source"
          placeholder="\\frac{a}{b}"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter inserts a newline (formulas are multi-line); Escape commits.
            if (e.key === "Escape") {
              e.preventDefault();
              commit();
            }
          }}
        />
        <div
          className="math-preview"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: renderMathHtml(draft, true) }}
        />
      </div>
    );
  },
});

/**
 * Inline math. Editing swaps the formula for a single-line input in place,
 * rather than a floating popover: it keeps the caret where the user is looking
 * and needs no positioning logic, which also makes it work on a phone.
 */
export const InlineMath = createReactInlineContentSpec(MATH_INLINE_CONFIG, {
  render: ({ inlineContent, updateInlineContent, editor }) => {
    const latex = (inlineContent.props.latex as string) ?? "";
    const editable = editor.isEditable;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(latex);
    const ref = useRef<HTMLInputElement>(null);

    useEffect(() => {
      setDraft(latex);
    }, [latex]);

    useEffect(() => {
      if (editing) ref.current?.focus();
    }, [editing]);

    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      // An inline node cannot delete itself through `updateInlineContent`, so
      // committing "" would strand an "Empty formula" chip mid-sentence that
      // clicking only reopens, and that exports as a bare "$$". Refuse the empty
      // commit instead; the node is removed the way every other inline node is,
      // with backspace.
      if (next === "") {
        setDraft(latex);
        return;
      }
      if (next !== latex) {
        updateInlineContent({ type: "inlineMath", props: { latex: next } });
      }
    };

    if (!editing) {
      return (
        <Rendered
          latex={latex}
          display={false}
          editable={editable}
          onEdit={() => setEditing(true)}
        />
      );
    }

    return (
      <input
        ref={ref}
        className="math-source math-source-inline"
        value={draft}
        spellCheck={false}
        aria-label="LaTeX source"
        // Width tracks the content so the paragraph does not jump around while
        // a short formula is being edited.
        size={Math.max(draft.length + 1, 6)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            commit();
          }
        }}
      />
    );
  },
});

/* --------------------------------------------------------- CSS (shared) ---- */
/**
 * Math styles on the Ink & Paper vars, injected once by the editor so formulas
 * are styled wherever they render (main editor plus headless previews). Also
 * exported so the AI Assist chat can reuse the same classes.
 *
 * KaTeX's own stylesheet is imported separately; this only covers our wrappers.
 */
export const MATH_CSS = `
.math-block {
  margin: 10px 0;
  padding: 8px 12px;
  border-radius: var(--radius-md, 12px);
  overflow-x: auto;
}
.math-block .math-render-block { display: block; text-align: center; }
.math-block-editing {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--accent, #2b44c7);
  background: var(--accent-wash, #eaedfb);
}
.math-render { cursor: pointer; border-radius: 4px; }
.math-render:hover,
.math-render:focus-visible {
  background: var(--accent-wash, #eaedfb);
  outline: none;
}
.math-empty {
  cursor: pointer;
  color: var(--faint, #9a9ea6);
  font-style: italic;
}
.math-source {
  width: 100%;
  min-height: 64px;
  resize: vertical;
  border: 1px solid var(--border, #e2e1dc);
  border-radius: var(--radius-sm, 8px);
  padding: 8px 10px;
  background: var(--bg, #fff);
  color: var(--fg, #1b1d22);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  box-sizing: border-box;
}
.math-source-inline {
  width: auto;
  min-height: 0;
  padding: 1px 6px;
  font-size: 0.95em;
}
.math-preview {
  min-height: 24px;
  text-align: center;
  overflow-x: auto;
}
/* KaTeX renders its own error markup; make it read as an error in both themes. */
.math-render .katex-error,
.math-preview .katex-error {
  color: var(--danger, #c4392b);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;

/** Inject MATH_CSS once, mirroring ensureCalloutStyles. */
export function ensureMathStyles(): void {
  if (typeof document === "undefined") return;
  const id = "selfnote-math-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = MATH_CSS;
  document.head.appendChild(style);
}
