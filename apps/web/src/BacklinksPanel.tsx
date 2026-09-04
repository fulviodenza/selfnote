/**
 * BacklinksPanel — "Linked references" for the open document.
 *
 * Rendered below the editor. On `docId` change it loads the notes that link
 * *here* (`GET /documents/:id/backlinks`) and, optionally, this note's own
 * outgoing references (`GET /documents/:id/links`). Both lists are collapsible;
 * clicking a row opens that document (see docs/features/backlinks-graph.md §4).
 *
 * Styling follows the "Ink & Paper" tokens in styles.css.
 */
import { useEffect, useState } from "react";
import { api, type Backlink, type OutgoingLink } from "./api";

export function BacklinksPanel({
  docId,
  refreshKey,
  onOpen,
}: {
  docId: string;
  /** Bump to re-fetch after the outgoing set is re-persisted (edits). */
  refreshKey?: number;
  onOpen: (id: string) => void;
}) {
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingLink[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let alive = true;
    setBacklinks(null);
    setOutgoing(null);
    api
      .getBacklinks(docId)
      .then((b) => alive && setBacklinks(b))
      .catch(() => alive && setBacklinks([]));
    api
      .getDocLinks(docId)
      .then((o) => alive && setOutgoing(o))
      .catch(() => alive && setOutgoing([]));
    return () => {
      alive = false;
    };
  }, [docId, refreshKey]);

  const loading = backlinks === null;
  const hasOutgoing = !!outgoing && outgoing.length > 0;

  return (
    <div className="backlinks">
      <button
        className="backlinks-head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="backlinks-caret">{collapsed ? "▸" : "▾"}</span>
        <span className="backlinks-title">Linked references</span>
        {backlinks && backlinks.length > 0 && (
          <span className="backlinks-count">{backlinks.length}</span>
        )}
      </button>

      {!collapsed && (
        <div className="backlinks-body">
          {loading ? (
            <div className="backlinks-empty">Loading…</div>
          ) : backlinks!.length === 0 ? (
            <div className="backlinks-empty">No notes link here yet.</div>
          ) : (
            <ul className="backlinks-list">
              {backlinks!.map((b) => (
                <li key={b.source.id}>
                  <button className="backlinks-item" onClick={() => onOpen(b.source.id)}>
                    <span className="backlinks-icon">{b.source.icon || "📄"}</span>
                    <span className="backlinks-item-text">
                      <span className="backlinks-item-title">
                        {b.source.title || "Untitled"}
                      </span>
                      {b.label && <span className="backlinks-item-label">{b.label}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {hasOutgoing && (
            <div className="backlinks-outgoing">
              <div className="backlinks-subtitle">Outgoing links</div>
              <ul className="backlinks-list">
                {outgoing!.map((o) => (
                  <li key={o.target.id}>
                    <button className="backlinks-item" onClick={() => onOpen(o.target.id)}>
                      <span className="backlinks-icon">{o.target.icon || "📄"}</span>
                      <span className="backlinks-item-text">
                        <span className="backlinks-item-title">
                          {o.target.title || "Untitled"}
                        </span>
                        {o.label && <span className="backlinks-item-label">{o.label}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
