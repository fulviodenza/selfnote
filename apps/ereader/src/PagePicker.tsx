/**
 * Choosing where a book's highlights go: an existing Selfnote page, or a new one
 * named after the book.
 *
 * Per book rather than global, because that is how reading works. "X notes" and
 * "Y notes" are different pages and nobody wants both books in one.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { createPage, searchPages, type Connection, type Page } from "./selfnote";
import { fonts, radius, spacing, type Palette, type TypeRoles } from "./theme";
import { useTheme } from "./theme-context";

export function PagePicker({
  connection,
  bookTitle,
  current,
  onPicked,
  onClose,
}: {
  connection: Connection;
  bookTitle: string;
  current: { id: string; title: string } | null;
  onPicked: (page: Page | null) => void;
  onClose: () => void;
}) {
  // Defaulting the name to "<book> notes" is what people would type anyway.
  const [query, setQuery] = useState(`${bookTitle} notes`);
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);

  const refresh = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        setPages(await searchPages(connection, q));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPages([]);
      } finally {
        setLoading(false);
      }
    },
    [connection],
  );

  // Debounced so typing a page name is not one request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void refresh(query), 300);
    return () => clearTimeout(t);
  }, [query, refresh]);

  const create = async () => {
    const title = query.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      onPicked(await createPage(connection, title));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exactExists = pages.some((p) => p.title.toLowerCase() === query.trim().toLowerCase());

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Text style={styles.back}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Highlights from {bookTitle}</Text>
        <Text style={styles.sub}>Pick the page they should be added to.</Text>
      </View>

      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Page name"
        placeholderTextColor={colors.inkFaint}
        autoCapitalize="sentences"
        autoCorrect={false}
      />

      {current ? (
        <TouchableOpacity style={styles.clear} onPress={() => onPicked(null)}>
          <Text style={styles.clearText}>Stop sending to "{current.title}"</Text>
        </TouchableOpacity>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!exactExists && query.trim() ? (
        <TouchableOpacity style={[styles.create, busy && styles.busy]} onPress={create} disabled={busy}>
          {busy ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={styles.createText}>Create "{query.trim()}"</Text>
          )}
        </TouchableOpacity>
      ) : null}

      {loading ? (
        <ActivityIndicator style={styles.spinner} color={colors.inkSoft} />
      ) : (
        <FlatList
          data={pages}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>No matching pages.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => onPicked(item)}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title || "Untitled"}
              </Text>
              {current?.id === item.id ? <Text style={styles.current}>Current</Text> : null}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.paper },
    header: { paddingHorizontal: spacing.xxl, paddingTop: 60, paddingBottom: 10 },
    back: { ...type.button, color: colors.accent, marginBottom: spacing.lg },
    title: {
      fontFamily: fonts.serif,
      fontSize: 24,
      lineHeight: 30,
      fontWeight: "600",
      color: colors.ink,
    },
    sub: { fontSize: 15, color: colors.inkSoft, marginTop: spacing.xs },
    input: {
      ...type.body, height: 52, marginHorizontal: spacing.xxl, marginTop: spacing.md,
      borderWidth: 1, borderColor: colors.hairline, borderRadius: radius.sm,
      backgroundColor: colors.surface, paddingHorizontal: spacing.lg,
    },
    create: {
      marginHorizontal: spacing.xxl, marginTop: spacing.md, height: 48, borderRadius: radius.md,
      backgroundColor: colors.accent, alignItems: "center", justifyContent: "center",
    },
    busy: { opacity: 0.7 },
    createText: { ...type.button, color: colors.onAccent },
    clear: { marginHorizontal: spacing.xxl, marginTop: spacing.md, paddingVertical: 10 },
    clearText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
    error: {
      marginHorizontal: spacing.xxl, marginTop: spacing.md, padding: spacing.md,
      borderRadius: radius.sm, overflow: "hidden",
      fontSize: 14, color: colors.danger, backgroundColor: colors.dangerWash,
    },
    spinner: { marginTop: 28 },
    list: { paddingHorizontal: spacing.xxl, paddingTop: spacing.lg, paddingBottom: 60 },
    empty: { fontSize: 15, color: colors.inkFaint, paddingTop: 10 },
    row: {
      flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56,
      paddingHorizontal: spacing.lg, marginBottom: spacing.sm, borderRadius: radius.md,
      backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline,
    },
    rowTitle: { ...type.docTitle, flex: 1 },
    current: { ...type.meta, fontWeight: "500" },
  });
