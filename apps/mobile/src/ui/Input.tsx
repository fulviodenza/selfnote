import { useState } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { radius, sizing, spacing } from "../theme";
import { useTheme } from "../theme-context";

export interface InputProps extends Omit<TextInputProps, "style"> {
  label?: string;
  error?: string | null;
}

/** 52px field with a label, focus ring, and directive error text (DESIGN.md §5). */
export function Input({ label, error, onFocus, onBlur, ...rest }: InputProps) {
  const { colors, type } = useTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = error ? colors.danger : focused ? colors.accent : colors.hairline;
  const borderWidth = focused || error ? 1.5 : 1;

  return (
    <View style={{ gap: spacing.sm }}>
      {label ? <Text style={type.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.inkSoft}
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={[
          styles.input,
          { borderColor, borderWidth, color: colors.ink, backgroundColor: colors.surface, fontSize: type.body.fontSize },
        ]}
      />
      {error ? <Text style={[type.meta, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: { height: sizing.input, borderRadius: radius.sm, paddingHorizontal: spacing.lg },
});
