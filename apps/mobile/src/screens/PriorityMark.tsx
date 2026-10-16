/**
 * Task priority as ink weight, not hue: one to three marks, darkening with
 * urgency. Same mapping as web (PRIORITY_MARK in apps/web/src/tasks.ts).
 */
import { Text } from "react-native";
import type { TaskPriority } from "../api";
import { useTheme } from "../theme-context";

const MARK: Record<TaskPriority, string> = { none: "–", low: "!", medium: "!!", high: "!!!" };

export function PriorityMark({ priority }: { priority: TaskPriority }) {
  const { colors } = useTheme();
  const color = priority === "high" ? colors.ink : priority === "medium" ? colors.inkSoft : colors.inkFaint;
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ minWidth: 14, textAlign: "center", fontSize: 13, fontWeight: "700", letterSpacing: -0.5, color }}
    >
      {MARK[priority]}
    </Text>
  );
}
