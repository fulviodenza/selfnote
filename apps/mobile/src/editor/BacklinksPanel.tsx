/**
 * Backlinks panel (docs/features/backlinks-graph.md §5) — the mobile parity for
 * web's BacklinksPanel. Rendered below the editor in the document screen.
 *
 * "Linked references" lists the non-archived notes that link *here* (GET
 * /documents/:id/backlinks); an optional "Outgoing links" subsection lists this
 * note's own outgoing links (GET /documents/:id/links). Tapping a row navigates
 * to that document. Collapsible, styled with the Ink & Paper tokens. Backlinks
 * require the network — when offline we show the standard offline placeholder.
 *
 * `refreshKey` lets the parent force a re-fetch after the editor re-scans and
 * PUTs its outgoing links (a new backlink may have appeared on the target side).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { api, type Backlink, type OutgoingLink } from "../api";
import { spacing } from "../theme";
import { useTheme } from "../theme-context";
import { Row } from "../ui";

export interface BacklinksPanelProps {
  docId: string;
  /** Whether the sync connection is offline (backlinks/graph require network). */
  offline?: boolean;
  /** Bump to force a re-fetch (e.g. after the editor's links were saved). */
  refreshKey?: number;
  /** Tapping a linked/backlinked row opens that document. */
  onNavigateToDoc: (id: string) => void;
}

/** One tappable reference row: icon + title, with an optional label snippet. */
function RefRow({
  icon,
  title,
  label,
  onPress,
}: {
  icon: string | null;
  title: string;
  label: string | null;
  onPress: () => void;
}) {
  const { colors, type } = useTheme();
  return (
    <Row onPress={onPress} accessibilityLabel={title || "Untitled"}>
      <View style={styles.refRow}>
        <Text style={styles.refIcon}>{icon || "📄"}</Text>
        <View style={styles.flex}>
          <Text style={type.docTitle} numberOfLines={1}>
            {title || "Untitled"}
          </Text>
          {label ? (
            <Text style={[type.meta, { color: colors.inkFaint }]} numberOfLines={1}>
              {label}
            </Text>
          ) : null}
        </View>
      </View>
    </Row>
  );
}

export function BacklinksPanel({
  docId,
  offline = false,
  refreshKey = 0,
  onNavigateToDoc,
}: BacklinksPanelProps) {
  const { colors, type } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingLink[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const [b, o] = await Promise.all([api.getBacklinks(docId), api.getDocLinks(docId)]);
      setBacklinks(b);
      setOutgoing(o);
    } catch {
      setError(true);
      setBacklinks(null);
      setOutgoing(null);
    }
  }, [docId]);

  useEffect(() => {
    if (offline) return; // network-only; the offline placeholder covers this
    setBacklinks(null);
    setOutgoing(null);
    void load();
  }, [load, offline, refreshKey]);

  const headerCount = backlinks?.length ?? 0;
  const loading = !offline && !error && backlinks === null;

  const body = useMemo(() => {
    if (offline) {
      return (
        <Text style={[styles.placeholder, { color: colors.inkFaint }]}>
          Linked references are unavailable offline.
        </Text>
      );
    }
    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      );
    }
    if (error) {
      return (
        <Text style={[styles.placeholder, { color: colors.inkFaint }]}>
          Couldn&apos;t load linked references.
        </Text>
      );
    }
    return (
      <>
        {headerCount === 0 ? (
          <Text style={[styles.placeholder, { color: colors.inkFaint }]}>
            No notes link here yet.
          </Text>
        ) : (
          backlinks!.map((bl) => (
            <RefRow
              key={`in-${bl.source.id}`}
              icon={bl.source.icon}
              title={bl.source.title}
              label={bl.label}
              onPress={() => onNavigateToDoc(bl.source.id)}
            />
          ))
        )}
        {outgoing && outgoing.length > 0 ? (
          <>
            <Text style={[type.label, styles.subhead]}>Outgoing links</Text>
            {outgoing.map((ol) => (
              <RefRow
                key={`out-${ol.target.id}`}
                icon={ol.target.icon}
                title={ol.target.title}
                label={ol.label}
                onPress={() => onNavigateToDoc(ol.target.id)}
              />
            ))}
          </>
        ) : null}
      </>
    );
  }, [
    offline,
    loading,
    error,
    headerCount,
    backlinks,
    outgoing,
    colors.accent,
    colors.inkFaint,
    type.label,
    onNavigateToDoc,
  ]);

  return (
    <View style={[styles.wrap, { borderTopColor: colors.hairline, backgroundColor: colors.surface }]}>
      <Pressable
        style={styles.header}
        onPress={() => setCollapsed((c) => !c)}
        accessibilityRole="button"
        accessibilityLabel={collapsed ? "Expand linked references" : "Collapse linked references"}
      >
        <Text style={[styles.chevron, { color: colors.inkFaint }]}>{collapsed ? "▸" : "▾"}</Text>
        <Text style={[type.label, styles.flex]}>
          Linked references{headerCount > 0 ? ` (${headerCount})` : ""}
        </Text>
      </Pressable>
      {collapsed ? null : body}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { borderTopWidth: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.gutter,
    paddingVertical: spacing.md,
  },
  chevron: { fontSize: 14, width: 16, textAlign: "center" },
  subhead: { paddingHorizontal: spacing.gutter, paddingTop: spacing.md, paddingBottom: spacing.xs },
  refRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  refIcon: { fontSize: 18, width: 24, textAlign: "center" },
  placeholder: {
    paddingHorizontal: spacing.gutter,
    paddingBottom: spacing.lg,
    fontSize: 15,
  },
  center: { paddingVertical: spacing.xl, alignItems: "center" },
});
