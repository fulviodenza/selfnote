import { StyleSheet, Text, View } from "react-native";
import { radius, spacing } from "../theme";
import { useTheme } from "../theme-context";

export type SyncState = "connecting" | "connected" | "disconnected" | "offline";

/** A labelled sync indicator — a bare dot is a puzzle, so we name the state. */
export function StatusDot({ state, showLabel = true }: { state: SyncState; showLabel?: boolean }) {
  const { colors, type } = useTheme();
  const map: Record<SyncState, { color: string; word: string }> = {
    connecting: { color: colors.warn, word: "Syncing…" },
    connected: { color: colors.live, word: "Live" },
    disconnected: { color: colors.danger, word: "Offline" },
    offline: { color: colors.inkSoft, word: "Offline" },
  };
  const { color, word } = map[state];
  return (
    <View style={styles.wrap} accessibilityLabel={`Sync status: ${word}`}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      {showLabel ? <Text style={[type.meta, { color }]}>{word}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: radius.full },
});
