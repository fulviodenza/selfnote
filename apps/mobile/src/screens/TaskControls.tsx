/**
 * Task controls shown below the title on the note screen.
 *
 * Two pieces, because they belong in two different places. `MakeTaskButton` is
 * the promote affordance for a page that is not a task, and it is a chip in the
 * label row: spending a whole row on that one button was most of the header's
 * vertical space for the common case. `TaskControls` is the row a real task
 * earns: a status segmented control, a priority picker (sheet), and a due-date
 * picker (date + optional time when `due_all_day` is off). Every change fires
 * updateTask; "Remove task" lives in the note overflow menu.
 *
 * The task itself is owned by the caller, matching the web contract: the label
 * row and this row both need to know whether the page is a task, so one owner
 * above them both is the only arrangement that keeps them consistent.
 *
 * Strict parity with the web task panel (apps/web), against the same API
 * contract in docs/features/calendar-task-sync.md.
 */
import { useCallback, useMemo, useState } from "react";
import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api, type Task, type TaskPriority, type TaskStatus } from "../api";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  STATUS_LABEL,
  STATUS_ORDER,
  dueLabel,
} from "../tasks";
import { radius, spacing, sizing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { Button, Sheet } from "../ui";
import { PriorityDot } from "./PriorityDot";
import { DuePickerSheet } from "./DuePickerSheet";

/**
 * Promote a page to a task. Rendered as a chip in the label row, so it is
 * shaped like the chips beside it rather than like a standalone button.
 */
export function MakeTaskButton({
  docId,
  onChange,
  onError,
}: {
  docId: string;
  /** Report the new task up, which swaps this chip for the task row. */
  onChange: (task: Task | null) => void;
  onError?: (message: string | null) => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [busy, setBusy] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Make task"
      disabled={busy}
      onPress={async () => {
        if (busy) return;
        setBusy(true);
        onError?.(null);
        try {
          onChange(await api.setTask(docId, {}));
        } catch (e) {
          onError?.(e instanceof Error ? e.message.slice(0, 160) : String(e));
        } finally {
          setBusy(false);
        }
      }}
      style={({ pressed }) => [
        styles.makeChip,
        { backgroundColor: pressed ? colors.surfaceSunken : "transparent" },
      ]}
    >
      <Feather name="square" size={12} color={colors.inkSoft} />
      <Text style={styles.makeChipText}>{busy ? "Making task…" : "Make task"}</Text>
    </Pressable>
  );
}

export function TaskControls({
  docId,
  task,
  onChange,
  onError,
}: {
  docId: string;
  /** Callers render `MakeTaskButton` instead when the page is not a task. */
  task: Task;
  /** Report the new task state up (or `null` after demotion). */
  onChange: (task: Task | null) => void;
  /** Surfaced so the parent can toast; also cleared on success. */
  onError?: (message: string | null) => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [showPriority, setShowPriority] = useState(false);
  const [showDue, setShowDue] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);

  const fail = useCallback(
    (e: unknown) => onError?.(e instanceof Error ? e.message.slice(0, 160) : String(e)),
    [onError],
  );

  const patch = async (body: Parameters<typeof api.updateTask>[1]) => {
    onError?.(null);
    // Optimistic; reconcile with the server response.
    const prev = task;
    onChange({ ...task, ...body } as Task);
    try {
      onChange(await api.updateTask(docId, body));
    } catch (e) {
      onChange(prev);
      fail(e);
    }
  };

  const cycleStatus = (s: TaskStatus) => patch({ status: s });

  const removeTask = async () => {
    setShowOverflow(false);
    onError?.(null);
    const prev = task;
    onChange(null); // optimistic demote
    try {
      await api.deleteTask(docId);
    } catch (e) {
      onChange(prev);
      fail(e);
    }
  };

  return (
    <View style={styles.wrap}>
      {/* Status segmented control */}
      <View style={styles.segment} accessibilityRole="tablist">
        {STATUS_ORDER.map((s) => {
          const active = task.status === s;
          return (
            <Pressable
              key={s}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={STATUS_LABEL[s]}
              onPress={() => cycleStatus(s)}
              style={[
                styles.segmentItem,
                active && { backgroundColor: colors.accent },
              ]}
            >
              <Text
                style={[
                  type.meta,
                  { color: active ? colors.onAccent : colors.inkSoft, fontWeight: active ? "600" : "400" },
                ]}
                numberOfLines={1}
              >
                {STATUS_LABEL[s]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.chips}>
        {/* Priority */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Priority: ${PRIORITY_LABEL[task.priority]}`}
          onPress={() => setShowPriority(true)}
          style={({ pressed }) => [
            styles.chip,
            { backgroundColor: pressed ? colors.surfaceSunken : colors.surface },
          ]}
        >
          <PriorityDot priority={task.priority} />
          <Text style={[type.meta, { color: colors.ink }]}>{PRIORITY_LABEL[task.priority]}</Text>
        </Pressable>

        {/* Due date */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={task.due_at ? `Due ${dueLabel(task)}` : "Set due date"}
          onPress={() => setShowDue(true)}
          style={({ pressed }) => [
            styles.chip,
            { backgroundColor: pressed ? colors.surfaceSunken : colors.surface },
          ]}
        >
          <Feather name="calendar" size={14} color={task.due_at ? colors.ink : colors.inkSoft} />
          <Text style={[type.meta, { color: task.due_at ? colors.ink : colors.inkSoft }]}>
            {task.due_at ? dueLabel(task) : "No date"}
          </Text>
        </Pressable>

        {/* Overflow — remove task */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Task options"
          onPress={() => setShowOverflow(true)}
          style={({ pressed }) => [
            styles.chip,
            { backgroundColor: pressed ? colors.surfaceSunken : colors.surface },
          ]}
        >
          <Feather name="more-horizontal" size={16} color={colors.inkSoft} />
        </Pressable>
      </View>

      {showPriority ? (
        <Sheet title="Priority" onClose={() => setShowPriority(false)}>
          {PRIORITY_ORDER.map((p: TaskPriority) => (
            <Pressable
              key={p}
              accessibilityRole="button"
              accessibilityState={{ selected: task.priority === p }}
              accessibilityLabel={PRIORITY_LABEL[p]}
              onPress={() => {
                setShowPriority(false);
                if (p !== task.priority) void patch({ priority: p });
              }}
              style={({ pressed }) => [
                styles.optionRow,
                { backgroundColor: pressed ? colors.surfaceSunken : "transparent" },
              ]}
            >
              <PriorityDot priority={p} />
              <Text style={[type.body, { color: colors.ink, flex: 1 }]}>{PRIORITY_LABEL[p]}</Text>
              {task.priority === p ? (
                <Feather name="check" size={16} color={colors.accent} />
              ) : null}
            </Pressable>
          ))}
        </Sheet>
      ) : null}

      {showDue ? (
        <DuePickerSheet
          task={task}
          onClose={() => setShowDue(false)}
          onApply={(body) => {
            setShowDue(false);
            void patch(body);
          }}
        />
      ) : null}

      {showOverflow ? (
        <Sheet title="Task" onClose={() => setShowOverflow(false)}>
          <Button variant="destructive" label="Remove task" onPress={removeTask} />
        </Sheet>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    // Chip-shaped, to sit with the label chips rather than beside them.
    makeChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      minHeight: 28,
      paddingHorizontal: 10,
      borderRadius: radius.full,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.hairline,
    },
    makeChipText: { ...type.meta, color: colors.inkSoft },
    wrap: { gap: spacing.sm, paddingBottom: spacing.sm },
    segment: {
      flexDirection: "row",
      alignSelf: "flex-start",
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.sm,
      padding: 2,
      gap: 2,
    },
    segmentItem: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm - 2,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 34,
    },
    chips: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.hairline,
      minHeight: 36,
    },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: sizing.row,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
  });
