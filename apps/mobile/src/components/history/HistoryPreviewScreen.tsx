/**
 * Read-only preview of a past checkpoint (docs/features/version-history.md §5).
 *
 * Fetches the checkpoint (GET /documents/:id/history/:checkpoint_id) and posts its
 * single base64 Yjs update into the existing BlockNote WebView, which mounts a
 * *throwaway* read-only editor over the live one — the live doc is never mutated
 * until Restore is confirmed. This surface is a transparent in-tree overlay (NOT a
 * native Modal) so the WebView's rendered past state shows through it; only the
 * read-only banner (with the checkpoint timestamp) and the action bar are painted.
 *
 * Restore (member, non-viewer) POSTs …/restore and applies the returned forward
 * `update` to the live doc so the current editor converges immediately; Delete
 * removes the checkpoint (history-management only). Strict parity with web's
 * HistoryPreview, adapted to the WebView bridge.
 */
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { api, type Checkpoint, type CheckpointDetail } from "../../api";
import type { EditorHandle } from "../../editor/WebViewEditor";
import { useTheme } from "../../theme-context";
import { radius, spacing } from "../../theme";
import type { Palette, TypeRoles } from "../../theme";
import { useToast } from "../../ui";
import { fullTime, kindLabel } from "./format";

export function HistoryPreviewScreen({
  docId,
  checkpoint,
  editorRef,
  canWrite,
  onBack,
  onRestored,
  onDeleted,
}: {
  docId: string;
  checkpoint: Checkpoint;
  editorRef: React.RefObject<EditorHandle>;
  canWrite: boolean;
  /** Dismiss the preview and return to the timeline (clears the WebView overlay). */
  onBack: () => void;
  /** Called after the restore update was applied to the live doc. */
  onRestored: () => void;
  /** Called after this checkpoint was deleted (id removed from the list). */
  onDeleted: (id: string) => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();

  const [detail, setDetail] = useState<CheckpointDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"restore" | "delete" | null>(null);

  // Fetch the checkpoint state, then drive the WebView's read-only preview.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api.getCheckpoint(docId, checkpoint.id);
        if (cancelled) return;
        setDetail(d);
        const state = d.updates?.[0];
        if (state) editorRef.current?.preview(state);
      } catch (e) {
        if (!cancelled) setError(friendly(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, checkpoint.id, editorRef]);

  const restore = () => {
    if (busy) return;
    Alert.alert(
      "Restore this version?",
      "The current state is saved as a restore point first, so nothing is lost.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          style: "default",
          onPress: async () => {
            setBusy("restore");
            try {
              const res = await api.restoreCheckpoint(
                docId,
                checkpoint.id,
                checkpoint.label ? `Restored: ${checkpoint.label}` : null,
              );
              // Clear the preview overlay, then apply the forward update to the
              // live doc so the editor underneath converges without a round-trip.
              editorRef.current?.clearPreview();
              editorRef.current?.applyUpdate(res.update);
              toast("Version restored.");
              onRestored();
            } catch (e) {
              const status = (e as { status?: number }).status;
              toast(
                status === 403
                  ? "You don't have permission to restore versions."
                  : "Couldn't restore this version. Try again.",
              );
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  const remove = () => {
    if (busy) return;
    Alert.alert("Delete this version?", "This removes the version only — the note is untouched.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy("delete");
          try {
            await api.deleteCheckpoint(docId, checkpoint.id);
            editorRef.current?.clearPreview();
            onDeleted(checkpoint.id);
          } catch (e) {
            const status = (e as { status?: number }).status;
            toast(
              status === 403
                ? "You don't have permission to delete versions."
                : "Couldn't delete this version. Try again.",
            );
            setBusy(null);
          }
        },
      },
    ]);
  };

  const when = fullTime(checkpoint.created_at);

  return (
    // Transparent overlay: the WebView renders the past state behind it. Only the
    // banner + action bar are opaque, so the preview reads as the note-in-the-past.
    <View style={styles.overlay} pointerEvents="box-none">
      <View style={styles.banner}>
        <Pressable
          onPress={onBack}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back to history"
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <View style={styles.bannerText}>
          <Text style={styles.bannerLabel} numberOfLines={1}>
            Read-only preview · {checkpoint.label || kindLabel(checkpoint.kind)}
          </Text>
          {when ? (
            <Text style={[type.meta, styles.bannerWhen]} numberOfLines={1}>
              {when}
            </Text>
          ) : null}
        </View>
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <Text style={[type.meta, { color: colors.danger }]}>{error}</Text>
        </View>
      ) : !detail ? (
        <View style={styles.errorBar}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[type.meta, styles.loadingNote]}>Loading this version…</Text>
        </View>
      ) : null}

      <View style={styles.spring} pointerEvents="none" />

      {canWrite ? (
        <View style={styles.footer}>
          <Pressable
            onPress={remove}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel="Delete version"
            style={({ pressed }) => [
              styles.btn,
              styles.deleteBtn,
              pressed && styles.pressed,
              busy !== null && styles.btnDisabled,
            ]}
          >
            {busy === "delete" ? (
              <ActivityIndicator color={colors.danger} />
            ) : (
              <Text style={[styles.btnText, { color: colors.danger }]}>Delete</Text>
            )}
          </Pressable>
          <Pressable
            onPress={restore}
            disabled={busy !== null || !detail}
            accessibilityRole="button"
            accessibilityLabel="Restore version"
            style={({ pressed }) => [
              styles.btn,
              styles.restoreBtn,
              pressed && styles.restorePressed,
              (busy !== null || !detail) && styles.btnDisabled,
            ]}
          >
            {busy === "restore" ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={[styles.btnText, { color: colors.onAccent }]}>Restore</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function friendly(e: unknown): string {
  const status = (e as { status?: number }).status;
  if (status === 404) return "This version is no longer available.";
  if (status === 403) return "You don't have access to this version.";
  return "Couldn't load this version. Try again.";
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-start" },
    banner: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingTop: spacing.huge,
      paddingBottom: spacing.md,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.accentWash,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    backGlyph: { fontSize: 28, lineHeight: 30, color: colors.accent },
    pressed: { opacity: 0.6 },
    bannerText: { flex: 1 },
    bannerLabel: { ...type.label, color: colors.accent, fontWeight: "600" },
    bannerWhen: { marginTop: 2 },

    errorBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.gutter,
      paddingVertical: spacing.md,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    loadingNote: { color: colors.inkSoft },

    spring: { flex: 1 },

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
    btn: { flex: 1, minHeight: 52, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
    deleteBtn: { borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.surface },
    restoreBtn: { backgroundColor: colors.accent },
    restorePressed: { backgroundColor: colors.accentPressed },
    btnDisabled: { opacity: 0.5 },
    btnText: { ...type.button },
  });
