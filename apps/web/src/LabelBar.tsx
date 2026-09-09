/**
 * LabelBar (web) — the note's labels as colored chips under the topbar, with an
 * add/remove picker over the workspace vocabulary and an AI "Suggest" flow
 * (`POST /ai/labels/suggest`) that proposes labels the user can accept one by
 * one. Suggestions are never persisted until accepted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Label, type LabelSuggestion } from "./api";
import { Icon } from "./Icon";

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
    } catch {
      setError("Couldn’t update labels.");
      void reload();
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
              <div className="label-pop-list">
                {filtered.map((l) => {
                  const on = labels.some((x) => x.id === l.id);
                  return (
                    <button
                      key={l.id}
                      className={on ? "label-pop-item on" : "label-pop-item"}
                      onClick={() => toggle(l)}
                    >
                      <span className="label-dot" style={{ ["--chip" as string]: l.color }} />
                      <span className="label-pop-name">{l.name}</span>
                      {on ? <Icon name="check" size={13} /> : null}
                    </button>
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
