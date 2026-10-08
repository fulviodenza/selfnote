/**
 * The shelf. Importing copies the file into app storage rather than holding the
 * picker's URL, because a security-scoped URL does not survive a restart and the
 * book would silently stop opening.
 */
import { useCallback } from "react";
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { addBook, type Book } from "./db";

export function Library({
  books,
  onOpen,
  onChanged,
}: {
  books: Book[];
  onOpen: (b: Book) => void;
  onChanged: () => void;
}) {
  const importBook = useCallback(async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["application/epub+zip", "application/zip", "*/*"],
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0];

    const dir = `${FileSystem.documentDirectory}books/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const relative = `books/${id}.epub`;
    await FileSystem.copyAsync({ from: asset.uri, to: `${FileSystem.documentDirectory}${relative}` });

    await addBook({
      id,
      // The reader reports real metadata once the book opens; the filename is a
      // reasonable stand-in until then and is what the user recognises anyway.
      title: asset.name?.replace(/\.epub$/i, "") ?? "Untitled",
      author: null,
      // Relative on purpose; see the note on Book.file_path.
      file_path: relative,
      added_at: Date.now(),
    });
    onChanged();
  }, [onChanged]);

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <Text style={styles.wordmark}>selfnote</Text>
        <Text style={styles.sub}>reader</Text>
      </View>
      <FlatList
        data={books}
        keyExtractor={(b) => b.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No books yet. Add an EPUB to start reading. Everything stays on this device.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => onOpen(item)}>
            <Text style={styles.rowTitle} numberOfLines={2}>
              {item.title}
            </Text>
            {item.author ? <Text style={styles.rowMeta}>{item.author}</Text> : null}
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity style={styles.add} onPress={importBook}>
        <Text style={styles.addText}>Add an EPUB</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#faf5ef" },
  header: { paddingHorizontal: 28, paddingTop: 72, paddingBottom: 20 },
  wordmark: { fontSize: 34, fontWeight: "700", color: "#1b1b1b", letterSpacing: -0.5 },
  sub: { fontSize: 17, color: "#6b6b6b", marginTop: 2 },
  list: { paddingHorizontal: 20, paddingBottom: 120 },
  empty: { paddingHorizontal: 8, paddingTop: 40, fontSize: 16, lineHeight: 24, color: "#6b6b6b" },
  row: {
    paddingVertical: 18,
    paddingHorizontal: 20,
    marginBottom: 10,
    borderRadius: 14,
    backgroundColor: "#fffdfa",
    borderWidth: 1,
    borderColor: "#eae2d6",
  },
  rowTitle: { fontSize: 17, fontWeight: "600", color: "#1b1b1b" },
  rowMeta: { fontSize: 14, color: "#6b6b6b", marginTop: 4 },
  add: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 40,
    paddingVertical: 17,
    borderRadius: 14,
    backgroundColor: "#3730c4",
    alignItems: "center",
  },
  addText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
