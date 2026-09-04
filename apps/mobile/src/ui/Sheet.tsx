import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { radius, shadow, spacing } from "../theme";
import { useTheme } from "../theme-context";
import { IconButton } from "./IconButton";

/**
 * Bottom sheet: a scrim + a surface panel with a grabber and a close button.
 * Mount/unmount is controlled by the caller.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { colors, type } = useTheme();
  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.panel, { backgroundColor: colors.surface }]}>
        <View style={[styles.grabber, { backgroundColor: colors.hairline }]} />
        <View style={styles.header}>
          <Text style={type.title}>{title}</Text>
          <IconButton glyph="✕" label="Close" onPress={onClose} />
        </View>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(20,22,28,0.45)" },
  panel: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.xxl,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    ...shadow.floating,
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: radius.full,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
