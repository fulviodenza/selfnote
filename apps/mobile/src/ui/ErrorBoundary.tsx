import { Component, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, sizing, spacing, type as typeRole } from "../theme";

interface State {
  error: Error | null;
}

/**
 * Catches render-time crashes and shows a recoverable screen instead of a blank
 * white one (this app has hit white-screen crashes before). Uses the static light
 * palette so it works even if a theming error is what failed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn("[app error]", error?.message ?? String(error));
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.wrap}>
          <Text style={styles.title}>Something went wrong.</Text>
          <Text style={styles.msg}>The app hit an unexpected error. Try again.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reload"
            style={styles.btn}
            onPress={() => this.setState({ error: null })}
          >
            <Text style={styles.btnText}>Reload</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xxl,
    backgroundColor: colors.paper,
  },
  title: { ...typeRole.title, fontSize: 22 },
  msg: { ...typeRole.body, color: colors.inkSoft, textAlign: "center" },
  btn: {
    minHeight: sizing.buttonPrimary,
    justifyContent: "center",
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    marginTop: spacing.sm,
  },
  btnText: { ...typeRole.button, color: colors.onAccent },
});
