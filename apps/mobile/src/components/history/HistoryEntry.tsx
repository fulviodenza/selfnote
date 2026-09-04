/**
 * One row in the version-history timeline (docs/features/version-history.md §5):
 * relative time, author, a kind badge, an optional label, and the snapshot size.
 * Tapping it opens the read-only preview. Mobile parity with web's HistoryEntry.
 */
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Checkpoint } from "../../api";
import { useTheme } from "../../theme-context";
import { radius, sizing, spacing } from "../../theme";
import type { Palette, TypeRoles } from "../../theme";
import { formatSize, kindLabel, relativeTime } from "./format";

export function HistoryEntry({
  checkpoint,
  onPress,
}: {
  checkpoint: Checkpoint;
  onPress: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);

  const author = checkpoint.created_by_name ?? (checkpoint.kind === "auto" ? "System" : "Someone");
  const size = formatSize(checkpoint.size_bytes);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${kindLabel(checkpoint.kind)}${checkpoint.label ? `: ${checkpoint.label}` : ""}, ${relativeTime(checkpoint.created_at)}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.top}>
        <Text
          style={[
            styles.badge,
            checkpoint.kind === "manual" && styles.badgeManual,
            checkpoint.kind === "restore" && styles.badgeRestore,
          ]}
        >
          {kindLabel(checkpoint.kind)}
        </Text>
        <Text style={type.meta}>{relativeTime(checkpoint.created_at)}</Text>
      </View>
      {checkpoint.label ? (
        <Text style={[type.body, styles.label]} numberOfLines={2}>
          {checkpoint.label}
        </Text>
      ) : null}
      <View style={styles.bottom}>
        <Text style={type.meta} numberOfLines={1}>
          {author}
        </Text>
        {size ? <Text style={[type.meta, styles.dot]}>·</Text> : null}
        {size ? <Text style={type.meta}>{size}</Text> : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    row: {
      minHeight: sizing.row,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.gutter,
      gap: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    pressed: { backgroundColor: colors.surfaceSunken },
    top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
    badge: {
      ...type.meta,
      color: colors.inkSoft,
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.full,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      overflow: "hidden",
      fontWeight: "600",
    },
    badgeManual: { color: colors.accent, backgroundColor: colors.accentWash },
    badgeRestore: { color: colors.warn, backgroundColor: colors.liveWash },
    label: { marginTop: 2 },
    bottom: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
    dot: { color: colors.inkFaint },
  });
