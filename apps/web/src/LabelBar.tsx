/**
 * LabelBar (web) — the note's labels as colored chips under the topbar, with an
 * add/remove picker over the workspace vocabulary and an AI "Suggest" flow
 * (`POST /ai/labels/suggest`) that proposes labels the user can accept one by
 * one. Suggestions are never persisted until accepted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BulkLabelStatus, type Label, type LabelSuggestion } from "./api";
import { Icon } from "./Icon";

/**
 * Fired on window whenever any label data changes (attach/detach, create,
 * rename, recolor, delete), so distant views — the sidebar tree, filters —
 * can refetch without prop-drilling through the app.
 */
export const LABELS_CHANGED_EVENT = "selfnote:labels-changed";
const emitLabelsChanged = () => window.dispatchEvent(new Event(LABELS_CHANGED_EVENT));

/** The server's default palette, offered as swatches when editing a label. */
export const LABEL_COLORS = [
  "#2B44C7", "#1F9E6A", "#C1841E", "#8B5CF6", "#C4392B", "#0E7490", "#B4468A", "#5B6472",
];

/**
 * Sidebar entry point for the bulk "label everything" job — useful right after
 * importing a vault. Starts the server job and polls progress while it runs.
 */
export function BulkLabelButton({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<BulkLabelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll while a job is running (also picks up a job started elsewhere).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api.bulkLabelStatus(workspaceId);
        if (!alive) return;
        setStatus(s);
        if (s.running) timer = setTimeout(tick, 2000);
      } catch {
        /* older server / offline — leave idle */
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [workspaceId, status?.running]);

  const start = async () => {
    setError(null);
    try {
      setStatus(await api.bulkLabelStart(workspaceId));
    } catch (e) {
      setError(
        e instanceof Error && /no ai provider/i.test(e.message)
          ? "No AI provider configured."
          : e instanceof Error && /already running/i.test(e.message)
            ? "Already running."
            : "Couldn’t start bulk labeling.",
      );
    }
  };

  if (status?.running) {
    return (
      <button className="foot-btn" disabled>
        <Icon name="sparkles" size={16} /> Labeling {status.done}/{status.total}…
      </button>
    );
  }
  return (
    <button className="foot-btn" onClick={() => void start()} title={error ?? undefined}>
      <Icon name="sparkles" size={16} />
      {error ? error : status && status.total > 0 && status.done === status.total
        ? `Labeled ${status.labeled} notes`
        : "Label all notes (AI)"}
    </button>
  );
}

/** Minimal view of the editor we need to hand the note text to the AI. */
interface TextSource {
  document: unknown[];
  blocksToMarkdownLossy: (blocks?: unknown[]) => Promise<string>;
}

