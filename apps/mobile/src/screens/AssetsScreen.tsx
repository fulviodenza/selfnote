/**
 * Assets shelf (mobile): parity with web's AssetsView in apps/web/src/App.tsx,
 * every file uploaded into this workspace, with a preview, a jump to the page
 * the file lives in, and a permanent delete.
 *
 * Web previews images, video, audio and PDFs inline in a modal. On the phone we
 * only have <Image> without pulling in a media dependency, so images preview in
 * app and everything else hands off to the system viewer via Linking. The
 * download route is unauthenticated, so both work without the bearer token.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { api, type FileAsset } from "../api";
import { sizing, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { IconButton, Row, useToast, type IconName } from "../ui";

type PreviewKind = "image" | "video" | "audio" | "pdf" | "other";

/** What an asset can be shown as, from its mime type and/or filename. */
function previewKind(mime: string | null, name: string): PreviewKind {
  if (mime) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "pdf";
  }
  return /\.pdf$/i.test(name) ? "pdf" : "other";
}

const ATTACH_ICON: Record<PreviewKind, IconName> = {
  image: "image",
  video: "film",
  audio: "music",
  pdf: "file-text",
  other: "paperclip",
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const nameOf = (a: FileAsset) => a.name || `${a.mime.split("/")[1] ?? "file"}-${a.id.slice(0, 8)}`;

export function AssetsScreen({
  workspaceId,
  onBack,
  onOpenPage,
}: {
  workspaceId: string;
  onBack: () => void;
  onOpenPage: (docId: string) => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [assets, setAssets] = useState<FileAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [preview, setPreview] = useState<FileAsset | null>(null);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      setError(null);
      try {
        setAssets(await api.listFiles(workspaceId));
      } catch {
        // Leave whatever we had: an unreachable server is not an empty shelf.
        setError("Couldn't load the workspace files.");
      } finally {
        if (isRefresh) setRefreshing(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    load();
  }, [load]);

  const open = (asset: FileAsset) => {
    if (previewKind(asset.mime, nameOf(asset)) === "image") {
      setPreview(asset);
      return;
    }
    Linking.openURL(api.fileUrl(asset.id)).catch(() => toast("No app can open that file."));
  };

  const remove = (asset: FileAsset) =>
    Alert.alert(
      "Delete this file?",
      `"${nameOf(asset)}" is removed from the server for good. Pages that embed it will show a broken link.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setAssets((prev) => prev?.filter((a) => a.id !== asset.id) ?? prev);
            try {
              await api.deleteFile(asset.id);
              toast("Deleted.");
            } catch {
              toast("Couldn't delete that file.");
              load();
            }
          },
        },
      ],
    );

  return (
    <View style={styles.flex}>
      <View style={styles.topbar}>
        <IconButton icon="chevron-left" label="Back to documents" onPress={onBack} />
        <View style={styles.flex}>
          <Text style={type.docTitle} numberOfLines={1}>
            Assets
          </Text>
          <Text style={type.meta}>
            {assets
              ? `${assets.length} file${assets.length === 1 ? "" : "s"}`
              : error
                ? ""
                : "Loading…"}
          </Text>
        </View>
        <IconButton icon="refresh-cw" label="Refresh" onPress={() => load(true)} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {assets === null ? (
        error ? null : (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        )
      ) : assets.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>
            No files yet. Attach an image or file to a page and it shows up here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={assets}
          keyExtractor={(a) => a.id}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          renderItem={({ item }) => (
            <Row
              onPress={() => open(item)}
              accessibilityLabel={nameOf(item)}
              trailing={
                <>
                  {item.doc_id ? (
                    <IconButton
                      icon="file-text"
                      label="Open the page this file lives in"
                      onPress={() => onOpenPage(item.doc_id!)}
                    />
                  ) : null}
                  <IconButton
                    icon="trash-2"
                    tone="danger"
                    label="Delete this file permanently"
                    onPress={() => remove(item)}
                  />
                </>
              }
            >
              <View style={styles.rowInner}>
                <Feather
                  name={ATTACH_ICON[previewKind(item.mime, nameOf(item))]}
                  size={17}
                  color={colors.inkFaint}
                />
                <View style={styles.flex}>
                  <Text style={type.docTitle} numberOfLines={1}>
                    {nameOf(item)}
                  </Text>
                  <Text style={type.meta}>
                    {humanSize(item.size)} · {new Date(item.created_at).toLocaleDateString()}
                  </Text>
                </View>
              </View>
            </Row>
          )}
        />
      )}

      <Modal
        visible={preview !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(null)}
      >
        <Pressable style={styles.previewScrim} onPress={() => setPreview(null)}>
          {preview ? (
            <Image
              source={{ uri: api.fileUrl(preview.id) }}
              style={styles.previewImage}
              resizeMode="contain"
              accessibilityLabel={nameOf(preview)}
            />
          ) : null}
        </Pressable>
      </Modal>
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
    previewScrim: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.85)",
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.lg,
    },
    previewImage: { width: "100%", height: "100%" },
  });
