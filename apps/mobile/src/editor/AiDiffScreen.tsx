/**
 * Full-screen review of a staged AI edit — mobile parity with the web
 * AiDiffPreview. Renders a unified, line-level Markdown diff of the proposal's
 * `before_md` vs `after_md` (additions green, removals red/strikethrough), the
 * origin ("Remote via MCP" vs "In-app"), summary and time, and an Accept /
 * Reject footer that calls POST /ai/proposals/:id/accept|reject.
 *
 * The server supplies both sides, so no native diff engine is needed; we only
 * line up the two Markdown bodies to colour changed lines. Unchanged lines
 * render as plain Markdown so the note reads normally around the edits.
 *
 * See docs/features/ai-edit-diff-preview.md §5.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { api, type AiProposal } from "../api";
import { useTheme } from "../theme-context";
import { radius, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useToast } from "../ui";

type DiffKind = "context" | "add" | "remove";
interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Line-level LCS diff of the two Markdown bodies. Small notes only, so an O(n*m)
 * table is fine; this is purely for colouring — the actual change is applied
 * server-side from the staged Yjs diff.
 */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "remove", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "remove", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

function originLabel(origin: string): string {
  if (origin === "mcp") return "Remote via MCP";
  if (origin === "app") return "In-app";
  return origin;
}

