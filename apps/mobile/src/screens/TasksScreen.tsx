/**
 * Agenda / Task screen. A SectionList grouped Overdue / Today / Upcoming /
 * Later / No date / Done (boundaries computed client-side from due_at), a
 * horizontal status filter chip row, pull-to-refresh, a leading checkbox that
 * toggles a task to `done`, and row tap to open the underlying note.
 *
 * Strict parity with apps/web TaskView, against docs/features/calendar-task-sync.md.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { api, type Task, type TaskStatus } from "../api";
import { PRIORITY_LABEL, STATUS_LABEL, dueLabel, groupFor, groupTasks } from "../tasks";
import { radius, sizing, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { IconButton, useToast } from "../ui";
import { PriorityDot } from "./PriorityDot";

const FILTERS: { key: TaskStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "todo", label: STATUS_LABEL.todo },
  { key: "in_progress", label: STATUS_LABEL.in_progress },
  { key: "done", label: STATUS_LABEL.done },
];

export function TasksScreen({
  workspaceId,
  onBack,
  onOpenTask,
}: {
  workspaceId: string;
  onBack: () => void;
  onOpenTask: (docId: string) => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskStatus | "all">("all");

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      setError(null);
      try {
        const list = await api.listTasks({ workspace_id: workspaceId, limit: 500 });
        setTasks(list);
      } catch (e) {
        setError(e instanceof Error ? e.message.slice(0, 160) : String(e));
        if (!isRefresh) setTasks([]);
      } finally {
        if (isRefresh) setRefreshing(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    load();
  }, [load]);

  const toggleDone = async (task: Task) => {
    Haptics.selectionAsync().catch(() => undefined);
    const nextStatus: TaskStatus = task.status === "done" ? "todo" : "done";
    // Optimistic; reconcile with the server (it sets completed_at).
    setTasks((prev) => prev?.map((t) => (t.doc_id === task.doc_id ? { ...t, status: nextStatus } : t)) ?? null);
    try {
      const updated = await api.updateTask(task.doc_id, { status: nextStatus });
      setTasks((prev) => prev?.map((t) => (t.doc_id === task.doc_id ? updated : t)) ?? null);
    } catch (e) {
      setTasks((prev) => prev?.map((t) => (t.doc_id === task.doc_id ? task : t)) ?? null);
      toast(e instanceof Error ? e.message.slice(0, 120) : "Couldn't update the task.");
    }
  };

  // Filter client-side (the chip mirrors web); groups are computed from due_at.
  const filtered = useMemo(
    () => (tasks ?? []).filter((t) => filter === "all" || t.status === filter),
    [tasks, filter],
  );
  // SectionList requires a `data` key; map the shared group shape onto it.
  const sections = useMemo(
    () => groupTasks(filtered).map((s) => ({ title: s.title, data: s.tasks })),
    [filtered],
  );

  return (
    <View style={styles.flex}>
      <View style={styles.topbar}>
        <IconButton glyph="‹" label="Back" onPress={onBack} />
        <Text style={[type.docTitle, styles.flex]}>Tasks</Text>
        <IconButton glyph="⟳" label="Refresh" onPress={() => load(true)} />
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Filter: ${f.label}`}
              onPress={() => setFilter(f.key)}
              style={[
                styles.filterChip,
                {
                  backgroundColor: active ? colors.accent : colors.surface,
                  borderColor: active ? colors.accent : colors.hairline,
                },
              ]}
            >
              <Text style={[type.meta, { color: active ? colors.onAccent : colors.inkSoft }]}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error ? <Text style={[styles.error, styles.pad]}>{error}</Text> : null}

      {tasks === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.center}>
          <Text style={[type.docTitle, { color: colors.inkSoft }]}>
            {filter === "all" ? "No tasks yet." : "Nothing here."}
          </Text>
          <Text style={[type.meta, { marginTop: spacing.sm, textAlign: "center" }]}>
            Open a note and tap “Make task” to add one.
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(t) => t.doc_id}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listPad}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={[type.label, { color: colors.inkSoft }]}>
                {section.title} · {section.data.length}
              </Text>
            </View>
          )}
          renderItem={({ item }) => (
            <TaskRow task={item} styles={styles} colors={colors} onToggle={toggleDone} onOpen={onOpenTask} />
          )}
        />
      )}
    </View>
  );
}

function TaskRow({
  task,
  styles,
  colors,
  onToggle,
  onOpen,
}: {
  task: Task;
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
  onToggle: (t: Task) => void;
  onOpen: (docId: string) => void;
}) {
  const { type } = useTheme();
  const done = task.status === "done";
  const overdue = groupFor(task) === "overdue";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={task.title || "Untitled"}
      onPress={() => onOpen(task.doc_id)}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? colors.surfaceSunken : colors.paper },
      ]}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={done ? "Mark not done" : "Mark done"}
        hitSlop={12}
        onPress={() => onToggle(task)}
        style={[styles.checkbox, done && { backgroundColor: colors.live, borderColor: colors.live }]}
      >
        {done ? <Text style={styles.checkMark}>✓</Text> : null}
      </Pressable>

      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          {task.icon ? <Text style={styles.rowIcon}>{task.icon}</Text> : null}
          <Text
            style={[
              type.body,
              styles.flex,
              done && { color: colors.inkFaint, textDecorationLine: "line-through" },
            ]}
            numberOfLines={1}
          >
            {task.title || "Untitled"}
          </Text>
          {task.priority !== "none" ? (
            <View accessibilityLabel={`Priority ${PRIORITY_LABEL[task.priority]}`}>
              <PriorityDot priority={task.priority} />
            </View>
          ) : null}
        </View>
        {task.due_at ? (
          <Text style={[type.meta, { color: overdue && !done ? colors.danger : colors.inkSoft }]}>
            {dueLabel(task)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    flex: { flex: 1 },
    center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxl },
    pad: { paddingHorizontal: spacing.gutter, paddingTop: spacing.md },
    error: { ...type.body, color: colors.danger },
    topbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: sizing.row,
      paddingHorizontal: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
      backgroundColor: colors.paper,
    },
    filterRow: {
      flexDirection: "row",
      gap: spacing.sm,
      paddingHorizontal: spacing.gutter,
      paddingVertical: spacing.md,
    },
    filterChip: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.full,
      borderWidth: 1,
      minHeight: 34,
      justifyContent: "center",
    },
    listPad: { paddingBottom: spacing.xxxl },
    sectionHeader: {
      paddingHorizontal: spacing.gutter,
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
      backgroundColor: colors.paper,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: sizing.row,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.gutter,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    checkbox: {
      width: 24,
      height: 24,
      borderRadius: radius.sm,
      borderWidth: 1.5,
      borderColor: colors.inkFaint,
      alignItems: "center",
      justifyContent: "center",
    },
    checkMark: { color: colors.onAccent, fontSize: 15, fontWeight: "700" },
    rowBody: { flex: 1, gap: 2 },
    rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    rowIcon: { fontSize: 16 },
  });
