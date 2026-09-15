/**
 * Inline task controls for a document, shown under the editor topbar.
 *
 * Two pieces, because they belong in two different places. `MakeTaskButton` is
 * the promote affordance for a page that is not a task; it is a chip in the
 * label row, since spending a whole bordered row on one button was most of the
 * header's vertical space for the overwhelmingly common case. `TaskControls` is
 * the row a real task earns: a status pill (cycles todo → in progress → done), a
 * priority selector, and a due-date picker (date + optional time when not
 * all-day). Every edit fires `updateTask`. "Remove task" (demote) lives in the
 * caller's page menu.
 */
import { useEffect, useState } from "react";
import { api, type Task } from "./api";
import {
  NEXT_STATUS,
  PRIORITIES,
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  STATUS_LABEL,
  fromDateTimeInput,
  toDateInput,
  toTimeInput,
} from "./tasks";
import { Icon } from "./Icon";

/** Promote a page to a task. Rendered as a chip in the label row. */
export function MakeTaskButton({
  docId,
  onChange,
}: {
  docId: string;
  /** Report the new task up, which swaps this chip for the task row. */
  onChange: (task: Task | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        className="task-make"
        disabled={busy}
        title={error ?? undefined}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            onChange(await api.setTask(docId, {}));
          } catch {
            // Without this the rejection is unhandled and the chip just
            // re-enables, which reads as "nothing happened" rather than
            // "that failed". The message renders beside it, as LabelBar's
            // own errors do.
            setError("Couldn't make this page a task.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="check-square" size={12} /> Make task
      </button>
      {error && <span className="label-error">{error}</span>}
    </>
  );
}

export function TaskControls({
  docId,
  task,
  onChange,
}: {
  docId: string;
  /** Current task metadata. Callers render `MakeTaskButton` instead when null. */
  task: Task;
  /** Report the new task state up (or `null` after demotion). */
  onChange: (task: Task | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  return <TaskEditor docId={docId} task={task} onChange={onChange} setBusy={setBusy} busy={busy} />;
}

function TaskEditor({
  docId,
  task,
  onChange,
  busy,
  setBusy,
}: {
  docId: string;
  task: Task;
  onChange: (task: Task | null) => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
}) {
  // Local, editable copies of the date/time inputs (kept in sync with `task`).
  const [date, setDate] = useState(() => toDateInput(task.due_at));
  const [time, setTime] = useState(() => toTimeInput(task.due_at));

  useEffect(() => {
    setDate(toDateInput(task.due_at));
    setTime(toTimeInput(task.due_at));
  }, [task.due_at]);

  const patch = async (body: Parameters<typeof api.updateTask>[1]) => {
    if (busy) return;
    setBusy(true);
    try {
      onChange(await api.updateTask(docId, body));
    } finally {
      setBusy(false);
    }
  };

  const cycleStatus = () => void patch({ status: NEXT_STATUS[task.status] });

  const commitDue = (nextDate: string, nextTime: string) => {
    const due = fromDateTimeInput(nextDate, task.due_all_day ? null : nextTime || null);
    void patch({ due_at: due });
  };

  return (
    <div className="task-bar">
      <button
        className={`task-pill status-${task.status}`}
        onClick={cycleStatus}
        disabled={busy}
        title="Cycle status"
      >
        <span className="task-pill-mark">
          <Icon name={task.status === "done" ? "check" : "circle"} size={14} />
        </span>
        {STATUS_LABEL[task.status]}
      </button>

      <label className="task-field">
        <span className="task-field-label">Priority</span>
        <span className="task-select-wrap">
          <span className="task-dot" style={{ background: PRIORITY_COLOR[task.priority] }} />
          <select
            className="task-select"
            value={task.priority}
            disabled={busy}
            onChange={(e) => void patch({ priority: e.target.value as Task["priority"] })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </span>
      </label>

      <label className="task-field">
        <span className="task-field-label">Due</span>
        <input
          type="date"
          className="task-date"
          value={date}
          disabled={busy}
          onChange={(e) => {
            setDate(e.target.value);
            if (e.target.value) commitDue(e.target.value, time);
            else void patch({ due_at: null });
          }}
        />
        {!task.due_all_day && (
          <input
            type="time"
            className="task-time"
            value={time}
            disabled={busy || !date}
            onChange={(e) => {
              setTime(e.target.value);
              if (date) commitDue(date, e.target.value);
            }}
          />
        )}
      </label>

      <label className="task-allday">
        <input
          type="checkbox"
          checked={task.due_all_day}
          disabled={busy}
          onChange={(e) => void patch({ due_all_day: e.target.checked })}
        />
        All day
      </label>
    </div>
  );
}
