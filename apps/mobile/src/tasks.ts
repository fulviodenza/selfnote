/**
 * Client-side task helpers shared by the note task controls and the agenda
 * screen. The agenda group boundaries (Overdue / Today / Upcoming / Later /
 * No date / Done) are computed here from `due_at`, mirroring apps/web.
 */
import type { Task, TaskPriority, TaskStatus } from "./api";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

/** The status cycle used by the note pill and the agenda checkbox short-tap. */
export const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "done"];

export function nextStatus(s: TaskStatus): TaskStatus {
  return STATUS_ORDER[(STATUS_ORDER.indexOf(s) + 1) % STATUS_ORDER.length];
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
};

export const PRIORITY_ORDER: TaskPriority[] = ["none", "low", "medium", "high"];

/** Rank so that higher priority sorts first when a section sorts by priority. */
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2, none: 3 };

export type AgendaGroup = "overdue" | "today" | "upcoming" | "later" | "undated" | "done";

export const GROUP_TITLE: Record<AgendaGroup, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  later: "Later",
  undated: "No date",
  done: "Done",
};

/** Display order of agenda sections. */
export const GROUP_ORDER: AgendaGroup[] = [
  "overdue",
  "today",
  "upcoming",
  "later",
  "undated",
  "done",
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Which agenda section a task falls into, relative to `now`. */
export function groupFor(task: Task, now: Date = new Date()): AgendaGroup {
  if (task.status === "done") return "done";
  if (!task.due_at) return "undated";
  const due = new Date(task.due_at);
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  const msDay = 86_400_000;
  const diffDays = Math.round((dueDay.getTime() - today.getTime()) / msDay);
  if (task.due_all_day) {
    if (diffDays < 0) return "overdue";
  } else if (due.getTime() < now.getTime()) {
    return "overdue";
  }
  if (diffDays <= 0) return "today";
  if (diffDays <= 7) return "upcoming";
  return "later";
}

/** Bucket tasks into agenda sections, each internally sorted by due date. */
export function groupTasks(tasks: Task[], now: Date = new Date()) {
  const buckets = new Map<AgendaGroup, Task[]>();
  for (const g of GROUP_ORDER) buckets.set(g, []);
  for (const t of tasks) buckets.get(groupFor(t, now))!.push(t);
  for (const [, arr] of buckets) arr.sort(byDueThenPriority);
  return GROUP_ORDER.map((g) => ({ group: g, title: GROUP_TITLE[g], tasks: buckets.get(g)! })).filter(
    (s) => s.tasks.length > 0,
  );
}

/** Sort dated tasks ascending, undated last, ties broken by priority. */
function byDueThenPriority(a: Task, b: Task): number {
  if (a.due_at && b.due_at) {
    const d = new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    if (d !== 0) return d;
  } else if (a.due_at) {
    return -1;
  } else if (b.due_at) {
    return 1;
  }
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
}

/** A short, human relative label for a due date, e.g. "Today · 5:00 PM". */
export function dueLabel(task: Task, now: Date = new Date()): string {
  if (!task.due_at) return "No date";
  const due = new Date(task.due_at);
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  const diffDays = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000);

  let day: string;
  if (diffDays === 0) day = "Today";
  else if (diffDays === 1) day = "Tomorrow";
  else if (diffDays === -1) day = "Yesterday";
  else if (diffDays > 1 && diffDays <= 7) day = weekday(due);
  else day = monthDay(due);

  if (task.due_all_day) return day;
  return `${day} · ${clockTime(due)}`;
}

function weekday(d: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}

function monthDay(d: Date): string {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const base = `${m[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

function clockTime(d: Date): string {
  let h = d.getHours();
  const min = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}