export function LabelBar({
  docId,
  workspaceId,
  aiAvailable,
  editor,
}: {
  docId: string;
  workspaceId: string;
  aiAvailable: boolean;
  editor: TextSource | null;
}) {
  const [labels, setLabels] = useState<Label[]>([]);
  const [all, setAll] = useState<Label[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<LabelSuggestion[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const [mine, vocab] = await Promise.all([
        api.getDocLabels(docId),
        api.listLabels(workspaceId),
      ]);
      setLabels(mine);
      setAll(vocab);
    } catch {
      /* transient — leave whatever we had */
    }
  }, [docId, workspaceId]);

  useEffect(() => {
    setSuggestions(null);
    setPickerOpen(false);
    setQuery("");
    void reload();
  }, [reload]);

  const save = async (ids: string[]) => {
    try {
      setLabels(await api.setDocLabels(docId, ids));
      emitLabelsChanged();
    } catch {
      setError("Couldn’t update labels.");
      void reload();
    }
  };

  // Manage mode: the label being edited in the picker (rename/recolor/delete).
  const [editing, setEditing] = useState<Label | null>(null);

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const updated = await api.updateLabel(editing.id, {
        name: editing.name.trim(),
        color: editing.color,
      });
      setAll((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setLabels((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setEditing(null);
      emitLabelsChanged();
    } catch {
      setError("Couldn’t update the label.");
    }
  };

  const removeLabel = async () => {
    if (!editing) return;
    try {
      await api.deleteLabel(editing.id);
      setAll((prev) => prev.filter((l) => l.id !== editing.id));
      setLabels((prev) => prev.filter((l) => l.id !== editing.id));
      setEditing(null);
      emitLabelsChanged();
    } catch {
      setError("Couldn’t delete the label.");
    }
  };

  const toggle = (label: Label) => {
    const has = labels.some((l) => l.id === label.id);
    const ids = has
      ? labels.filter((l) => l.id !== label.id).map((l) => l.id)
      : [...labels.map((l) => l.id), label.id];
    void save(ids);
  };

  const createFromQuery = async () => {
    const name = query.trim();
    if (!name) return;
    try {
      const label = await api.createLabel(workspaceId, name);
      setAll((prev) =>
        prev.some((l) => l.id === label.id) ? prev : [...prev, label],
      );
      await save([...labels.map((l) => l.id), label.id]);
      setQuery("");
    } catch {
      setError("Couldn’t create the label.");
    }
  };

  const suggest = async () => {
    if (!editor || suggesting) return;
    setSuggesting(true);
    setError(null);
    try {
      const text = await editor.blocksToMarkdownLossy(editor.document);
      const got = await api.suggestLabels(docId, text);
      // Hide suggestions that are already attached.
      const attached = new Set(labels.map((l) => l.name.toLowerCase()));
      const fresh = got.filter((s) => !attached.has(s.name.toLowerCase()));
      setSuggestions(fresh);
      if (fresh.length === 0) setError("No new label suggestions.");
    } catch (e) {
      setError(
        e instanceof Error && /no ai provider/i.test(e.message)
          ? "No AI provider configured."
          : "Couldn’t get suggestions.",
      );
    } finally {
      setSuggesting(false);
    }
  };

  const accept = async (s: LabelSuggestion) => {
    try {
      const label = s.existing_id
        ? { id: s.existing_id }
        : await api.createLabel(workspaceId, s.name);
      await save([...labels.map((l) => l.id), label.id]);
      setSuggestions((prev) => prev?.filter((x) => x.name !== s.name) ?? null);
      void reload();
    } catch {
      setError("Couldn’t add the label.");
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = all.filter((l) => !q || l.name.toLowerCase().includes(q));
  const exactExists = all.some((l) => l.name.toLowerCase() === q);

  return (
    <div className="label-bar">
      {labels.map((l) => (
        <span key={l.id} className="label-chip" style={{ ["--chip" as string]: l.color }}>
          <span className="label-dot" />
          {l.name}
          <button
            className="label-chip-x"
            aria-label={`Remove label ${l.name}`}
            onClick={() => toggle(l)}
          >
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}

      <div className="label-add">
        <button
          className="label-add-btn"
          onClick={() => {
            setPickerOpen((v) => !v);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <Icon name="plus" size={12} /> Label
        </button>
        {pickerOpen && (
          <>
            <div className="label-pop-scrim" onClick={() => setPickerOpen(false)} />
            <div className="label-pop">
              <input
                ref={inputRef}
                value={query}
                placeholder="Filter or create…"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && q && !exactExists) void createFromQuery();
                  if (e.key === "Escape") setPickerOpen(false);
                }}
              />
              {editing && (
                <div className="label-edit">
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveEdit();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                  <div className="label-swatches">
                    {LABEL_COLORS.map((c) => (
                      <button
                        key={c}
                        className={editing.color === c ? "label-swatch on" : "label-swatch"}
                        style={{ ["--chip" as string]: c }}
                        aria-label={`Color ${c}`}
                        onClick={() => setEditing({ ...editing, color: c })}
                      />
                    ))}
                  </div>
                  <div className="label-edit-actions">
                    <button className="label-edit-delete" onClick={() => void removeLabel()}>
                      Delete
                    </button>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                    <button className="label-edit-save" onClick={() => void saveEdit()}>
                      Save
                    </button>
                  </div>
                </div>
              )}
              <div className="label-pop-list">
                {!editing && filtered.map((l) => {
                  const on = labels.some((x) => x.id === l.id);
                  return (
                    <div key={l.id} className={on ? "label-pop-item on" : "label-pop-item"}>
                      <button className="label-pop-main" onClick={() => toggle(l)}>
                        <span className="label-dot" style={{ ["--chip" as string]: l.color }} />
                        <span className="label-pop-name">{l.name}</span>
                        {on ? <Icon name="check" size={13} /> : null}
                      </button>
                      <button
                        className="label-pop-edit"
                        aria-label={`Edit label ${l.name}`}
                        onClick={() => setEditing(l)}
                      >
                        <Icon name="edit-3" size={12} />
                      </button>
                    </div>
                  );
                })}
                {q && !exactExists && (
                  <button className="label-pop-item create" onClick={() => void createFromQuery()}>
                    <Icon name="plus" size={13} /> Create “{query.trim()}”
                  </button>
                )}
                {filtered.length === 0 && !q && (
                  <div className="label-pop-empty">No labels yet — type to create one.</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {aiAvailable && (
        <button
          className="label-suggest-btn"
          onClick={() => void suggest()}
          disabled={suggesting || !editor}
          title="Suggest labels with AI"
        >
          <Icon name="sparkles" size={12} /> {suggesting ? "Suggesting…" : "Suggest"}
        </button>
      )}

      {suggestions && suggestions.length > 0 && (
        <span className="label-suggestions">
          {suggestions.map((s) => (
            <button
              key={s.name}
              className="label-chip suggestion"
              style={{ ["--chip" as string]: s.color ?? "var(--accent)" }}
              title={s.existing_id ? "Existing label" : "New label"}
              onClick={() => void accept(s)}
            >
              <Icon name="plus" size={11} /> {s.name}
            </button>
          ))}
          <button
            className="label-chip-x dismiss"
            aria-label="Dismiss suggestions"
            onClick={() => setSuggestions(null)}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      )}

      {error && <span className="label-error">{error}</span>}
    </div>
  );
}
