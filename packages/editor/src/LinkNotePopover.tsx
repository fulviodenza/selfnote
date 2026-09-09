/**
 * LinkNotePopover — the `/link-note` picker for the shared block editor.
 *
 * A lightweight floating list anchored to the caret. On open (empty query) it
 * shows the workspace's most-recently-updated notes ("recents"); as the user
 * types it debounces (~200 ms) and queries full-text search. Selecting a note
 * inserts an inline link into the current block and closes.
 *
 * Data access is injected via `provider` so the shared package stays platform
 * agnostic — the web app wires it to `apps/web/src/api.ts` (and mobile to its
 * own bridge). The component itself never touches the network directly.
 */
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A small Feather-style "file-text" glyph (stroke=currentColor) used as the
 * fallback icon for a note that has no custom emoji — no emoji in the UI.
 */
function FileGlyph() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}

/** Small globe glyph for the "link an external page" row. */
function GlobeGlyph() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
    </svg>
  );
}

/**
 * Normalize an external page reference typed by the user into an href, or null
 * when the input doesn't look external. Accepted forms:
 *  - full http(s) URLs (including notion.so links) — passed through;
 *  - a bare Notion page id, dashed or not, optionally prefixed "notion-id:" —
 *    becomes its notion.so URL;
 *  - a scheme-less "domain.tld/path" — https:// is assumed.
 */
export function externalPageHref(input: string): { href: string; label: string } | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\/\S+$/i.test(s)) return { href: s, label: s.replace(/^https?:\/\//i, "") };
  const id = s.replace(/^notion-id:\s*/i, "").replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(id)) {
    return { href: `https://www.notion.so/${id}`, label: "Notion page" };
  }
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/\S*)?$/i.test(s)) {
    return { href: `https://${s}`, label: s };
  }
  return null;
}

/** The subset of a document the picker needs to render + link. */
export interface LinkNoteDoc {
  id: string;
  title: string;
  icon: string | null;
  updated_at: string;
}

/** Injected data access for the picker (network + auth live in the host app). */
export interface LinkNoteProvider {
  /** Recent notes for an empty query — client shows the top 10, newest first. */
  recents: () => Promise<LinkNoteDoc[]>;
  /** Full-text search over titles for a non-empty query. */
  search: (q: string) => Promise<LinkNoteDoc[]>;
}

export interface LinkNotePopoverProps {
  provider: LinkNoteProvider;
  /** Viewport coordinates to anchor the popover near (usually the caret). */
  anchor: { top: number; left: number };
  /** Chosen note; the parent inserts the inline link. */
  onSelect: (doc: LinkNoteDoc) => void;
  /**
   * Chosen external page (URL / notion id typed into the search box); the
   * parent inserts a plain external link. Omitting hides the external row.
   */
  onSelectExternal?: (href: string, label: string) => void;
  /** Dismiss without selecting (Escape / outside click / empty results nav). */
  onClose: () => void;
}

const DEBOUNCE_MS = 200;
const RECENTS_LIMIT = 10;

export function LinkNotePopover({
  provider,
  anchor,
  onSelect,
  onSelectExternal,
  onClose,
}: LinkNotePopoverProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<LinkNoteDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // A URL / notion id in the search box offers an "external page" row above the
  // note results; it participates in keyboard navigation as index 0.
  const external = onSelectExternal ? externalPageHref(query) : null;
  const total = items.length + (external ? 1 : 0);

  // Focus the search field as soon as the picker opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced fetch: empty query → recents (top 10), else full-text search.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const q = query.trim();
    const run = async () => {
      try {
        const docs = q
          ? await provider.search(q)
          : (await provider.recents())
              .slice()
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
              .slice(0, RECENTS_LIMIT);
        if (alive) {
          setItems(docs);
          setActive(0);
        }
      } catch {
        if (alive) setItems([]);
      } finally {
        if (alive) setLoading(false);
      }
    };
    const t = setTimeout(run, q ? DEBOUNCE_MS : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, provider]);

  // Dismiss on an outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(total - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (external && active === 0) {
        onSelectExternal?.(external.href, external.label);
        return;
      }
      const doc = items[active - (external ? 1 : 0)];
      if (doc) onSelect(doc);
    }
  };

  const style = useMemo<React.CSSProperties>(
    () => ({ position: "fixed", top: anchor.top, left: anchor.left, zIndex: 3000 }),
    [anchor.top, anchor.left],
  );

  return (
    <div ref={rootRef} className="link-note-popover" style={style} onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="link-note-input"
        placeholder="Link to a note…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="link-note-list" role="listbox">
        {external && (
          <button
            type="button"
            role="option"
            aria-selected={active === 0}
            className={`link-note-item${active === 0 ? " is-active" : ""}`}
            onMouseEnter={() => setActive(0)}
            onClick={() => onSelectExternal?.(external.href, external.label)}
          >
            <span className="link-note-icon">
              <GlobeGlyph />
            </span>
            <span className="link-note-title">Link external page — {external.label}</span>
          </button>
        )}
        {loading && !external ? (
          <div className="link-note-empty">Searching…</div>
        ) : items.length === 0 && !external ? (
          <div className="link-note-empty">{query.trim() ? "No matches" : "No recent notes"}</div>
        ) : (
          items.map((doc, i) => {
            const idx = i + (external ? 1 : 0);
            return (
              <button
                key={doc.id}
                type="button"
                role="option"
                aria-selected={idx === active}
                className={`link-note-item${idx === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(idx)}
                onClick={() => onSelect(doc)}
              >
                <span className="link-note-icon">{doc.icon || <FileGlyph />}</span>
                <span className="link-note-title">{doc.title || "Untitled"}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
