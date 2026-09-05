/**
 * Context chips for AI Assist (web). A dismissible row of notes that will be
 * folded into the next chat turn as `extra_docs`, plus an "+ Add note" popover
 * that offers Linked notes, Recently-viewed notes, and a manual title search.
 * Purely a picker: it reports the selected set upward; AssistPanel resolves each
 * note's Markdown and sends it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Document } from "./api";
import { Icon } from "./Icon";

export type ContextSource = "linked" | "recent" | "manual";

/** A note the user has chosen as extra chat context. */
export interface SelectedNote {
  id: string;
  title: string;
  icon: string | null;
  source: ContextSource;
}

const SOURCE_LABEL: Record<ContextSource, string> = {
  linked: "Linked",
  recent: "Recent",
  manual: "Search",
};

/** A note offered in the popover, before selection. */
interface Candidate {
  id: string;
  title: string;
  icon: string | null;
  source: ContextSource;
}

export function ContextPicker({
  docId,
  workspaceId,
  selected,
  onChange,
}: {
  docId: string;
  workspaceId: string;
  selected: SelectedNote[];
  onChange: (next: SelectedNote[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [linked, setLinked] = useState<Candidate[]>([]);
  const [recent, setRecent] = useState<Candidate[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [hasLinks, setHasLinks] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  const selectedIds = useMemo(() => new Set(selected.map((s) => s.id)), [selected]);

  const add = (c: Candidate) => {
    if (c.id === docId || selectedIds.has(c.id)) return;
    onChange([...selected, { id: c.id, title: c.title, icon: c.icon, source: c.source }]);
  };
  const remove = (id: string) => onChange(selected.filter((s) => s.id !== id));

  // Load Linked + Recent when the popover opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .getDocLinks(docId)
      .then((links) => {
        if (!alive) return;
        setHasLinks(links.length > 0);
        setLinked(
          links.map((l) => ({
            id: l.target.id,
            title: l.target.title,
            icon: l.target.icon,
            source: "linked",
          })),
        );
      })
      .catch(() => alive && setLinked([]));
    api
      .recentDocuments(10)
      .then((docs) => {
        if (!alive) return;
        setRecent(
          docs
            .filter((d) => d.id !== docId)
            .map((d) => ({ id: d.id, title: d.title, icon: d.icon, source: "recent" })),
        );
      })
      .catch(() => alive && setRecent([]));
    return () => {
      alive = false;
    };
  }, [open, docId]);

  // Debounced title search for the manual case.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .searchDocuments(workspaceId, q)
        .then((docs: Document[]) => {
          if (!alive) return;
          setResults(
            docs
              .filter((d) => d.id !== docId)
              .map((d) => ({ id: d.id, title: d.title, icon: d.icon, source: "manual" })),
          );
        })
        .catch(() => alive && setResults([]));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, workspaceId, docId]);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pullLinked = async () => {
    try {
      const links = await api.getDocLinks(docId);
      const additions = links
        .map((l) => l.target)
        .filter((d) => d.id !== docId && !selectedIds.has(d.id))
        .map((d) => ({ id: d.id, title: d.title, icon: d.icon, source: "linked" as const }));
      if (additions.length) onChange([...selected, ...additions]);
    } catch {
      /* ignore */
    }
  };

  const linkedFree = linked.filter((c) => !selectedIds.has(c.id));
  const recentFree = recent.filter((c) => !selectedIds.has(c.id));
  const resultsFree = results.filter((c) => !selectedIds.has(c.id));

  return (
    <div className="ctx-picker">
      <div className="ctx-chips">
        {selected.map((s) => (
          <span key={s.id} className="ctx-chip" title={s.title || "Untitled"}>
            <span className="ctx-chip-icon">{s.icon || <Icon name="file-text" size={14} />}</span>
            <span className="ctx-chip-title">{s.title || "Untitled"}</span>
            <span className={`ctx-chip-src ${s.source}`}>{SOURCE_LABEL[s.source]}</span>
            <button className="ctx-chip-x" onClick={() => remove(s.id)} aria-label="Remove">
              <Icon name="x" size={13} />
            </button>
          </span>
        ))}
        <div className="ctx-add-wrap" ref={popRef}>
          <button className="ctx-add" onClick={() => setOpen((v) => !v)}>
            <Icon name="plus" size={14} /> Add note
          </button>
          {open && (
            <div className="ctx-pop">
              <input
                className="ctx-search"
                autoFocus
                placeholder="Search notes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="ctx-pop-body">
                {query.trim() ? (
                  <Section
                    label="Search"
                    items={resultsFree}
                    onPick={add}
                    empty="No matching notes."
                  />
                ) : (
                  <>
                    <Section
                      label="Linked"
                      items={linkedFree}
                      onPick={add}
                      empty="No linked notes."
                    />
                    <Section
                      label="Recent"
                      items={recentFree}
                      onPick={add}
                      empty="No recent notes."
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        {hasLinks && (
          <button className="ctx-pull" onClick={pullLinked}>
            <Icon name="link" size={14} /> Pull in linked notes
          </button>
        )}
      </div>
    </div>
  );
}

function Section({
  label,
  items,
  onPick,
  empty,
}: {
  label: string;
  items: Candidate[];
  onPick: (c: Candidate) => void;
  empty: string;
}) {
  return (
    <div className="ctx-sec">
      <div className="ctx-sec-label">{label}</div>
      {items.length === 0 ? (
        <div className="ctx-sec-empty">{empty}</div>
      ) : (
        items.map((c) => (
          <button key={c.id} className="ctx-opt" onClick={() => onPick(c)}>
            <span className="ctx-opt-icon">{c.icon || <Icon name="file-text" size={14} />}</span>
            <span className="ctx-opt-title">{c.title || "Untitled"}</span>
          </button>
        ))
      )}
    </div>
  );
}
