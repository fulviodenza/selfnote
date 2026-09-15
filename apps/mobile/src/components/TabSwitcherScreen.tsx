/**
 * Tab switcher (mobile): the Chrome-on-Android model, replacing the horizontal
 * tab strip this file's predecessor implemented.
 *
 * A phone cannot spend a permanent row on a scrolling strip and still say
 * anything useful about what is open. Chrome solves this with a tab-count
 * button in the toolbar opening a full-screen grid of cards, and that is what
 * this is: every open page as a card with a title, a text excerpt and a close
 * button, so the open set is legible however many pages are in it.
 *
 * Tab state itself stays in App.tsx (`tabIds`/`activeId`/`docsById`); this
 * screen is a view over it.
 */
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { Document } from "../api";
import { loadCachedState } from "../persistence/sqlite";
import { hitSlop, radius, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { IconButton } from "../ui";
import { previewFromState } from "./tabPreview";

export function TabSwitcherScreen({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseAll,
  onNew,
  onDismiss,
}: {
  tabs: Document[];
  activeId: string | null;
  /** Activate a tab and leave the switcher. */
  onSelect: (doc: Document) => void;
  /** Close one tab; the switcher stays open so several can go in one visit. */
  onClose: (id: string) => void;
  onCloseAll: () => void;
  onNew: () => void;
  onDismiss: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);

  /*
   * Card excerpts, read once per switcher open and keyed by doc id. Reading is
   * best-effort and off the render path: a card shows its title immediately and
   * gains its excerpt when the cache answers.
   */
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    (async () => {
      const entries = await Promise.all(
        tabs.map(async (doc) => [doc.id, previewFromState(await loadCachedState(doc.id))] as const),
      );
      if (alive) setPreviews(new Map(entries));
    })();
    return () => {
      alive = false;
    };
    // Re-read when the open set changes, not on every render of the same set.
  }, [tabs.map((d) => d.id).join(",")]);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <IconButton icon="plus" label="New page" onPress={onNew} />
        <Text style={[type.label, styles.count]}>
          {tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
        </Text>
        <Pressable
          onPress={onCloseAll}
          hitSlop={hitSlop(24)}
          accessibilityRole="button"
          accessibilityLabel="Close all tabs"
        >
          <Text style={[type.label, { color: colors.ink }]}>Close all</Text>
        </Pressable>
        <IconButton icon="x" label="Done" onPress={onDismiss} />
      </View>

      <FlatList
        data={tabs}
        keyExtractor={(doc) => doc.id}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.grid}
        renderItem={({ item }) => {
          const active = item.id === activeId;
          const title = item.title || "Untitled";
          const excerpt = previews.get(item.id) ?? "";
          return (
            <Pressable
              onPress={() => onSelect(item)}
              style={[styles.card, active && { borderColor: colors.accent, borderWidth: 2 }]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={title}
            >
              <View style={styles.cardHead}>
                <Text style={[styles.cardTitle, active && styles.cardTitleActive]} numberOfLines={1}>
                  {title}
                </Text>
                <Pressable
                  onPress={() => onClose(item.id)}
                  hitSlop={hitSlop(14)}
                  accessibilityRole="button"
                  accessibilityLabel={`Close ${title}`}
                >
                  <Feather name="x" size={14} color={colors.inkSoft} />
                </Pressable>
              </View>
              <View style={styles.cardBody}>
                {excerpt ? (
                  <Text style={styles.cardExcerpt}>{excerpt}</Text>
                ) : (
                  <Text style={[styles.cardExcerpt, { color: colors.inkFaint }]}>Empty page</Text>
                )}
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

/**
 * The toolbar affordance that opens the switcher: Chrome's rounded square with
 * the open-tab count in it. Counts above 99 render as ":)", the same escape
 * hatch Chrome uses, so the glyph never overflows the square.
 */
export function TabCountButton({ count, onPress }: { count: number; onPress: () => void }) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop(26)}
      style={styles.countBtn}
      accessibilityRole="button"
      accessibilityLabel={`Open tabs (${count})`}
    >
      <Text style={styles.countBtnText}>{count > 99 ? ":)" : count}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.paper },
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    count: { flex: 1, color: colors.ink },
    grid: { padding: spacing.md, gap: spacing.md },
    column: { gap: spacing.md },
    card: {
      flex: 1,
      // Chrome's cards are portrait: tall enough for a few lines of the page.
      aspectRatio: 0.78,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.hairline,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    cardHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
      backgroundColor: colors.surfaceSunken,
    },
    cardTitle: { ...type.meta, flex: 1, color: colors.ink },
    cardTitleActive: { fontWeight: "600" },
    cardBody: { flex: 1, padding: spacing.sm },
    cardExcerpt: { ...type.meta, color: colors.inkSoft },
    countBtn: {
      minWidth: 26,
      height: 26,
      paddingHorizontal: 4,
      borderRadius: radius.sm,
      borderWidth: 2,
      borderColor: colors.ink,
      alignItems: "center",
      justifyContent: "center",
    },
    countBtnText: {
      ...type.meta,
      color: colors.ink,
      fontWeight: "600",
      lineHeight: 16,
    },
  });
