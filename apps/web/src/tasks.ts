/**
 * Client-side task helpers shared by the agenda view and the inline task
 * controls: grouping by due date (Overdue / Today / Upcoming / Later / No date /
 * Done), relative due labels, and the small presentation tables (priority dots,
 * status labels/cycle). The group boundaries are computed here, not on the
 * server — `GET /tasks` returns a flat list.
 */
import type { Task, TaskPriority, TaskStatus } from "./api";

/** Stable group keys, in display order. `done` collects every completed task. */
export type TaskGroupKey = "overdue" | "today" | "upcoming" | "later" | "undated" | "done";

export const GROUP_LABEL: Record<TaskGroupKey, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  later: "Later",
  undated: "No date",
  done: "Done",
};

/** Non-done group order (Done is rendered separately, collapsed). */
export const OPEN_GROUPS: TaskGroupKey[] = ["overdue", "today", "upcoming", "later", "undated"];

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Which section a task belongs to, computed from `due_at` relative to `now`.
 * Any `done` task lands in the Done bucket regardless of its due date.
 */
export function groupFor(task: Task, now: Date = new Date()): TaskGroupKey {
  if (task.status === "done") return "done";
  if (!task.due_at) return "undated";
  const due = new Date(task.due_at);
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  if (dueDay.getTime() < today.getTime()) return "overdue";
  // A timed task earlier today but already past still counts as today (not overdue).
  if (dueDay.getTime() === today.getTime()) return "today";
  const days = Math.round((dueDay.getTime() - today.getTime()) / DAY_MS);
  return days <= 7 ? "upcoming" : "later";
}

/** Partition tasks into the ordered, display-ready group buckets. */
export function groupTasks(tasks: Task[], now: Date = new Date()): Map<TaskGroupKey, Task[]> {
  const out = new Map<TaskGroupKey, Task[]>();
  for (const key of [...OPEN_GROUPS, "done" as const]) out.set(key, []);
  for (const t of tasks) out.get(groupFor(t, now))!.push(t);
  return out;
}

/** A short, human relative label for a due instant (e.g. "in 3d", "Overdue 2d"). */
export function relativeDue(task: Task, now: Date = new Date()): string {
  if (!task.due_at) return "";
  const due = new Date(task.due_at);
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  const days = Math.round((dueDay.getTime() - today.getTime()) / DAY_MS);
  const time = task.due_all_day
    ? ""
    : " · " +
      due.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days < 0) return `Overdue ${Math.abs(days)}d`;
  if (days === 0) return `Today${time}`;
  if (days === 1) return `Tomorrow${time}`;
  if (days <= 7) return `${dueDay.toLocaleDateString(undefined, { weekday: "short" })}${time}`;
  return dueDay.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + time;
}

/** Format `due_at` for the `<input type="date">` value (local date). */
export function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format `due_at` for the `<input type="time">` value (local time, HH:MM). */
export function toTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Combine a local date (YYYY-MM-DD) and optional time (HH:MM) into an RFC3339
 * UTC instant. When `time` is empty the instant is midday local (a stable point
 * inside the day) so all-day tasks land on the intended calendar date.
 */
export function fromDateTimeInput(date: string, time: string | null): string | null {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  let hh = 12;
  let mm = 0;
  if (time) {
    const [h, min] = time.split(":").map(Number);
    hh = h;
    mm = min;
  }
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

/** The status a "cycle" click advances to (todo → in progress → done → todo). */
export const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

export const PRIORITIES: TaskPriority[] = ["none", "low", "medium", "high"];

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Themed dot colour per priority (`none` = no dot). */
export const PRIORITY_COLOR: Record<TaskPriority, string> = {
  none: "transparent",
  low: "var(--muted)",
  medium: "var(--warn)",
  high: "var(--danger)",
};
