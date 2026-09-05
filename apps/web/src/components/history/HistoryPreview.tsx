/**
 * Read-only preview of a past document state (version-history time-travel §4).
 * Fetches the selected checkpoint's full merged state and renders it in a
 * non-editable BlockNote editor — it never mutates the live doc. Restore/Delete
 * are explicit, confirmed actions; Restore hands the caller the base64 update
 * returned by the server so the live editor converges immediately.
 */
import { useEffect, useState } from "react";
import { ReadOnlyPreview } from "@selfnote/editor";
import { api, type Checkpoint, type CheckpointState } from "../../api";
import { relativeTime } from "./relativeTime";
import { Icon } from "../../Icon";

export function HistoryPreview({
  docId,
  checkpoint,
  theme,
  canWrite,
  onRestored,
  onDeleted,
  onError,
}: {
  docId: string;
  checkpoint: Checkpoint;
  theme: "light" | "dark";
  /** Whether the caller may restore/delete (viewers see preview only). */
  canWrite: boolean;
  /** Called with the base64 restore update so the host applies it live. */
  onRestored: (update: string) => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<CheckpointState | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<"restore" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setState(null);
    setLoading(true);
    setConfirm(null);
    api
      .getCheckpoint(docId, checkpoint.id)
      .then((s) => alive && setState(s))
      .catch(() => {
        if (!alive) return;
        onError("Couldn’t load this version.");
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // Re-fetch only when the target checkpoint (or its doc) changes; `onError`
    // is a fresh setter each render and is deliberately not a dependency.
  }, [docId, checkpoint.id, onError]);

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.restoreCheckpoint(docId, checkpoint.id);
      onRestored(res.update);
    } catch {
      onError("Restore failed.");
      setBusy(false);
      setConfirm(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteCheckpoint(docId, checkpoint.id);
      onDeleted();
    } catch {
      onError("Couldn’t delete this version.");
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="history-preview">
      <div className="history-preview-banner">
        <span className="history-preview-eye"><Icon name="eye" size={15} /></span>
        <span>
          Read-only preview · {relativeTime(checkpoint.created_at)}
          {checkpoint.label ? ` · ${checkpoint.label}` : ""}
        </span>
      </div>

      <div className="history-preview-body">
        {loading ? (
          <div className="center-msg">Loading version…</div>
        ) : state ? (
          <ReadOnlyPreview updates={state.updates} theme={theme} />
        ) : (
          <div className="center-msg">Couldn’t load this version.</div>
        )}
      </div>

      {canWrite && (
        <div className="history-preview-actions">
          <button
            className="toggle"
            onClick={() => setConfirm("delete")}
            disabled={busy || loading}
          >
            Delete
          </button>
          <button
            className="toggle on"
            onClick={() => setConfirm("restore")}
            disabled={busy || loading || !state}
          >
            Restore this version
          </button>
        </div>
      )}

      {confirm && (
        <div className="history-confirm-scrim" onClick={() => !busy && setConfirm(null)}>
          <div className="history-confirm" onClick={(e) => e.stopPropagation()}>
            {confirm === "restore" ? (
              <>
                <div className="history-confirm-title">Restore this version?</div>
                <p className="history-confirm-body">
                  This replays the selected state onto the live document for everyone.
                  Your current state is saved as a restore point first, so nothing is
                  lost.
                </p>
                <div className="history-confirm-actions">
                  <button className="toggle" onClick={() => setConfirm(null)} disabled={busy}>
                    Cancel
                  </button>
                  <button className="toggle on" onClick={restore} disabled={busy}>
                    {busy ? "Restoring…" : "Restore"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="history-confirm-title">Delete this version?</div>
                <p className="history-confirm-body">
                  This removes the restore point from history. The document content is
                  not affected. This can’t be undone.
                </p>
                <div className="history-confirm-actions">
                  <button className="toggle" onClick={() => setConfirm(null)} disabled={busy}>
                    Cancel
                  </button>
                  <button className="toggle danger" onClick={remove} disabled={busy}>
                    {busy ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
