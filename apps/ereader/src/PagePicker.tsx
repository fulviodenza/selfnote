/**
 * Choosing where a book's highlights go: an existing Selfnote page, or a new one
 * named after the book.
 *
 * Per book rather than global, because that is how reading works. "X notes" and
 * "Y notes" are different pages and nobody wants both books in one.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { createPage, searchPages, type Connection, type Page } from "./selfnote";

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
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.createText}>Create "{query.trim()}"</Text>
          )}
        </TouchableOpacity>
      ) : null}

      {loading ? (
        <ActivityIndicator style={styles.spinner} />
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
              {current?.id === item.id ? <Text style={styles.current}>current</Text> : null}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#faf5ef" },
  header: { paddingHorizontal: 24, paddingTop: 60, paddingBottom: 10 },
  back: { fontSize: 16, color: "#3730c4", fontWeight: "600", marginBottom: 16 },
  title: { fontSize: 24, fontWeight: "700", color: "#1b1b1b" },
  sub: { fontSize: 15, color: "#6b6b6b", marginTop: 4 },
  input: {
    marginHorizontal: 24, marginTop: 12, borderWidth: 1, borderColor: "#e0d8cb",
    borderRadius: 10, backgroundColor: "#fffdfa", paddingHorizontal: 14,
    paddingVertical: 13, fontSize: 16, color: "#1b1b1b",
  },
  create: {
    marginHorizontal: 24, marginTop: 12, paddingVertical: 14, borderRadius: 10,
    backgroundColor: "#3730c4", alignItems: "center",
  },
  busy: { opacity: 0.7 },
  createText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  clear: { marginHorizontal: 24, marginTop: 12, paddingVertical: 10 },
  clearText: { color: "#b3261e", fontSize: 14, fontWeight: "600" },
  error: { marginHorizontal: 24, marginTop: 12, fontSize: 14, color: "#b3261e" },
  spinner: { marginTop: 28 },
  list: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 60 },
  empty: { fontSize: 15, color: "#8a8a8a", paddingTop: 10 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 15,
    paddingHorizontal: 16, marginBottom: 8, borderRadius: 11,
    backgroundColor: "#fffdfa", borderWidth: 1, borderColor: "#eae2d6",
  },
  rowTitle: { flex: 1, fontSize: 16, color: "#1b1b1b" },
  current: { fontSize: 12, color: "#3730c4", fontWeight: "700" },
});
