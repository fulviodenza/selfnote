/**
 * Task controls shown below the title on the note screen. When the document
 * isn't a task, a single "Make task" Pressable. Once it is, a compact row of
 * native controls — a status segmented control, a priority picker (sheet), and
 * a due-date picker (date + optional time when `due_all_day` is off). Every
 * change fires updateTask; "Remove task" lives in the note overflow menu.
 *
 * Strict parity with the web task panel (apps/web), against the same API
 * contract in docs/features/calendar-task-sync.md.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
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

export function TaskControls({
  docId,
  onError,
}: {
  docId: string;
  /** Surfaced so the parent can toast; also cleared on success. */
  onError?: (message: string | null) => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [task, setTask] = useState<Task | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPriority, setShowPriority] = useState(false);
  const [showDue, setShowDue] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);

  const fail = useCallback(
    (e: unknown) => onError?.(e instanceof Error ? e.message.slice(0, 160) : String(e)),
    [onError],
  );

  // Load task metadata; a 404 means the document simply isn't a task yet.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = await api.getTask(docId);
        if (alive) setTask(t);
      } catch (e) {
        if (alive && (e as { status?: number }).status !== 404) fail(e);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [docId, fail]);

  const makeTask = async () => {
    if (busy) return;
    setBusy(true);
    onError?.(null);
    try {
      setTask(await api.setTask(docId, {}));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const patch = async (body: Parameters<typeof api.updateTask>[1]) => {
    if (!task) return;
    onError?.(null);
    // Optimistic; reconcile with the server response.
    const prev = task;
    setTask({ ...task, ...body } as Task);
    try {
      setTask(await api.updateTask(docId, body));
    } catch (e) {
      setTask(prev);
      fail(e);
    }
  };

  const cycleStatus = (s: TaskStatus) => patch({ status: s });

  const removeTask = async () => {
    setShowOverflow(false);
    onError?.(null);
    const prev = task;
    setTask(null); // optimistic demote
    try {
      await api.deleteTask(docId);
    } catch (e) {
      setTask(prev);
      fail(e);
    }
  };

  if (!loaded) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!task) {
    return (
      <View style={styles.makeWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Make task"
          disabled={busy}
          onPress={makeTask}
          style={({ pressed }) => [
            styles.makeBtn,
            { backgroundColor: pressed ? colors.surfaceSunken : colors.surface },
          ]}
        >
          <Text style={styles.makeGlyph}>☐</Text>
          <Text style={[type.label, { color: colors.ink }]}>
            {busy ? "Making task…" : "Make task"}
          </Text>
        </Pressable>
      </View>
    );
  }

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
          <Text style={styles.chipGlyph}>🗓</Text>
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
          <Text style={[type.meta, { color: colors.inkSoft }]}>⋯</Text>
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
              {task.priority === p ? <Text style={styles.check}>✓</Text> : null}
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
    loadingWrap: { paddingVertical: spacing.md, alignItems: "flex-start" },
    makeWrap: { paddingBottom: spacing.sm },
    makeBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      alignSelf: "flex-start",
      minHeight: sizing.buttonSecondary,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.hairline,
    },
    makeGlyph: { fontSize: 18, color: colors.inkSoft },
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
    chipGlyph: { fontSize: 14 },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: sizing.row,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    check: { ...type.body, color: colors.accent, fontWeight: "600" },
  });
