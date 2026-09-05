/**
 * Version history / time-travel drawer (see docs/features/version-history.md §4).
 * Opens as a right-side panel (reusing the AI Assist layout), lists a document's
 * checkpoints newest-first with infinite scroll and kind filters, lets a
 * non-viewer "Save version", and previews any past state read-only. Selecting an
 * entry shows a read-only BlockNote preview with Restore / Delete actions; the
 * live document is never mutated until Restore is confirmed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Checkpoint, type CheckpointKind } from "../../api";
import { HistoryEntry } from "./HistoryEntry";
import { HistoryPreview } from "./HistoryPreview";
import { Icon } from "../../Icon";

const PAGE = 50;

const FILTERS: { value: CheckpointKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "manual", label: "Saved" },
  { value: "auto", label: "Auto" },
  { value: "restore", label: "Restores" },
];

export function HistoryPanel({
  docId,
  theme,
  canWrite,
  onClose,
  onRestored,
}: {
  docId: string;
  theme: "light" | "dark";
  /** Non-viewer: Save/Restore/Delete are available. */
  canWrite: boolean;
  onClose: () => void;
  /** Apply the restore update to the live editor doc, then close the panel. */
  onRestored: (update: string) => void;
}) {
  const [items, setItems] = useState<Checkpoint[]>([]);
  const [filter, setFilter] = useState<CheckpointKind | "all">("all");
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [selected, setSelected] = useState<Checkpoint | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  // Guards a race where a stale page resolves after the filter/doc changed.
  const runRef = useRef(0);

  const kindParam = filter === "all" ? undefined : filter;

  // (Re)load the first page whenever the document or filter changes.
  const loadFirst = useCallback(async () => {
    const run = ++runRef.current;
    setLoading(true);
    setError(null);
    setInitialLoaded(false);
    try {
      const page = await api.listHistory(docId, { limit: PAGE, kind: kindParam });
      if (run !== runRef.current) return;
      setItems(page.checkpoints);
      setNextBefore(page.next_before);
    } catch {
      if (run !== runRef.current) return;
      setError("Couldn’t load history.");
      setItems([]);
      setNextBefore(null);
    } finally {
      if (run === runRef.current) {
        setLoading(false);
        setInitialLoaded(true);
      }
    }
  }, [docId, kindParam]);

  useEffect(() => {
    setSelected(null);
    void loadFirst();
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (loading || !nextBefore) return;
    const run = runRef.current;
    setLoading(true);
    try {
      const page = await api.listHistory(docId, {
        limit: PAGE,
        before: nextBefore,
        kind: kindParam,
      });
      if (run !== runRef.current) return;
      setItems((prev) => [...prev, ...page.checkpoints]);
      setNextBefore(page.next_before);
    } catch {
      if (run === runRef.current) setError("Couldn’t load more history.");
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, [docId, kindParam, nextBefore, loading]);

  // Infinite scroll: fetch the next page as the list nears the bottom.
  const onScroll = () => {
    const el = threadRef.current;
    if (!el || loading || !nextBefore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) void loadMore();
  };

  const saveVersion = async () => {
    if (saving) return;
    const label = window.prompt("Name this version (optional):", "")?.trim();
    // A cancelled prompt returns null (undefined here); an empty string is fine.
    if (label === undefined) return;
    setSaving(true);
    setError(null);
    try {
      await api.createCheckpoint(docId, label || undefined);
      await loadFirst();
    } catch {
      setError("Couldn’t save this version.");
    } finally {
      setSaving(false);
    }
  };

  const handleRestored = (update: string) => {
    onRestored(update);
    onClose();
  };

  const handleDeleted = () => {
    if (selected) setItems((prev) => prev.filter((c) => c.id !== selected.id));
    setSelected(null);
  };

  return (
    <aside className="assist history-panel">
      <div className="assist-head">
        <div className="assist-brand">
          <span className="assist-spark"><Icon name="clock" size={16} /></span>
          <span className="assist-title">Version history</span>
        </div>
        <div className="assist-head-right">
          {canWrite && (
            <button className="assist-clear" onClick={saveVersion} disabled={saving}>
              {saving ? "Saving…" : "Save version"}
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>

      <div className="history-filters">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={filter === f.value ? "task-chip on" : "task-chip"}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="history-error">{error}</div>}

      <div className="history-list" ref={threadRef} onScroll={onScroll}>
        {!initialLoaded && loading ? (
          <div className="history-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="history-empty">
            No saved versions yet.
            {canWrite ? " Use “Save version” to create a restore point." : ""}
          </div>
        ) : (
          <>
            {items.map((c) => (
              <HistoryEntry
                key={c.id}
                checkpoint={c}
                selected={selected?.id === c.id}
                onSelect={() => setSelected(c)}
              />
            ))}
            {loading && <div className="history-empty">Loading…</div>}
          </>
        )}
      </div>

      {selected && (
        <HistoryPreview
          docId={docId}
          checkpoint={selected}
          theme={theme}
          canWrite={canWrite}
          onRestored={handleRestored}
          onDeleted={handleDeleted}
          onError={setError}
        />
      )}
    </aside>
  );
}
