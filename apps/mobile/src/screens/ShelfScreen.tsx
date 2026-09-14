/**
 * Archive / Trash shelves (mobile): parity with web's ShelfView in
 * apps/web/src/App.tsx. Lists the pages sitting on one shelf and offers the
 * same actions: restore to the tree, move an archived page on to the trash,
 * and delete a trashed page for good.
 *
 * The web row arms "Delete forever" on a first click and commits on a second;
 * on a phone that pattern reads as a mis-tap, so the irreversible action goes
 * through a native confirm dialog instead. Everything else matches.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { api, type Document } from "../api";
import { sizing, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { IconButton, Row, useToast } from "../ui";

export type Shelf = "archive" | "trash";

export function ShelfScreen({
  shelf,
  workspaceId,
  onBack,
}: {
  shelf: Shelf;
  workspaceId: string;
  onBack: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      setError(null);
      try {
        setDocs(await api.listDocuments(workspaceId, shelf === "archive" ? "archived" : "trashed"));
      } catch {
        // Leave whatever we had: an unreachable server is not an empty shelf.
        setError("Couldn't load this list.");
      } finally {
        if (isRefresh) setRefreshing(false);
      }
    },
    [workspaceId, shelf],
  );

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Run one shelf mutation and reconcile. Every action moves the row off this
   * shelf, so it goes first and the reload confirms it. The page tree picks the
   * change up on its own: leaving a shelf unmounts the list screen, and it
   * refetches when it mounts again.
   */
  const run = async (doc: Document, op: Promise<unknown>, done: string) => {
    setDocs((prev) => prev?.filter((d) => d.id !== doc.id) ?? prev);
    try {
      await op;
      toast(done);
    } catch {
      toast("That didn't work. Try again.");
    } finally {
      load();
    }
  };

  const restore = (doc: Document) =>
    run(
      doc,
      api.updateDocument(doc.id, { archived: false, trashed: false }),
      `Restored "${doc.title || "Untitled"}"`,
    );

  const toTrash = (doc: Document) =>
    run(doc, api.updateDocument(doc.id, { trashed: true }), `Moved "${doc.title || "Untitled"}" to trash`);

  const deleteForever = (doc: Document) =>
    Alert.alert(
      "Delete forever?",
      `"${doc.title || "Untitled"}" and its contents are removed from the server for good. This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void run(doc, api.deleteDocument(doc.id), "Deleted."),
        },
      ],
    );

  const title = shelf === "archive" ? "Archive" : "Trash";
  const count = docs
    ? `${docs.length} page${docs.length === 1 ? "" : "s"}`
    : error
      ? ""
      : "Loading…";

  return (
    <View style={styles.flex}>
      <View style={styles.topbar}>
        <IconButton icon="chevron-left" label="Back to documents" onPress={onBack} />
        <View style={styles.flex}>
          <Text style={type.docTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={type.meta}>{count}</Text>
        </View>
        <IconButton icon="refresh-cw" label="Refresh" onPress={() => load(true)} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {docs === null ? (
        error ? null : (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        )
      ) : docs.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>
            {shelf === "archive" ? "Nothing archived." : "The trash is empty."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={docs}
          keyExtractor={(d) => d.id}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          renderItem={({ item }) => (
            <Row
              accessibilityLabel={item.title || "Untitled"}
              trailing={
                <>
                  <IconButton icon="rotate-ccw" label="Restore" onPress={() => void restore(item)} />
                  {shelf === "archive" ? (
                    <IconButton
                      icon="trash-2"
                      label="Move to trash"
                      onPress={() => void toTrash(item)}
                    />
                  ) : (
                    <IconButton
                      icon="trash-2"
                      tone="danger"
                      label="Delete forever"
                      onPress={() => deleteForever(item)}
                    />
                  )}
                </>
              }
            >
              <View style={styles.rowInner}>
                <Feather name="file-text" size={16} color={colors.inkFaint} />
                <View style={styles.flex}>
                  <Text style={type.docTitle} numberOfLines={1}>
                    {item.title || "Untitled"}
                  </Text>
                  <Text style={type.meta}>{new Date(item.updated_at).toLocaleDateString()}</Text>
                </View>
              </View>
            </Row>
          )}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    flex: { flex: 1 },
    center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxl },
    topbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: sizing.row,
      paddingHorizontal: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
      backgroundColor: colors.paper,
    },
    rowInner: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    empty: { ...type.body, color: colors.inkSoft, textAlign: "center" },
    error: { ...type.body, color: colors.danger, padding: spacing.gutter },
  });
