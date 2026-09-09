/**
 * SearchModal (web) — the Ctrl/Cmd+K palette. Debounced categorized search
 * over `GET /search`: Pages (title matches), Labels (open the label-filtered
 * sidebar view), and Text in page (body matches with a highlighted snippet).
 * Full keyboard navigation: ↑/↓ move, Enter opens, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Label, type SearchResults } from "./api";
import { Icon } from "./Icon";

/** Fired on window when a search result asks the sidebar to filter by label. */
export const FILTER_LABEL_EVENT = "selfnote:filter-label";
export const emitFilterLabel = (labelId: string) =>
  window.dispatchEvent(new CustomEvent(FILTER_LABEL_EVENT, { detail: { labelId } }));

const EMPTY: SearchResults = { pages: [], labels: [], texts: [] };

/** One selectable row in the flattened result list. */
type Item =
  | { kind: "page"; id: string; title: string }
  | { kind: "label"; label: Label }
  | { kind: "text"; id: string; title: string; snippet: string };

/**
 * Escape everything, then re-enable the `<mark>` pairs `ts_headline` added —
 * the snippet is note text and must never render as live HTML.
 */
function snippetHtml(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

export function SearchModal({
  workspaceId,
  onOpenPage,
  onClose,
}: {
  workspaceId: string;
  onOpenPage: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Debounced search; stale responses are dropped.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(EMPTY);
      setSelected(0);
      return;
    }
    setBusy(true);
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.search(workspaceId, q);
        if (!stale) {
          setResults(r);
          setSelected(0);
        }
      } catch {
        if (!stale) setResults(EMPTY);
      } finally {
        if (!stale) setBusy(false);
      }
    }, 180);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, workspaceId]);

  const items: Item[] = useMemo(
    () => [
      ...results.pages.map((p) => ({ kind: "page" as const, id: p.id, title: p.title })),
      ...results.labels.map((label) => ({ kind: "label" as const, label })),
      ...results.texts.map((t) => ({
        kind: "text" as const,
        id: t.id,
        title: t.title,
        snippet: t.snippet,
      })),
    ],
    [results],
  );

  const activate = (item: Item) => {
    if (item.kind === "label") emitFilterLabel(item.label.id);
    else onOpenPage(item.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const next = (selected + dir + items.length) % items.length;
      setSelected(next);
      listRef.current
        ?.querySelectorAll(".search-item")
        [next]?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter" && items[selected]) {
      e.preventDefault();
      activate(items[selected]);
    }
  };

  // Rows render per category but select across the flat list — track offsets.
  let index = -1;
  const row = (item: Item, content: React.ReactNode) => {
    index += 1;
    const i = index;
    return (
      <button
        key={`${item.kind}-${item.kind === "label" ? item.label.id : item.id}`}
        className={i === selected ? "search-item on" : "search-item"}
        onMouseEnter={() => setSelected(i)}
        onClick={() => activate(item)}
      >
        {content}
      </button>
    );
  };

  const hasAny = items.length > 0;
  const q = query.trim();

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="search-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search pages, labels, and text…"
            onChange={(e) => setQuery(e.target.value)}
          />
          {busy ? <span className="search-busy" /> : <kbd>esc</kbd>}
        </div>
        <div className="search-results" ref={listRef}>
          {!q ? (
            <div className="search-hint">Type to search this workspace.</div>
          ) : !hasAny && !busy ? (
            <div className="search-hint">No results for “{q}”.</div>
          ) : (
            <>
              {results.pages.length > 0 && (
                <div className="search-section">
                  <div className="search-section-title">Pages</div>
                  {results.pages.map((p) =>
                    row({ kind: "page", id: p.id, title: p.title }, (
                      <>
                        <span className="search-item-icon"><Icon name="file-text" size={14} /></span>
                        <span className="search-item-title">{p.title || "Untitled"}</span>
                      </>
                    )),
                  )}
                </div>
              )}
              {results.labels.length > 0 && (
                <div className="search-section">
                  <div className="search-section-title">Labels</div>
                  {results.labels.map((label) =>
                    row({ kind: "label", label }, (
                      <>
                        <span
                          className="label-dot"
                          style={{ ["--chip" as string]: label.color }}
                        />
                        <span className="search-item-title">{label.name}</span>
                        <span className="search-item-hint">filter pages</span>
                      </>
                    )),
                  )}
                </div>
              )}
              {results.texts.length > 0 && (
                <div className="search-section">
                  <div className="search-section-title">Text in page</div>
                  {results.texts.map((t) =>
                    row({ kind: "text", id: t.id, title: t.title, snippet: t.snippet }, (
                      <span className="search-item-text">
                        <span className="search-item-title">{t.title || "Untitled"}</span>
                        <span
                          className="search-item-snippet"
                          dangerouslySetInnerHTML={{ __html: snippetHtml(t.snippet) }}
                        />
                      </span>
                    )),
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
