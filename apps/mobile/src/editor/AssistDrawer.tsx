/**
 * AI Assist drawer — a right-side panel in the editor. Sends the current document
 * (via the editor bridge) plus an intent to the server's /ai/complete, and lets the
 * user insert the suggestion back into the doc (which syncs through Yjs).
 *
 * Shown only when /ai/status reports a provider, so plain servers show nothing.
 */
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { api, type AiStatus } from "../api";
import { useTheme } from "../theme-context";
import { radius, shadow, sizing, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { Button, IconButton, Input } from "../ui";

const INTENTS: { key: string; label: string }[] = [
  { key: "continue", label: "Continue" },
  { key: "summarize", label: "Summarize" },
  { key: "ideas", label: "Ideas" },
  { key: "improve", label: "Improve" },
];

export function AssistDrawer({
  status,
  docId,
  getText,
  onInsert,
  onClose,
}: {
  status: AiStatus;
  docId: string;
  getText: () => Promise<string>;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [last, setLast] = useState<{ intent: string; prompt?: string } | null>(null);

  const run = async (intent: string, prompt?: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setLast({ intent, prompt });
    try {
      const context = await getText();
      const res = await api.aiComplete({ doc_id: docId, intent, prompt, context });
      setResult(res.text);
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 200) : "Assist failed.");
    } finally {
      setBusy(false);
    }
  };

  const providerBadge = [status.provider, status.model].filter(Boolean).join(" · ");

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close Assist" />
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={type.title}>Assist</Text>
          <IconButton glyph="✕" label="Close" onPress={onClose} />
        </View>
        {providerBadge ? <Text style={type.meta}>{providerBadge}</Text> : null}

        <View style={styles.chips}>
          {INTENTS.map((it) => (
            <Pressable
              key={it.key}
              onPress={() => run(it.key)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={it.label}
              style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
            >
              <Text style={styles.chipText}>{it.label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.askRow}>
          <View style={styles.flex}>
            <Input
              value={ask}
              onChangeText={setAsk}
              placeholder="Ask about this page…"
              onSubmitEditing={() => ask.trim() && run("ask", ask.trim())}
            />
          </View>
        </View>
        <Button
          label="Ask"
          onPress={() => ask.trim() && run("ask", ask.trim())}
          disabled={busy || !ask.trim()}
        />

        <ScrollView style={styles.result} contentContainerStyle={styles.resultBody}>
          {busy ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[type.meta, { marginTop: spacing.sm }]}>Thinking…</Text>
            </View>
          ) : error ? (
            <Text style={[type.body, { color: colors.danger }]}>{error}</Text>
          ) : result != null ? (
            <Text style={type.body}>{result}</Text>
          ) : (
            <Text style={[type.body, { color: colors.inkSoft }]}>
              Pick an action or ask a question to get a suggestion grounded in this page.
            </Text>
          )}
        </ScrollView>

        {result != null && !busy ? (
          <View style={styles.actions}>
            <Button
              label="Insert"
              onPress={() => {
                onInsert(result);
                onClose();
              }}
              style={styles.flex}
            />
            <Button
              variant="secondary"
              label="Retry"
              onPress={() => last && run(last.intent, last.prompt)}
              style={styles.flex}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
  flex: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject, flexDirection: "row" },
  scrim: { flex: 1, backgroundColor: "rgba(20,22,28,0.35)" },
  panel: {
    width: "86%",
    maxWidth: 460,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
    borderTopLeftRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
    ...shadow.floating,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    minHeight: sizing.minTarget,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  chipPressed: { backgroundColor: colors.accentWash },
  chipText: { ...type.button, color: colors.ink, fontSize: 15 },
  askRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  result: {
    flex: 1,
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  resultBody: { paddingVertical: spacing.lg },
  loading: { alignItems: "center", paddingVertical: spacing.xxl },
  actions: { flexDirection: "row", gap: spacing.md },
});
