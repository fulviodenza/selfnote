import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { fonts, radius, spacing } from "../theme";
import { useTheme } from "../theme-context";

export interface ChipProps {
  label: string;
  onPress?: () => void;
  /** Selected filter: the accent wash, the same as active nav. */
  selected?: boolean;
  accessibilityLabel?: string;
  /** Optional leading element (an icon). */
  leading?: ReactNode;
  style?: ViewStyle;
}

/**
 * The one chip: filters, labels, quick choices. Ink on a hairline when idle; the
 * accent wash with accent text when selected. A solid accent fill is reserved
 * for the screen's one primary action, so a chip never takes it. Mirrors
 * `.chip` in apps/web/src/styles.css.
 */
export function Chip({ label, onPress, selected = false, accessibilityLabel, leading, style }: ChipProps) {
  const { colors, type } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      disabled={!onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: selected ? colors.accentWash : pressed ? colors.surfaceSunken : colors.surface,
          borderColor: selected ? colors.accentWash : colors.hairline,
        },
        style,
      ]}
    >
      {leading}
      <Text
        style={[
          type.label,
          { color: selected ? colors.accent : colors.inkSoft },
          selected && { fontFamily: fonts.sansSemiBold },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
  },
});
