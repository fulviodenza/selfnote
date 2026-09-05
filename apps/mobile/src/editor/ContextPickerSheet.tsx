/**
 * Bottom sheet for picking extra notes to fold into an Assist turn — the mobile
 * counterpart to web's ContextPicker popover. Three sections, identical data
 * sources to web:
 *   - Linked  → api.getDocLinks(currentDocId)
 *   - Recent  → api.recentDocuments()
 *   - Search  → api.searchDocuments(workspaceId, q) for the "manual" case
 *
 * The current note and already-selected notes are filtered out everywhere. The
 * caller resolves each pick's Markdown body when the chat is sent.
 */
import { useEffect, useMemo, useState } from "react";
import { Feather } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { useTheme } from "../theme-context";
import { radius, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { Sheet } from "../ui";
import type { ContextNote } from "./contextNotes";

export function ContextPickerSheet({
  docId,
  workspaceId,
  selectedIds,
  onAdd,
  onClose,
}: {
  docId: string;
  workspaceId: string;
  /** ids already chosen (or the current note) — excluded from every list. */
  selectedIds: Set<string>;
  onAdd: (note: ContextNote) => void;
  onClose: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);

  const [linked, setLinked] = useState<ContextNote[] | null>(null);
  const [recent, setRecent] = useState<ContextNote[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContextNote[]>([]);
  const [searching, setSearching] = useState(false);

  // Linked + recent load once when the sheet opens.
  useEffect(() => {
    let alive = true;
    api
      .getDocLinks(docId)
      .then((links) =>
        alive &&
        setLinked(
          links.map((l) => ({
            id: l.target.id,
            title: l.target.title,
            icon: l.target.icon,
            source: "linked" as const,
          })),
        ),
      )
      .catch(() => alive && setLinked([]));
    api
      .recentDocuments()
      .then((docs) =>
        alive &&
        setRecent(
          docs.map((d) => ({ id: d.id, title: d.title, icon: d.icon, source: "recent" as const })),
        ),
      )
      .catch(() => alive && setRecent([]));
    return () => {
      alive = false;
    };
  }, [docId]);

  // Debounced title search for the manual case.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(() => {
      api
        .searchDocuments(workspaceId, q)
        .then((docs) => {
          if (!alive) return;
          setResults(
            docs.map((d) => ({ id: d.id, title: d.title, icon: d.icon, source: "manual" as const })),
          );
          setSearching(false);
        })
        .catch(() => {
          if (!alive) return;
          setResults([]);
          setSearching(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, workspaceId]);

  const exclude = (notes: ContextNote[]) => notes.filter((n) => !selectedIds.has(n.id));
  const linkedRows = linked ? exclude(linked) : null;
  const recentRows = recent ? exclude(recent) : null;
  const searchRows = exclude(results);

  const nothingToSuggest =
    linkedRows !== null &&
    recentRows !== null &&
    linkedRows.length === 0 &&
    recentRows.length === 0;

  const row = (note: ContextNote) => (
    <Pressable
      key={`${note.source}:${note.id}`}
      onPress={() => onAdd(note)}
      accessibilityRole="button"
      accessibilityLabel={`Add ${note.title || "Untitled"}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {note.icon ? (
        <Text style={styles.rowIcon}>{note.icon}</Text>
      ) : (
        <Feather name="file-text" size={16} color={colors.inkSoft} style={styles.rowIconGlyph} />
      )}
      <Text style={[type.body, styles.rowTitle]} numberOfLines={1}>
        {note.title || "Untitled"}
      </Text>
      <Feather name="plus" size={18} color={colors.accent} style={styles.rowAdd} />
    </Pressable>
  );

  const section = (label: string, rows: ContextNote[] | null, empty: string) => (
    <View style={styles.section}>
      <Text style={[type.label, styles.sectionLabel]}>{label}</Text>
      {rows === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : rows.length === 0 ? (
        <Text style={[type.meta, styles.empty]}>{empty}</Text>
      ) : (
        rows.map(row)
      )}
    </View>
  );

  return (
    <Sheet title="Add note context" onClose={onClose}>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Search notes…"
        placeholderTextColor={colors.inkSoft}
        autoCorrect={false}
        autoCapitalize="none"
      />
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        {query.trim() ? (
          <View style={styles.section}>
            <Text style={[type.label, styles.sectionLabel]}>Search</Text>
            {searching ? (
              <ActivityIndicator color={colors.accent} style={styles.loading} />
            ) : searchRows.length === 0 ? (
              <Text style={[type.meta, styles.empty]}>No matching notes.</Text>
            ) : (
              searchRows.map(row)
            )}
          </View>
        ) : (
          <>
            {section("Linked", linkedRows, "No linked notes.")}
            {section("Recent", recentRows, "No recent notes.")}
            {nothingToSuggest ? (
              <Text style={[type.meta, styles.hint]}>
                Search above to add any note from this workspace.
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    search: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: colors.hairline,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.ink,
      fontSize: 15,
      backgroundColor: colors.surface,
    },
    scroll: { maxHeight: 360 },
    section: { marginBottom: spacing.md },
    sectionLabel: { marginBottom: spacing.xs },
    loading: { alignSelf: "flex-start", marginVertical: spacing.sm },
    empty: { color: colors.inkFaint, marginBottom: spacing.xs },
    hint: { color: colors.inkFaint },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 44,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    rowPressed: { backgroundColor: colors.accentWash },
    rowIcon: { fontSize: 16, width: 22, textAlign: "center" },
    rowIconGlyph: { width: 22, textAlign: "center" },
    rowTitle: { ...type.body, flex: 1 },
    rowAdd: { width: 24, textAlign: "center" },
  });
