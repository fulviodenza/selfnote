/**
 * Browser-style page tabs (mobile): parity with web's TabStrip in
 * apps/web/src/App.tsx. One tab per open page, the active one "connected" to
 * the editor surface below it (same background, no bottom edge).
 *
 * Web shows the strip whenever anything is open. A phone has no room to spend
 * a permanent row on a single tab, so it only appears once a second page is
 * open, which is also the first moment it can do anything useful.
 */
import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { Document } from "../api";
import { hitSlop, radius, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";

export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: Document[];
  activeId: string | null;
  onSelect: (doc: Document) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  if (tabs.length < 2) return null;

  return (
    <View style={styles.strip}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {tabs.map((doc) => {
          const active = doc.id === activeId;
          const title = doc.title || "Untitled";
          return (
            <Pressable
              key={doc.id}
              onPress={() => onSelect(doc)}
              style={[styles.tab, active && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={title}
            >
              <Text
                style={[styles.tabTitle, active && styles.tabTitleActive]}
                numberOfLines={1}
              >
                {title}
              </Text>
              <Pressable
                onPress={() => onClose(doc.id)}
                hitSlop={hitSlop(16)}
                accessibilityRole="button"
                accessibilityLabel={`Close ${title}`}
              >
                <Feather name="x" size={14} color={colors.inkSoft} />
              </Pressable>
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        onPress={onNew}
        hitSlop={hitSlop(24)}
        style={styles.new}
        accessibilityRole="button"
        accessibilityLabel="New page"
      >
        <Feather name="plus" size={18} color={colors.inkSoft} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    strip: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.surfaceSunken,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    scroll: { alignItems: "center", gap: spacing.xs, padding: spacing.xs },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      maxWidth: 180,
      paddingLeft: spacing.md,
      paddingRight: spacing.sm,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
    },
    tabActive: { backgroundColor: colors.paper },
    tabTitle: { ...type.meta, flexShrink: 1 },
    tabTitleActive: { color: colors.ink, fontWeight: "600" },
    new: {
      paddingHorizontal: spacing.md,
      alignSelf: "stretch",
      justifyContent: "center",
    },
  });
