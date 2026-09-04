/**
 * AI Assist drawer — a Claude-style chat in a right-side panel. Streams replies
 * from the server's /ai/chat/stream, grounds each turn in the current document
 * (fetched via the editor bridge), and lets the user drop any reply back into the
 * note (which then syncs through Yjs).
 *
 * Shown only when /ai/status reports a provider, so plain servers show nothing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Markdown from "react-native-markdown-display";
import {
  aiChatStream,
  type AiStatus,
  type ChatMessage,
  type ChatStreamHandle,
} from "../api";
import { useTheme } from "../theme-context";
import { hitSlop, radius, shadow, sizing, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { IconButton } from "../ui";

interface Msg {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: boolean;
}

const SUGGESTIONS: { label: string; prompt: string; send?: boolean }[] = [
  { label: "Continue writing", prompt: "Continue writing this note from where it leaves off.", send: true },
  { label: "Summarize this page", prompt: "Summarize this note as a few concise bullet points.", send: true },
  { label: "Give me ideas about…", prompt: "Give me ideas about " },
  { label: "Draft an outline", prompt: "Draft an outline for this note.", send: true },
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
  const mdStyles = useMemo(() => makeMarkdownStyles(colors), [colors]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<ChatStreamHandle | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  useEffect(() => () => streamRef.current?.abort(), []);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;

    const history = messages.filter((m) => !m.error);
    const next: Msg[] = [
      ...history,
      { role: "user", content },
      { role: "assistant", content: "", streaming: true },
    ];
    const asstIndex = next.length - 1;
    setMessages(next);
    setInput("");
    setBusy(true);

    const patchAsst = (fn: (m: Msg) => Msg) =>
      setMessages((prev) => {
        const copy = prev.slice();
        const m = copy[asstIndex];
        if (m) copy[asstIndex] = fn(m);
        return copy;
      });

    let context = "";
    try {
      context = await getText();
    } catch {
      /* editor not ready — send without context */
    }
    const wire: ChatMessage[] = next
      .slice(0, asstIndex)
      .map((m) => ({ role: m.role, content: m.content }));

    const settle = () => {
      patchAsst((m) => ({ ...m, streaming: false }));
      setBusy(false);
      streamRef.current = null;
    };

    streamRef.current = aiChatStream(
      { doc_id: docId, messages: wire, context },
      {
        onDelta: (d) => patchAsst((m) => ({ ...m, content: m.content + d })),
        onError: (msg) => {
          patchAsst(() => ({ role: "assistant", content: msg, error: true }));
          settle();
        },
        onDone: settle,
      },
    );
  };

  const stop = () => {
    streamRef.current?.abort();
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    setBusy(false);
    streamRef.current = null;
  };

  const onSuggest = (s: (typeof SUGGESTIONS)[number]) => {
    if (s.send) void send(s.prompt);
    else setInput(s.prompt);
  };

  const providerBadge = [status.provider, status.model].filter(Boolean).join(" · ");

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close Assist" />
      <View style={styles.panel}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <Text style={styles.spark}>✦</Text>
            <Text style={type.title}>Assist</Text>
          </View>
          <View style={styles.headerRight}>
            {messages.length > 0 ? (
              <Pressable
                onPress={() => !busy && setMessages([])}
                accessibilityRole="button"
                accessibilityLabel="New chat"
                style={({ pressed }) => [styles.clearBtn, pressed && styles.chipPressed]}
              >
                <Text style={styles.clearText}>New chat</Text>
              </Pressable>
            ) : null}
            <IconButton glyph="✕" label="Close" onPress={onClose} />
          </View>
        </View>
        {providerBadge ? <Text style={[type.meta, styles.badge]}>{providerBadge}</Text> : null}

        <ScrollView
          ref={scrollRef}
          style={styles.thread}
          contentContainerStyle={styles.threadBody}
          keyboardShouldPersistTaps="handled"
        >
          {messages.length === 0 ? (
            <View style={styles.welcome}>
              <Text style={styles.greeting}>How can I help with this note?</Text>
              <Text style={[type.meta, styles.welcomeSub]}>Ask anything, or start with:</Text>
              <View style={styles.suggests}>
                {SUGGESTIONS.map((s) => (
                  <Pressable
                    key={s.label}
                    onPress={() => onSuggest(s)}
                    accessibilityRole="button"
                    accessibilityLabel={s.label}
                    style={({ pressed }) => [styles.suggest, pressed && styles.chipPressed]}
                  >
                    <Text style={styles.suggestText}>{s.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            messages.map((m, i) => (
              <View
                key={i}
                style={[styles.msg, m.role === "user" ? styles.msgUser : styles.msgAsst]}
              >
                <View
                  style={[
                    styles.bubble,
                    m.role === "user" ? styles.bubbleUser : styles.bubbleAsst,
                    m.error && styles.bubbleError,
                  ]}
                >
                  {m.role === "assistant" && !m.error ? (
                    m.content ? (
                      <Markdown style={mdStyles}>{m.content}</Markdown>
                    ) : m.streaming ? (
                      <Text style={type.body}>…</Text>
                    ) : null
                  ) : (
                    <Text
                      style={
                        m.error
                          ? [type.body, { color: colors.danger }]
                          : [type.body, { color: colors.onAccent }]
                      }
                    >
                      {m.content}
                    </Text>
                  )}
                </View>
                {m.role === "assistant" && !m.streaming && !m.error && m.content ? (
                  <View style={styles.msgActions}>
                    <Pressable
                      onPress={() => onInsert(m.content)}
                      accessibilityRole="button"
                      accessibilityLabel="Insert into note"
                      style={({ pressed }) => [styles.actionBtn, styles.actionPrimary, pressed && styles.chipPressed]}
                    >
                      <Text style={[styles.actionText, { color: colors.accent }]}>Insert into note</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ))
          )}
        </ScrollView>

        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            value={input}
            onChangeText={setInput}
            placeholder="Ask about this note…"
            placeholderTextColor={colors.inkSoft}
            multiline
            onSubmitEditing={() => void send(input)}
          />
          {busy ? (
            <Pressable
              onPress={stop}
              hitSlop={hitSlop(sizing.minTarget)}
              accessibilityRole="button"
              accessibilityLabel="Stop"
              style={[styles.sendBtn, styles.stopBtn]}
            >
              <Text style={styles.stopGlyph}>■</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void send(input)}
              disabled={!input.trim()}
              hitSlop={hitSlop(sizing.minTarget)}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={[styles.sendBtn, !input.trim() && styles.sendDisabled]}
            >
              <Text style={styles.sendGlyph}>↑</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, flexDirection: "row" },
    scrim: { flex: 1, backgroundColor: "rgba(20,22,28,0.35)" },
    panel: {
      width: "88%",
      maxWidth: 460,
      backgroundColor: colors.surface,
      paddingTop: spacing.xxl,
      borderTopLeftRadius: radius.lg,
      borderBottomLeftRadius: radius.lg,
      ...shadow.floating,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.xl,
    },
    brand: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    spark: { color: colors.accent, fontSize: 18 },
    headerRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    clearBtn: {
      minHeight: 34,
      paddingHorizontal: spacing.md,
      justifyContent: "center",
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.hairline,
    },
    clearText: { ...type.meta },
    badge: { paddingHorizontal: spacing.xl, marginTop: spacing.xs },

    thread: { flex: 1, marginTop: spacing.sm },
    threadBody: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, gap: spacing.lg },

    welcome: { paddingVertical: spacing.xl },
    greeting: { ...type.title, marginBottom: spacing.xs },
    welcomeSub: { marginBottom: spacing.md },
    suggests: { gap: spacing.sm, alignItems: "flex-start" },
    suggest: {
      minHeight: sizing.minTarget,
      paddingHorizontal: spacing.lg,
      justifyContent: "center",
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.hairline,
      backgroundColor: colors.surface,
    },
    suggestText: { ...type.button, color: colors.ink, fontSize: 15 },
    chipPressed: { backgroundColor: colors.accentWash },

    msg: { gap: spacing.xs, maxWidth: "100%" },
    msgUser: { alignItems: "flex-end" },
    msgAsst: { alignItems: "flex-start" },
    bubble: { maxWidth: "92%" },
    bubbleUser: {
      backgroundColor: colors.accent,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.lg,
      borderBottomRightRadius: 6,
    },
    bubbleAsst: {},
    bubbleError: {},

    msgActions: { flexDirection: "row", gap: spacing.sm },
    actionBtn: {
      minHeight: 34,
      paddingHorizontal: spacing.md,
      justifyContent: "center",
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.hairline,
    },
    actionPrimary: { borderColor: colors.accent },
    actionText: { ...type.meta, fontWeight: "600" },

    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.md,
      paddingBottom: spacing.xxl,
      borderTopWidth: 1,
      borderTopColor: colors.hairline,
    },
    composerInput: {
      flex: 1,
      minHeight: sizing.minTarget,
      maxHeight: 140,
      borderWidth: 1,
      borderColor: colors.hairline,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.ink,
      fontSize: 15,
      backgroundColor: colors.surface,
    },
    sendBtn: {
      width: sizing.minTarget,
      height: sizing.minTarget,
      borderRadius: radius.md,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    sendDisabled: { opacity: 0.4 },
    sendGlyph: { color: colors.onAccent, fontSize: 20, fontWeight: "700" },
    stopBtn: { backgroundColor: colors.ink },
    stopGlyph: { color: colors.surface, fontSize: 14 },
  });

/** Map Markdown elements to the app's palette for the assistant bubbles. */
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
  table: { borderColor: colors.hairline, borderWidth: 1, borderRadius: 6, marginBottom: 8 },
  th: { padding: 6 },
  td: { padding: 6, borderColor: colors.hairline },
});
