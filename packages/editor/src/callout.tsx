/**
 * Callout block — a Notion / GitHub-alert style tinted box with an icon and
 * editable inline content. Typing `[!note] ` (etc.) at the start of an empty
 * paragraph converts it into a callout; it round-trips to a GitHub alert
 * blockquote in Markdown.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️  CRDT PARITY — this block's *config* (type, propSchema, content) is part of
 * the shared Yjs schema. The mobile vanilla editor
 * (apps/mobile/src/editor/editorHtml.ts) MUST define a byte-for-byte identical
 * config, or collaboration desyncs ("unknown node type"). See CALLOUT_CONFIG.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { createReactBlockSpec } from "@blocknote/react";
import type { ReactNode } from "react";

/** The five callout kinds (GitHub alert parity), in menu order. */
export const CALLOUT_KINDS = ["note", "tip", "warning", "important", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * The SHARED block config. Mobile mirrors this exactly (values order included).
 * type: "callout" · content: "inline" · one enum prop `kind` (default "note").
 */
export const CALLOUT_CONFIG = {
  type: "callout" as const,
  propSchema: {
    kind: { default: "note" as const, values: CALLOUT_KINDS },
  },
  content: "inline" as const,
};

/** Uppercase label GitHub uses for the alert marker (`[!NOTE]`, `[!TIP]`, …). */
export function calloutLabel(kind: CalloutKind): string {
  return kind.toUpperCase();
}

/** Parse a `[!kind]` marker (case-insensitive) into a known kind, else null. */
export function parseCalloutMarker(raw: string): CalloutKind | null {
  const m = /^\s*(?:>\s*)?\[!(\w+)\]/i.exec(raw);
  if (!m) return null;
  const k = m[1].toLowerCase();
  return (CALLOUT_KINDS as readonly string[]).includes(k) ? (k as CalloutKind) : null;
}

/* ------------------------------------------------------------------ icons -- */
// Feather-style 24×24 line icons (stroke=currentColor, width 2), matching
// apps/web/src/Icon.tsx. Kept as raw SVG-path strings so the *same* markup can
// be reused by the mobile vanilla renderer (see editorHtml.ts CALLOUT_ICONS).

/** SVG inner paths per kind, as a raw markup string (no <svg> wrapper). */
export const CALLOUT_ICON_PATHS: Record<CalloutKind, string> = {
  // info circle
  note: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  // check circle
  tip: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
  // alert triangle
  warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
  // alert octagon
  important: '<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2Z"/><path d="M12 8v4M12 16h.01"/>',
  // alert circle
  caution: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
};

/** Full inline SVG string for a kind (used by markup-based hosts). */
export function calloutIconSvg(kind: CalloutKind, size = 20): string {
  return (
    `<svg class="callout-icon" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    `stroke-linejoin="round" aria-hidden="true">${CALLOUT_ICON_PATHS[kind]}</svg>`
  );
}

/** React element form of the icon, for the web block render. */
function CalloutIcon({ kind }: { kind: CalloutKind }): ReactNode {
  return (
    <svg
      className="callout-icon"
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: CALLOUT_ICON_PATHS[kind] }}
    />
  );
}

/**
 * The web (React) callout block spec. `createReactBlockSpec` returns a factory
 * `(options?) => BlockSpec` in BlockNote 0.54, so callers must *invoke* it:
 * `{ callout: CalloutBlock() }`.
 */
export const CalloutBlock = createReactBlockSpec(CALLOUT_CONFIG, {
  render: ({ block, contentRef }) => {
    const kind = (block.props.kind || "note") as CalloutKind;
    return (
      <div className={`callout callout-${kind}`} data-kind={kind}>
        <div className="callout-icon-wrap" contentEditable={false}>
          <CalloutIcon kind={kind} />
        </div>
        <div className="callout-body" ref={contentRef} />
      </div>
    );
  },
});

/* --------------------------------------------------------- CSS (shared) ---- */
/**
 * Callout styles, using the Ink & Paper CSS vars. Injected once by the editor so
 * the block is styled wherever it renders (main editor + headless previews).
 * Also exported so the AI Assist chat can reuse the same `.callout` classes.
 */
export const CALLOUT_CSS = `
.callout {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 6px 0;
  padding: 12px 14px;
  border: 1px solid var(--callout-accent, var(--accent, #2b44c7));
  border-left-width: 4px;
  border-radius: var(--radius-md, 12px);
  background: var(--callout-wash, var(--accent-wash, #eaedfb));
  color: var(--fg, #1b1d22);
}
.callout .callout-icon-wrap {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  color: var(--callout-accent, var(--accent, #2b44c7));
  user-select: none;
}
.callout .callout-icon { display: block; }
.callout .callout-body { flex: 1; min-width: 0; }
.callout .callout-body > * { margin: 0; }

.callout-note {
  --callout-accent: var(--accent, #2b44c7);
  --callout-wash: var(--accent-wash, #eaedfb);
}
.callout-tip {
  --callout-accent: var(--live, #1f9e6a);
  --callout-wash: color-mix(in srgb, var(--live, #1f9e6a) 12%, transparent);
}
.callout-warning {
  --callout-accent: var(--warn, #c1841e);
  --callout-wash: color-mix(in srgb, var(--warn, #c1841e) 14%, transparent);
}
.callout-important {
  --callout-accent: #8b5cf6;
  --callout-wash: color-mix(in srgb, #8b5cf6 12%, transparent);
}
.callout-caution {
  --callout-accent: var(--danger, #c4392b);
  --callout-wash: color-mix(in srgb, var(--danger, #c4392b) 12%, transparent);
}
`;

/** Inject {@link CALLOUT_CSS} once into <head> (idempotent, keyed by id). */
export function ensureCalloutStyles(): void {
  if (typeof document === "undefined") return;
  const id = "selfnote-callout-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = CALLOUT_CSS;
  document.head.appendChild(style);
}

/* ------------------------------------------------- markdown round-trip ----- */
/**
 * Convert a callout block to a GitHub alert. Given the block's already-rendered
 * inline text (BlockNote's lossy markdown of the block content), emit:
 *
 *   > [!NOTE]
 *   > line one
 *   > line two
 */
export function calloutToMarkdown(kind: CalloutKind, innerMarkdown: string): string {
  const body = innerMarkdown.replace(/\s+$/, "");
  const lines = body.length ? body.split("\n") : [""];
  const quoted = lines.map((l) => (l ? `> ${l}` : ">")).join("\n");
  return `> [!${calloutLabel(kind)}]\n${quoted}`;
}
