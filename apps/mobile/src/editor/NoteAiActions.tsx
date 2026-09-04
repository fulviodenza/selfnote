/**
 * Note-level AI actions (docs/features/note-level-ai-actions.md) — mobile parity
 * with the web popover. Opens a bottom sheet listing the three actions
 * (Summarize / Rewrite in my voice / Extract action items); picking one streams
 * the result from /ai/action/stream into a scrollable result sheet with the
 * shared footer: Insert, Replace (confirm for whole-note), Copy, Retry, Dismiss.
 *
 * Scope is chosen from the live editor selection: when a passage is selected the
 * action defaults to `scope:"selection"`, otherwise `scope:"note"`. Insert and
 * Replace post the result back into the note over the WebView bridge.
 *
 * Rendered only when /ai/status reports a provider (gated by the caller).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";
import {
  aiActionStream,
  type AiAction,
  type AiScope,
  type AiStatus,
  type ChatStreamHandle,
} from "../api";
import { useTheme } from "../theme-context";
import { hitSlop, radius, shadow, sizing, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { IconButton } from "../ui";
import type { EditorSelection } from "./WebViewEditor";

const ACTIONS: { action: AiAction; label: string; hint: string }[] = [
  { action: "summarize", label: "Summarize", hint: "TL;DR + key points" },
  { action: "rewrite", label: "Rewrite in my voice", hint: "Match your writing style" },
  { action: "action_items", label: "Extract action items", hint: "Pull out to-dos" },
];

interface Selected {
  action: AiAction;
  label: string;
  scope: AiScope;
}

export function NoteAiActions({
  status,
  docId,
  getSelection,
  onInsert,
  onReplace,
  onClose,
}: {
  status: AiStatus;
  docId: string;
  /** Live editor markdown + the selected passage (empty when nothing selected). */
  getSelection: () => Promise<EditorSelection>;
  /** Insert the result at the end of the note (staged like the chat insert). */
  onInsert: (text: string) => void;
  /**
   * Replace the note with the result. `wholeNote` is true for note scope (the
   * caller confirms before applying); false replaces the current selection.
   */
  onReplace: (text: string, wholeNote: boolean) => void;
  onClose: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const mdStyles = useMemo(() => makeMarkdownStyles(colors), [colors]);

  // The note text + selection captured when the sheet opens, so the result acts
  // on the same snapshot even if the editor selection changes underneath.
  const [snapshot, setSnapshot] = useState<EditorSelection | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const streamRef = useRef<ChatStreamHandle | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    let alive = true;
    getSelection()
      .then((s) => alive && setSnapshot(s))
      .catch(() => alive && setSnapshot({ text: "", selection: "" }));
    return () => {
      alive = false;
    };
  }, [getSelection]);

  useEffect(() => () => streamRef.current?.abort(), []);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [result]);

  const hasSelection = !!snapshot?.selection.trim();

  const run = (action: AiAction, label: string) => {
    const snap = snapshot;
    if (!snap) return;
    streamRef.current?.abort();
    const scope: AiScope = hasSelection ? "selection" : "note";
    setSelected({ action, label, scope });
    setResult("");
    setError(null);
    setCopied(false);
    setBusy(true);
    streamRef.current = aiActionStream(
      {
        action,
        scope,
        doc_id: docId,
        text: snap.text,
        selection: scope === "selection" ? snap.selection : null,
      },
      {
        onDelta: (d) => setResult((r) => r + d),
        onError: (msg) => {
          setError(msg);
          setBusy(false);
          streamRef.current = null;
        },
        onDone: () => {
          setBusy(false);
          streamRef.current = null;
        },
      },
    );
  };

  const retry = () => {
    if (selected) run(selected.action, selected.label);
  };

  const stop = () => {
    streamRef.current?.abort();
    streamRef.current = null;
    setBusy(false);
  };

  const copy = async () => {
    await Clipboard.setStringAsync(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const insert = () => {
    onInsert(result);
    onClose();
  };

  const replace = () => {
    if (!selected) return;
    if (selected.scope === "selection") {
      onReplace(result, false);
      onClose();
      return;
    }
    // Whole-note replace is destructive — confirm first.
    Alert.alert("Replace the whole note?", "This replaces all of the note's content with the AI result.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Replace",
        style: "destructive",
        onPress: () => {
          onReplace(result, true);
          onClose();
        },
      },
    ]);
  };

  const providerBadge = [status.provider, status.model].filter(Boolean).join(" · ");
  const canAct = !busy && !!result.trim() && !error;

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close AI actions" />
      <View style={styles.panel}>
        <View style={[styles.grabber, { backgroundColor: colors.hairline }]} />
        <View style={styles.header}>
          <View style={styles.brand}>
            <Text style={styles.spark}>✦</Text>
            <Text style={type.title}>{selected ? selected.label : "AI actions"}</Text>
          </View>
          <IconButton glyph="✕" label="Close" onPress={onClose} />
        </View>

        {!selected ? (
          <>
            <Text style={[type.meta, styles.scopeHint]}>
              {snapshot == null
                ? "Reading the note…"
                : hasSelection
                  ? "Runs on the selected text"
                  : "Runs on the whole note"}
            </Text>
            <View style={styles.actions}>
              {ACTIONS.map((a) => (
                <Pressable
                  key={a.action}
                  onPress={() => run(a.action, a.label)}
                  disabled={snapshot == null}
                  accessibilityRole="button"
                  accessibilityLabel={a.label}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && styles.rowPressed,
                    snapshot == null && styles.disabled,
                  ]}
                >
                  <View style={styles.flex}>
                    <Text style={styles.actionLabel}>{a.label}</Text>
                    <Text style={[type.meta, styles.actionHint]}>{a.hint}</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
              ))}
            </View>
            {providerBadge ? <Text style={[type.meta, styles.badge]}>{providerBadge}</Text> : null}
          </>
        ) : (
          <>
            <Text style={[type.meta, styles.scopeHint]}>
              {selected.scope === "selection" ? "Selected text" : "Whole note"}
            </Text>
            <ScrollView
              ref={scrollRef}
              style={styles.result}
              contentContainerStyle={styles.resultBody}
              keyboardShouldPersistTaps="handled"
            >
              {error ? (
                <Text style={[type.body, { color: colors.danger }]}>{error}</Text>
              ) : result ? (
                <Markdown style={mdStyles}>{result}</Markdown>
              ) : (
                <Text style={type.body}>…</Text>
              )}
            </ScrollView>

            <View style={styles.footer}>
              {busy ? (
                <FooterBtn label="Stop" onPress={stop} styles={styles} />
              ) : (
                <>
                  <FooterBtn
                    label="Insert"
                    primary
                    disabled={!canAct}
                    onPress={insert}
                    styles={styles}
                    colors={colors}
                  />
                  <FooterBtn label="Replace" disabled={!canAct} onPress={replace} styles={styles} />
                  <FooterBtn
                    label={copied ? "Copied ✓" : "Copy"}
                    disabled={!canAct}
                    onPress={copy}
                    styles={styles}
                  />
                  <FooterBtn label="Retry" onPress={retry} styles={styles} />
                  <FooterBtn label="Dismiss" onPress={onClose} styles={styles} />
                </>
              )}
            </View>
          </>
        )}
      </View>
    </View>
  );
}

