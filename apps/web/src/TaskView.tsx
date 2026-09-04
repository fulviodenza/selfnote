/**
 * Agenda / task view. Lists a workspace's tasks grouped client-side into
 * Overdue / Today / Upcoming / Later / No date, with a collapsed Done section.
 * Status filter chips scope the query; a leading checkbox toggles a task to
 * `done`; clicking a row opens the underlying document.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Task, type TaskStatus } from "./api";
import {
  GROUP_LABEL,
  OPEN_GROUPS,
  PRIORITY_COLOR,
  STATUS_LABEL,
  groupTasks,
  relativeDue,
} from "./tasks";

const STATUS_FILTERS: TaskStatus[] = ["todo", "in_progress", "done"];

export function TaskView({
  workspaceId,
  onOpen,
}: {
  workspaceId: string;
  /** Open the document behind a task row. */
  onOpen: (docId: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Empty set = no filter (all statuses).
  const [filter, setFilter] = useState<Set<TaskStatus>>(new Set());
  const [doneOpen, setDoneOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const status = filter.size ? Array.from(filter) : undefined;
      setTasks(await api.listTasks({ workspace_id: workspaceId, status, sort: "due_at" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTasks([]);
    }
  }, [workspaceId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => (tasks ? groupTasks(tasks) : null), [tasks]);

  const toggleFilter = (s: TaskStatus) =>
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const toggleDone = async (task: Task) => {
    const next: TaskStatus = task.status === "done" ? "todo" : "done";
    const updated = await api.updateTask(task.doc_id, { status: next });
    setTasks((prev) => prev?.map((t) => (t.doc_id === task.doc_id ? updated : t)) ?? prev);
  };

  return (
    <div className="taskview">
      <div className="taskview-head">
        <h1 className="taskview-title">Tasks</h1>
        <div className="taskview-filters">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              className={filter.has(s) ? "task-chip on" : "task-chip"}
              onClick={() => toggleFilter(s)}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="taskview-body">
        {error && <div className="taskview-error">{error}</div>}
        {tasks == null ? (
          <div className="taskview-muted">Loading…</div>
        ) : tasks.length === 0 ? (
          <div className="taskview-empty">
            No tasks yet. Promote any page to a task from its header.
          </div>
        ) : (
          <>
            {OPEN_GROUPS.map((key) => {
              const items = grouped!.get(key)!;
              if (items.length === 0) return null;
              return (
                <section key={key} className="task-group">
                  <div className="task-group-head">
                    <span className="task-group-label">{GROUP_LABEL[key]}</span>
                    <span className="task-group-count">{items.length}</span>
                  </div>
                  {items.map((t) => (
                    <TaskRow key={t.doc_id} task={t} onOpen={onOpen} onToggle={toggleDone} />
                  ))}
                </section>
              );
            })}

            {grouped!.get("done")!.length > 0 && (
              <section className="task-group">
                <button className="task-group-head as-toggle" onClick={() => setDoneOpen((v) => !v)}>
                  <span className="task-group-caret">{doneOpen ? "▾" : "▸"}</span>
                  <span className="task-group-label">{GROUP_LABEL.done}</span>
                  <span className="task-group-count">{grouped!.get("done")!.length}</span>
                </button>
                {doneOpen &&
                  grouped!
                    .get("done")!
                    .map((t) => (
                      <TaskRow key={t.doc_id} task={t} onOpen={onOpen} onToggle={toggleDone} />
                    ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onOpen,
  onToggle,
}: {
  task: Task;
  onOpen: (docId: string) => void;
  onToggle: (task: Task) => void;
}) {
  return (
    <div className="task-row" onClick={() => onOpen(task.doc_id)}>
      <input
        type="checkbox"
        className="task-check"
        checked={task.status === "done"}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggle(task)}
      />
      <span className="task-row-icon">{task.icon || "📄"}</span>
      <span className={task.status === "done" ? "task-row-title done" : "task-row-title"}>
        {task.title || "Untitled"}
      </span>
      {task.priority !== "none" && (
        <span
          className="task-dot"
          style={{ background: PRIORITY_COLOR[task.priority] }}
          title={task.priority}
        />
      )}
      {task.due_at && <span className="task-row-due">{relativeDue(task)}</span>}
    </div>
  );
}