export function AiDiffScreen({
  proposal,
  onResolved,
  onClose,
}: {
  proposal: AiProposal;
  /** Called after a successful accept/reject with the new status. */
  onResolved: (status: "applied" | "rejected", proposal: AiProposal) => void;
  onClose: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const mdStyles = useMemo(() => makeMarkdownStyles(colors), [colors]);
  const toast = useToast();
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);

  const lines = useMemo(
    () => diffLines(proposal.before_md ?? "", proposal.after_md ?? ""),
    [proposal.before_md, proposal.after_md],
  );

  const accept = async () => {
    if (busy) return;
    setBusy("accept");
    try {
      await api.acceptAiProposal(proposal.id);
      onResolved("applied", proposal);
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        toast("This note changed — the edit no longer applies.");
        onClose();
      } else {
        toast("Couldn't apply the edit. Try again.");
        setBusy(null);
      }
    }
  };

  const reject = async () => {
    if (busy) return;
    setBusy("reject");
    try {
      await api.rejectAiProposal(proposal.id);
      onResolved("rejected", proposal);
    } catch {
      toast("Couldn't discard the edit. Try again.");
      setBusy(null);
    }
  };

  const when = new Date(proposal.created_at);
  const whenLabel = Number.isNaN(when.getTime()) ? "" : when.toLocaleString();

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={styles.screen}>
        <View style={styles.topbar}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close diff"
            style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
          >
            <Text style={styles.closeGlyph}>✕</Text>
          </Pressable>
          <Text style={[type.docTitle, styles.title]} numberOfLines={1}>
            Review AI edit
          </Text>
          <View style={styles.closeBtn} />
        </View>

        <View style={styles.meta}>
          <View style={styles.metaTop}>
            <Text style={styles.originTag}>{originLabel(proposal.origin)}</Text>
            <Text style={[type.meta, styles.opTag]}>
              {proposal.op === "replace" ? "Replace" : "Append"}
            </Text>
          </View>
          {proposal.summary ? <Text style={[type.body, styles.summary]}>{proposal.summary}</Text> : null}
          {whenLabel ? <Text style={type.meta}>{whenLabel}</Text> : null}
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyPad}>
          {lines.length === 0 ? (
            <Text style={[type.meta, styles.empty]}>No changes to preview.</Text>
          ) : (
            lines.map((line, i) => (
              <View
                key={i}
                style={[
                  styles.line,
                  line.kind === "add" && styles.lineAdd,
                  line.kind === "remove" && styles.lineRemove,
                ]}
              >
                {line.kind !== "context" ? (
                  <Text style={[styles.sign, line.kind === "add" ? styles.signAdd : styles.signRemove]}>
                    {line.kind === "add" ? "+" : "−"}
                  </Text>
                ) : (
                  <Text style={styles.sign}> </Text>
                )}
                <View style={styles.lineBody}>
                  {line.text.trim() ? (
                    <Markdown style={line.kind === "remove" ? mdStyles.removed : mdStyles.base}>
                      {line.text}
                    </Markdown>
                  ) : (
                    <Text style={styles.blank}> </Text>
                  )}
                </View>
              </View>
            ))
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            onPress={reject}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel="Reject edit"
            style={({ pressed }) => [
              styles.btn,
              styles.rejectBtn,
              pressed && styles.pressed,
              busy !== null && styles.btnDisabled,
            ]}
          >
            {busy === "reject" ? (
              <ActivityIndicator color={colors.danger} />
            ) : (
              <Text style={[styles.btnText, { color: colors.danger }]}>Reject</Text>
            )}
          </Pressable>
          <Pressable
            onPress={accept}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel="Accept edit"
            style={({ pressed }) => [
              styles.btn,
              styles.acceptBtn,
              pressed && styles.acceptPressed,
              busy !== null && styles.btnDisabled,
            ]}
          >
            {busy === "accept" ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={[styles.btnText, { color: colors.onAccent }]}>Accept</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface },
    topbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingTop: spacing.huge,
      paddingBottom: spacing.md,
      paddingHorizontal: spacing.gutter,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
      backgroundColor: colors.paper,
    },
    closeBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    closeGlyph: { fontSize: 18, color: colors.inkSoft },
    title: { flex: 1, textAlign: "center" },
    pressed: { opacity: 0.6 },

    meta: {
      paddingHorizontal: spacing.gutter,
      paddingVertical: spacing.md,
      gap: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    metaTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    originTag: {
      ...type.meta,
      color: colors.accent,
      backgroundColor: colors.accentWash,
      borderRadius: radius.full,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      overflow: "hidden",
      fontWeight: "600",
    },
    opTag: {
      color: colors.inkSoft,
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.full,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      overflow: "hidden",
    },
    summary: { marginTop: spacing.xs },

    body: { flex: 1 },
    bodyPad: { padding: spacing.gutter, gap: 2 },
    empty: { textAlign: "center", paddingVertical: spacing.xxl },
    line: {
      flexDirection: "row",
      gap: spacing.sm,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    lineAdd: { backgroundColor: colors.liveWash },
    lineRemove: { backgroundColor: colors.dangerWash },
    sign: { ...type.body, width: 14, fontWeight: "700" },
    signAdd: { color: colors.live },
    signRemove: { color: colors.danger },
    lineBody: { flex: 1 },
    blank: { ...type.body, minHeight: 20 },

    footer: {
      flexDirection: "row",
      gap: spacing.md,
      paddingHorizontal: spacing.gutter,
      paddingTop: spacing.md,
      paddingBottom: spacing.huge,
      borderTopWidth: 1,
      borderTopColor: colors.hairline,
      backgroundColor: colors.paper,
    },
    btn: {
      flex: 1,
      minHeight: 52,
      borderRadius: radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    rejectBtn: { borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.surface },
    acceptBtn: { backgroundColor: colors.accent },
    acceptPressed: { backgroundColor: colors.accentPressed },
    btnDisabled: { opacity: 0.5 },
    btnText: { ...type.button },
  });

/** Markdown styling for a single diff line — base and a struck-through removed variant. */
const makeMarkdownStyles = (colors: Palette) => {
  const base = {
    body: { color: colors.ink, fontSize: 15, lineHeight: 22 },
    paragraph: { marginTop: 0, marginBottom: 0 },
    heading1: { fontSize: 19, fontWeight: "600" as const, color: colors.ink, marginVertical: 0 },
    heading2: { fontSize: 17, fontWeight: "600" as const, color: colors.ink, marginVertical: 0 },
    heading3: { fontSize: 15, fontWeight: "600" as const, color: colors.ink, marginVertical: 0 },
    strong: { fontWeight: "700" as const },
    em: { fontStyle: "italic" as const },
    bullet_list: { marginVertical: 0 },
    ordered_list: { marginVertical: 0 },
    list_item: { marginVertical: 0 },
    link: { color: colors.accent, textDecorationLine: "underline" as const },
    code_inline: {
      backgroundColor: colors.surfaceSunken,
      color: colors.ink,
      borderRadius: 4,
      paddingHorizontal: 4,
      fontFamily: "monospace",
      fontSize: 13,
    },
    blockquote: {
      borderLeftColor: colors.hairline,
      borderLeftWidth: 3,
      paddingLeft: 8,
      marginVertical: 0,
    },
  };
  return {
    base,
    removed: {
      ...base,
      body: { ...base.body, color: colors.inkSoft, textDecorationLine: "line-through" as const },
    },
  };
};
