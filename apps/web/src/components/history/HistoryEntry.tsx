/**
 * One row in the version-history timeline: a `kind` badge, optional label,
 * author name, relative time, and size. Clicking selects it for preview.
 */
import type { Checkpoint, CheckpointKind } from "../../api";
import { formatBytes, relativeTime } from "./relativeTime";

const KIND_LABEL: Record<CheckpointKind, string> = {
  manual: "Saved",
  auto: "Auto",
  restore: "Restore",
};

export function HistoryEntry({
  checkpoint,
  selected,
  onSelect,
}: {
  checkpoint: Checkpoint;
  selected: boolean;
  onSelect: () => void;
}) {
  const { kind, label, created_by_name, size_bytes, created_at } = checkpoint;
  return (
    <button
      className={selected ? "history-entry selected" : "history-entry"}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="history-entry-top">
        <span className={`history-badge ${kind}`}>{KIND_LABEL[kind]}</span>
        <span className="history-entry-time">{relativeTime(created_at)}</span>
      </div>
      {label ? <div className="history-entry-label">{label}</div> : null}
      <div className="history-entry-meta">
        <span>{created_by_name ?? "System"}</span>
        <span className="history-entry-dot">·</span>
        <span>{formatBytes(size_bytes)}</span>
      </div>
    </button>
  );
}
