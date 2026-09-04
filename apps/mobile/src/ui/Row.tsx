import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { sizing, spacing } from "../theme";
import { useTheme } from "../theme-context";

export interface RowProps {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  trailing?: ReactNode;
  indent?: number;
  selected?: boolean;
  accessibilityLabel?: string;
  style?: ViewStyle;
}

/** 56px tappable row with a whole-row press tint and an optional selected state. */
export function Row({
  children,
  onPress,
  onLongPress,
  trailing,
  indent = 0,
  selected = false,
  accessibilityLabel,
  style,
}: RowProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomColor: colors.hairline,
          backgroundColor: selected ? colors.accentWash : pressed ? colors.surfaceSunken : colors.paper,
          paddingLeft: spacing.gutter + indent,
        },
        style,
      ]}
    >
      {selected ? <View style={[styles.edgeBar, { backgroundColor: colors.accent }]} /> : null}
      <View style={styles.content}>{children}</View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: sizing.row,
    flexDirection: "row",
    alignItems: "center",
    paddingRight: spacing.md,
    borderBottomWidth: 1,
  },
  edgeBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 },
  content: { flex: 1, justifyContent: "center", gap: spacing.xs, paddingVertical: spacing.md },
  trailing: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
});
