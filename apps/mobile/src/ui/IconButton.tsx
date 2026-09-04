import { Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { hitSlop, radius, sizing } from "../theme";
import { useTheme } from "../theme-context";

export interface IconButtonProps {
  /** A single glyph/emoji, e.g. "⚙", "‹", "＋", "✕". */
  glyph: string;
  onPress: () => void;
  label: string;
  active?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}

/** 44px visual circle inside a 48px touch target (DESIGN.md §4). */
export function IconButton({ glyph, onPress, label, active = false, disabled = false, style }: IconButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={hitSlop(sizing.iconVisual)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: pressed ? colors.surfaceSunken : "transparent" },
        style,
      ]}
    >
      <Text style={[styles.glyph, { color: disabled ? colors.inkFaint : active ? colors.accent : colors.ink }]}>
        {glyph}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    width: sizing.iconVisual,
    height: sizing.iconVisual,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  glyph: { fontSize: 22, lineHeight: 26 },
});
