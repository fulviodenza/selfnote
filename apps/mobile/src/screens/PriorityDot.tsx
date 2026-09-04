/** A small colored dot for a task priority (parity with web's priority dot). */
import { StyleSheet, View } from "react-native";
import type { TaskPriority } from "../api";
import { radius } from "../theme";
import { useTheme } from "../theme-context";

export function PriorityDot({ priority, size = 10 }: { priority: TaskPriority; size?: number }) {
  const { colors } = useTheme();
  const color: Record<TaskPriority, string> = {
    high: colors.danger,
    medium: colors.warn,
    low: colors.accent,
    none: colors.inkFaint,
  };
  const filled = priority !== "none";
  return (
    <View
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: radius.full,
          backgroundColor: filled ? color[priority] : "transparent",
          borderColor: color[priority],
          borderWidth: filled ? 0 : 1.5,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({ dot: {} });
