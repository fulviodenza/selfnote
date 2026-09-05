/**
 * "Share link analytics" bottom sheet (docs/features/share-analytics.md §5).
 * Strict parity with web's ShareAnalyticsPanel, adapted to React Native.
 *
 * Opened from the editor's Share action. Lists every share link for the current
 * document with its view count and last-viewed relative time ("Never" when the
 * link has never been resolved), each with a Copy button for the `/shared/:id`
 * URL. Fetches on open; pull-to-refresh re-runs listShares. Creating a link
 * prepends the new (0-view) row and copies its URL, matching web. Gated to
 * owners/editors — the Share entry point is already hidden for viewers.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, type ShareAnalytics } from "../api";
import { getSettings } from "../settings";
import { radius, shadow, sizing, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { relativeTime } from "../components/history/format";
import { Button, IconButton, useToast } from "../ui";

/** The web origin that serves `/shared/:id` (strip the trailing `/api`). */
function shareOrigin(): string {
  return getSettings().apiUrl.replace(/\/api\/?$/, "");
}

/** Absolute share URL from a server-relative `url` (e.g. "/shared/uuid"). */
function absoluteShareUrl(url: string): string {
  return `${shareOrigin()}${url}`;
}

export function ShareAnalyticsSheet({
  docId,
  onClose,
}: {
  docId: string;
  onClose: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [shares, setShares] = useState<ShareAnalytics[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch analytics on open (and via pull-to-refresh); no live polling.
  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
      try {
        const res = await api.listShares(docId);
        setShares(res.shares);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message.slice(0, 120) : "Couldn't load share links.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [docId],
  );

  useEffect(() => {
    load("initial");
  }, [load]);

  const copy = useCallback(
    async (share: ShareAnalytics) => {
      await Clipboard.setStringAsync(absoluteShareUrl(share.url));
      toast("Share link copied.");
    },
    [toast],
  );

  // Create a link, prepend the new (0-view) row, and copy its URL — matching web.
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const s = await api.createShare(docId, "rw");
      const row: ShareAnalytics = {
        id: s.id,
        doc_id: s.doc_id,
        mode: s.mode,
        url: s.url,
        view_count: s.view_count ?? 0,
        last_viewed_at: s.last_viewed_at ?? null,
        expires_at: null,
        created_at: new Date().toISOString(),
      };
      setShares((prev) => [row, ...prev.filter((x) => x.id !== row.id)]);
      await Clipboard.setStringAsync(absoluteShareUrl(row.url));
      toast("Share link created and copied.");
    } catch (e) {
      toast(e instanceof Error ? e.message.slice(0, 120) : "Couldn't create a share link.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.panel, { backgroundColor: colors.surface }]}>
          <View style={[styles.grabber, { backgroundColor: colors.hairline }]} />
          <View style={styles.header}>
            <Text style={type.title}>Share links</Text>
            <IconButton icon="x" label="Close" onPress={onClose} />
          </View>

          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : (
            <FlatList
              data={shares}
              keyExtractor={(s) => s.id}
              style={styles.list}
              contentContainerStyle={shares.length === 0 ? styles.emptyContainer : undefined}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => load("refresh")}
                  tintColor={colors.accent}
                />
              }
              ListEmptyComponent={
                <Text style={[type.meta, styles.empty]}>
                  {error ?? "No share links yet. Create one to start sharing this note."}
                </Text>
              }
              renderItem={({ item }) => <ShareRow share={item} onCopy={() => copy(item)} />}
            />
          )}

          <Button label="Create share link" onPress={create} loading={creating} />
        </View>
      </View>
    </Modal>
  );
}

/** One share link: URL + copy, mode badge, view count, and last-viewed time. */
function ShareRow({ share, onCopy }: { share: ShareAnalytics; onCopy: () => void }) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const lastViewed = share.last_viewed_at ? relativeTime(share.last_viewed_at) : "Never";
  const views = `${share.view_count} view${share.view_count === 1 ? "" : "s"}`;

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Text
          style={[styles.badge, share.mode === "rw" && styles.badgeRw]}
          accessibilityLabel={share.mode === "rw" ? "Can edit" : "Read only"}
        >
          {share.mode}
        </Text>
        <Text style={[type.meta, styles.url]} numberOfLines={1} selectable>
          {absoluteShareUrl(share.url)}
        </Text>
        <IconButton icon="copy" label="Copy share link" onPress={onCopy} />
      </View>
      <View style={styles.stats}>
        <Text style={type.meta}>{views}</Text>
        <Text style={[type.meta, styles.dot]}>·</Text>
        <Text style={type.meta}>Last viewed {lastViewed}</Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(20,22,28,0.45)" },
    panel: {
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.xxl,
      paddingBottom: spacing.xxxl,
      gap: spacing.lg,
      maxHeight: "80%",
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
    loading: { alignSelf: "center", paddingVertical: spacing.xl },
    list: { maxHeight: 360 },
    emptyContainer: { paddingVertical: spacing.xl },
    empty: { textAlign: "center", color: colors.inkSoft },
    row: {
      paddingVertical: spacing.md,
      gap: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    rowTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: sizing.minTarget },
    badge: {
      ...type.meta,
      color: colors.inkSoft,
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.full,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      overflow: "hidden",
      fontWeight: "600",
      textTransform: "uppercase",
    },
    badgeRw: { color: colors.accent, backgroundColor: colors.accentWash },
    url: { flex: 1, color: colors.ink },
    stats: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
    dot: { color: colors.inkFaint },
  });