function FooterBtn({
  label,
  onPress,
  primary,
  disabled,
  styles,
  colors,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors?: Palette;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop(34)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.footerBtn,
        primary && styles.footerPrimary,
        pressed && styles.rowPressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.footerText, primary && colors ? { color: colors.accent } : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    flex: { flex: 1 },
    overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(20,22,28,0.45)" },
    panel: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.xxl,
      paddingBottom: spacing.xxxl,
      gap: spacing.md,
      maxHeight: "82%",
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
    brand: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    spark: { color: colors.accent, fontSize: 18 },
    scopeHint: { marginTop: -spacing.xs },

    actions: { gap: spacing.sm },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: sizing.row,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.hairline,
      backgroundColor: colors.surface,
    },
    rowPressed: { backgroundColor: colors.accentWash },
    disabled: { opacity: 0.4 },
    actionLabel: { ...type.button, color: colors.ink },
    actionHint: { marginTop: 1 },
    chevron: { color: colors.inkFaint, fontSize: 22, paddingLeft: spacing.sm },
    badge: { textAlign: "center" },

    result: { maxHeight: 360, borderRadius: radius.md, backgroundColor: colors.surfaceSunken },
    resultBody: { padding: spacing.lg },

    footer: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
      justifyContent: "flex-end",
    },
    footerBtn: {
      minHeight: sizing.buttonSecondary,
      paddingHorizontal: spacing.lg,
      justifyContent: "center",
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.hairline,
    },
    footerPrimary: { borderColor: colors.accent },
    footerText: { ...type.button, color: colors.ink, fontSize: 15 },
  });

/** Map Markdown elements to the app's palette for the streamed result. */
const makeMarkdownStyles = (colors: Palette) => ({
  body: { color: colors.ink, fontSize: 16, lineHeight: 24 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  heading1: { fontSize: 20, fontWeight: "600" as const, color: colors.ink, marginTop: 4, marginBottom: 6 },
  heading2: { fontSize: 18, fontWeight: "600" as const, color: colors.ink, marginTop: 4, marginBottom: 6 },
  heading3: { fontSize: 16, fontWeight: "600" as const, color: colors.ink, marginTop: 4, marginBottom: 4 },
  strong: { fontWeight: "700" as const },
  em: { fontStyle: "italic" as const },
  bullet_list: { marginBottom: 4 },
  ordered_list: { marginBottom: 4 },
  list_item: { marginVertical: 2 },
  link: { color: colors.accent, textDecorationLine: "underline" as const },
  blockquote: {
    backgroundColor: colors.accentWash,
    borderLeftColor: colors.accent,
    borderLeftWidth: 3,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  code_inline: {
    backgroundColor: colors.accentWash,
    color: colors.ink,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: "monospace",
    fontSize: 14,
  },
  code_block: {
    backgroundColor: colors.ink,
    color: colors.surface,
    borderRadius: 8,
    padding: 10,
    fontFamily: "monospace",
    fontSize: 13,
    marginBottom: 8,
  },
  fence: {
    backgroundColor: colors.ink,
    color: colors.surface,
    borderRadius: 8,
    padding: 10,
    fontFamily: "monospace",
    fontSize: 13,
    marginBottom: 8,
  },
  hr: { backgroundColor: colors.hairline, height: 1, marginVertical: 8 },
});
