/**
 * Version history / time-travel — mobile entry screen (docs/features/
 * version-history.md §5). A full-screen modal with a newest-first timeline
 * (FlatList) fed by GET /documents/:id/history, `onEndReached` pagination via
 * `next_before`, filter chips per kind, and a header "Save version" action
 * (member, non-viewer). Tapping an entry opens the read-only HistoryPreviewScreen.
 *
 * Strict parity with web's HistoryPanel, adapted to React Native. History lives
 * server-side, so when offline the list shows a "reconnect to view history" state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { api, type Checkpoint, type CheckpointKind } from "../../api";
import { useTheme } from "../../theme-context";
import { radius, sizing, spacing } from "../../theme";
import type { Palette, TypeRoles } from "../../theme";
import { IconButton, useToast } from "../../ui";
import { HistoryEntry } from "./HistoryEntry";

const PAGE = 50;

/** Filter chips: All plus the three checkpoint kinds. */
const FILTERS: { key: CheckpointKind | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "manual", label: "Saved" },
  { key: "auto", label: "Auto" },
  { key: "restore", label: "Restores" },
];

export function HistoryScreen({
  docId,
  canWrite,
  offline,
  onClose,
  onPreview,
}: {
  docId: string;
  /** False for viewers: Save/Restore/Delete are hidden (server also enforces). */
  canWrite: boolean;
  /** History is server-side; when offline we show a reconnect state. */
  offline: boolean;
  onClose: () => void;
  /**
   * Open the read-only preview for a checkpoint. The parent owns the preview so
   * the WebView (which renders the past state) isn't hidden behind this modal.
   */
  onPreview: (checkpoint: Checkpoint) => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();

  const [filter, setFilter] = useState<CheckpointKind | "all">("all");
  const [items, setItems] = useState<Checkpoint[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Guards a stale response from clobbering a newer filter/refresh.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (offline) {
      setLoading(false);
      return;
    }
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.listHistory(docId, {
        limit: PAGE,
        kind: filter === "all" ? undefined : filter,
      });
      if (seq !== loadSeq.current) return;
      setItems(page.checkpoints);
      setNextBefore(page.next_before);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendly(e));
      setItems([]);
      setNextBefore(null);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [docId, filter, offline]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (offline || loadingMore || loading || !nextBefore) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    try {
      const page = await api.listHistory(docId, {
        limit: PAGE,
        before: nextBefore,
        kind: filter === "all" ? undefined : filter,
      });
      if (seq !== loadSeq.current) return;
      setItems((prev) => [...prev, ...page.checkpoints]);
      setNextBefore(page.next_before);
    } catch {
      /* transient — the user can pull to retry via the filter chips */
    } finally {
      if (seq === loadSeq.current) setLoadingMore(false);
    }
  }, [docId, filter, nextBefore, loading, loadingMore, offline]);

  // "Save version": prompt for an optional label, POST, then prepend the result.
  const saveVersion = () => {
    if (saving) return;
    const submit = async (label?: string) => {
      setSaving(true);
      try {
        const cp = await api.createCheckpoint(docId, label?.trim() ? label.trim() : null);
        // Respect the active filter — only surface it if it belongs in this view.
        if (filter === "all" || filter === "manual") {
          setItems((prev) => [cp, ...prev.filter((x) => x.id !== cp.id)]);
        }
        toast("Version saved.");
      } catch (e) {
        const status = (e as { status?: number }).status;
        toast(status === 403 ? "You don't have permission to save versions." : "Couldn't save this version.");
      } finally {
        setSaving(false);
      }
    };
    if (typeof Alert.prompt === "function") {
      Alert.prompt(
        "Save version",
        "Add an optional label (max 200 characters).",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Save", onPress: (text) => void submit(text) },
        ],
        "plain-text",
        "",
      );
    } else {
      // Android has no Alert.prompt — save an unlabelled checkpoint.
      void submit();
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={styles.screen}>
        <View style={styles.topbar}>
          <IconButton icon="x" label="Close version history" onPress={onClose} />
          <Text style={[type.docTitle, styles.title]} numberOfLines={1}>
            Version history
          </Text>
          {canWrite && !offline ? (
            <IconButton icon="plus" label="Save version" onPress={saveVersion} disabled={saving} />
          ) : (
            <View style={styles.spacer} />
          )}
        </View>

        {!offline ? (
          <View style={styles.filters}>
            {FILTERS.map((f) => {
              const active = filter === f.key;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setFilter(f.key)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {offline ? (
          <View style={styles.center}>
            <Text style={[type.docTitle, { color: colors.inkSoft, textAlign: "center" }]}>
              Reconnect to view history
            </Text>
            <Text style={[type.meta, styles.centerNote]}>
              Version history lives on your server and needs a connection.
            </Text>
          </View>
        ) : loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={[type.body, { color: colors.danger, textAlign: "center" }]}>{error}</Text>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.center}>
            <Text style={[type.docTitle, { color: colors.inkSoft, textAlign: "center" }]}>
              No versions yet
            </Text>
            {canWrite ? (
              <Text style={[type.meta, styles.centerNote]}>
                Tap the plus button to save the current state as a version.
              </Text>
            ) : null}
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(c) => c.id}
            renderItem={({ item }) => (
              <HistoryEntry checkpoint={item} onPress={() => onPreview(item)} />
            )}
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.footer}>
                  <ActivityIndicator color={colors.accent} />
                </View>
              ) : null
            }
          />
        )}
      </View>
    </Modal>
  );
}

function friendly(e: unknown): string {
  const status = (e as { status?: number }).status;
  if (status === 403) return "You don't have access to this note's history.";
  if (status === 404) return "This note is no longer available.";
  return "Couldn't load version history. Try again.";
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
      paddingHorizontal: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
      backgroundColor: colors.paper,
    },
    title: { flex: 1, textAlign: "center" },
    spacer: { width: sizing.iconVisual, height: sizing.iconVisual },
    filters: {
      flexDirection: "row",
      gap: spacing.sm,
      paddingHorizontal: spacing.gutter,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    chip: {
      minHeight: 32,
      justifyContent: "center",
      paddingHorizontal: spacing.md,
      borderRadius: radius.full,
      backgroundColor: colors.surfaceSunken,
    },
    chipActive: { backgroundColor: colors.accent },
    chipText: { ...type.label, color: colors.inkSoft },
    chipTextActive: { color: colors.onAccent },
    center: {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.xxl,
      gap: spacing.sm,
    },
    centerNote: { textAlign: "center" },
    footer: { paddingVertical: spacing.lg, alignItems: "center" },
  });
