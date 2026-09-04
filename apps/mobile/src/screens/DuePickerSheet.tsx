/**
 * Due-date editor for a task. Uses the platform DateTimePicker for the date and,
 * when the "All day" toggle is off, an additional time picker. "Clear" removes
 * the due date (sends due_at: null). Emits an updateTask patch on Apply.
 *
 * `due_at` is always sent as an RFC 3339 UTC string; for all-day tasks the time
 * component is set to local midnight (the server renders only the date part).
 */
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import type { Task, UpdateTaskBody } from "../api";
import { dueLabel } from "../tasks";
import { radius, sizing, spacing } from "../theme";
import { useTheme } from "../theme-context";
import { Button, Sheet } from "../ui";

export function DuePickerSheet({
  task,
  onClose,
  onApply,
}: {
  task: Task;
  onClose: () => void;
  onApply: (body: UpdateTaskBody) => void;
}) {
  const { colors, type, isDark } = useTheme();
  const [date, setDate] = useState<Date>(task.due_at ? new Date(task.due_at) : defaultDue());
  const [allDay, setAllDay] = useState<boolean>(task.due_all_day);
  // On Android the pickers are dialogs shown on demand; on iOS they're inline.
  const [showDate, setShowDate] = useState(Platform.OS === "ios");
  const [showTime, setShowTime] = useState(false);

  const onDateChange = (_e: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS === "android") setShowDate(false);
    if (!picked) return;
    // Keep the existing clock time, replace only the calendar day.
    const next = new Date(date);
    next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
    setDate(next);
  };

  const onTimeChange = (_e: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS === "android") setShowTime(false);
    if (!picked) return;
    const next = new Date(date);
    next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    setDate(next);
  };

  const apply = () => {
    const out = new Date(date);
    if (allDay) out.setHours(0, 0, 0, 0);
    onApply({ due_at: out.toISOString(), due_all_day: allDay });
  };

  const clear = () => onApply({ due_at: null });

  // Preview reuses the shared relative label on a synthetic task.
  const preview = dueLabel({ ...task, due_at: date.toISOString(), due_all_day: allDay });

  return (
    <Sheet title="Due date" onClose={onClose}>
      <View style={styles.previewRow}>
        <Text style={[type.label, { color: colors.inkSoft }]}>When</Text>
        <Text style={[type.body, { color: colors.ink }]}>{preview}</Text>
      </View>

      {Platform.OS === "android" ? (
        <View style={styles.androidRow}>
          <Button variant="secondary" label="Pick date" onPress={() => setShowDate(true)} />
          {!allDay ? (
            <Button variant="secondary" label="Pick time" onPress={() => setShowTime(true)} />
          ) : null}
        </View>
      ) : null}

      {showDate ? (
        <DateTimePicker
          value={date}
          mode="date"
          display={Platform.OS === "ios" ? "inline" : "default"}
          themeVariant={isDark ? "dark" : "light"}
          onChange={onDateChange}
          accentColor={colors.accent}
        />
      ) : null}

      {/* iOS: inline time picker; Android: dialog opened via "Pick time". */}
      {!allDay && (Platform.OS === "ios" || showTime) ? (
        <DateTimePicker
          value={date}
          mode="time"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          themeVariant={isDark ? "dark" : "light"}
          onChange={onTimeChange}
          accentColor={colors.accent}
          style={Platform.OS === "ios" ? styles.iosTime : undefined}
        />
      ) : null}

      <View style={styles.allDayRow}>
        <Text style={[type.body, { color: colors.ink }]}>All day</Text>
        <Switch
          value={allDay}
          onValueChange={setAllDay}
          trackColor={{ true: colors.accent, false: colors.hairline }}
          thumbColor={colors.surface}
        />
      </View>

      <Button label="Set due date" onPress={apply} />
      {task.due_at ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear due date"
          onPress={clear}
          style={styles.clearBtn}
        >
          <Text style={[type.button, { color: colors.danger }]}>Clear due date</Text>
        </Pressable>
      ) : null}
    </Sheet>
  );
}

/** Default a fresh due date to the next full hour today. */
function defaultDue(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

const styles = StyleSheet.create({
  previewRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  androidRow: { flexDirection: "row", gap: spacing.sm },
  allDayRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: sizing.buttonSecondary,
  },
  iosTime: { alignSelf: "stretch", height: 120 },
  clearBtn: { alignItems: "center", justifyContent: "center", minHeight: sizing.buttonSecondary, borderRadius: radius.md },
});
