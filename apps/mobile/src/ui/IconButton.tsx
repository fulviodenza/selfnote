import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, type ViewStyle } from "react-native";
import { hitSlop, radius, sizing } from "../theme";
import { useTheme } from "../theme-context";

/** A Feather glyph name (e.g. "x", "plus", "refresh-cw", "copy"). */
export type IconName = React.ComponentProps<typeof Feather>["name"];

export interface IconButtonProps {
  /** A Feather icon name, e.g. "settings", "chevron-left", "plus", "x". */
  icon: IconName;
  onPress: () => void;
  label: string;
  active?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}

/** 44px visual circle inside a 48px touch target (DESIGN.md §4). */
export function IconButton({ icon, onPress, label, active = false, disabled = false, style }: IconButtonProps) {
  const { colors } = useTheme();
  const color = disabled ? colors.inkFaint : active ? colors.accent : colors.ink;
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
      <Feather name={icon} size={22} color={color} />
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
});
