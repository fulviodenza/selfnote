import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { radius, sizing, spacing } from "../theme";
import { useTheme } from "../theme-context";
import type { Palette } from "../theme";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  icon?: string;
}

/**
 * The one Button. Heights and press states come from the theme so every screen
 * gets the same touch targets (52 primary / 48 others) and real press feedback.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  style,
  icon,
}: ButtonProps) {
  const { colors, type } = useTheme();
  const isPrimary = variant === "primary";
  const height = isPrimary ? sizing.buttonPrimary : sizing.buttonSecondary;

  const handlePress = () => {
    if (isPrimary || variant === "destructive") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    }
    onPress();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading }}
      disabled={disabled || loading}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.base,
        { height, borderRadius: radius.md },
        variantStyle(colors, variant, pressed, disabled),
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? colors.onAccent : colors.accent} />
      ) : (
        <View style={styles.content}>
          {icon ? (
            <Text style={[type.button, { color: textColor(colors, variant, disabled) }, styles.icon]}>{icon}</Text>
          ) : null}
          <Text style={[type.button, { color: textColor(colors, variant, disabled) }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

function variantStyle(colors: Palette, v: ButtonVariant, pressed: boolean, disabled: boolean): ViewStyle {
  if (disabled) return { backgroundColor: colors.surfaceSunken };
  switch (v) {
    case "primary":
      return { backgroundColor: pressed ? colors.accentPressed : colors.accent };
    case "secondary":
      return {
        backgroundColor: pressed ? colors.surfaceSunken : colors.surface,
        borderWidth: 1,
        borderColor: colors.hairline,
      };
    case "destructive":
      return { backgroundColor: "transparent" };
    case "ghost":
    default:
      return { backgroundColor: pressed ? colors.accentWash : "transparent" };
  }
}

function textColor(colors: Palette, v: ButtonVariant, disabled: boolean): string {
  if (disabled) return colors.inkFaint;
  if (v === "primary") return colors.onAccent;
  if (v === "destructive") return colors.danger;
  if (v === "ghost") return colors.accent;
  return colors.ink;
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.lg },
  content: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  icon: { fontSize: 18 },
});
