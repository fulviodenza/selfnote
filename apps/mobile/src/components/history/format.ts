/**
 * Small formatters shared by the version-history UI (docs/features/
 * version-history.md §5): relative timestamps, byte sizes, and kind labels.
 * Kept framework-free so both the list row and the preview header can reuse them.
 */
import type { CheckpointKind } from "../../api";

/** "just now" / "2m ago" / "3h ago" / "5d ago" / a locale date past a week. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Full, unambiguous timestamp for the read-only preview banner. */
export function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/** Human byte size: "812 B" / "20.4 KB" / "1.2 MB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Badge label for a checkpoint kind. */
export function kindLabel(kind: CheckpointKind): string {
  switch (kind) {
    case "manual":
      return "Saved";
    case "restore":
      return "Restore point";
    case "auto":
    default:
      return "Auto";
  }
}
