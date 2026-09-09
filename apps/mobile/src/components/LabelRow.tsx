/**
 * LabelRow (mobile) — the note's labels as colored chips above the editor, with
 * an add/remove sheet over the workspace vocabulary and an AI "Suggest" flow.
 * Mobile parity for web's LabelBar (apps/web/src/LabelBar.tsx): suggestions are
 * only persisted when the user accepts them.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Feather } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type Label, type LabelSuggestion } from "../api";
import { spacing } from "../theme";
import { useTheme } from "../theme-context";

export function LabelRow({
  docId,
  workspaceId,
  aiAvailable,
  getText,
  onError,
}: {
  docId: string;
  workspaceId: string;
  aiAvailable: boolean;
  /** The note's current text/Markdown (for the AI suggester). */
  getText: () => Promise<string>;
  onError?: (message: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [labels, setLabels] = useState<Label[]>([]);
  const [all, setAll] = useState<Label[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<LabelSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [mine, vocab] = await Promise.all([
        api.getDocLabels(docId),
        api.listLabels(workspaceId),
      ]);
      setLabels(mine);
      setAll(vocab);
    } catch {
      /* offline / older server — hide quietly */
    }
  }, [docId, workspaceId]);

  useEffect(() => {
    setSuggestions([]);
    void reload();
  }, [reload]);

  const save = async (ids: string[]) => {
    try {
      setLabels(await api.setDocLabels(docId, ids));
    } catch {
      onError?.("Couldn't update labels.");
      void reload();
    }
  };

  const toggle = (label: Label) => {
    const has = labels.some((l) => l.id === label.id);
    const ids = has
      ? labels.filter((l) => l.id !== label.id).map((l) => l.id)
      : [...labels.map((l) => l.id), label.id];
    void save(ids);
  };

  const createFromQuery = async () => {
    const name = query.trim();
    if (!name) return;
    try {
      const label = await api.createLabel(workspaceId, name);
      setAll((prev) => (prev.some((l) => l.id === label.id) ? prev : [...prev, label]));
      await save([...labels.map((l) => l.id), label.id]);
      setQuery("");
    } catch {
      onError?.("Couldn't create the label.");
    }
  };

  const suggest = async () => {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const text = await getText();
      const got = await api.suggestLabels(docId, text);
      const attached = new Set(labels.map((l) => l.name.toLowerCase()));
      const fresh = got.filter((s) => !attached.has(s.name.toLowerCase()));
      setSuggestions(fresh);
      if (fresh.length === 0) onError?.("No new label suggestions.");
    } catch {
      onError?.("Couldn't get label suggestions.");
    } finally {
      setSuggesting(false);
    }
  };

  const accept = async (s: LabelSuggestion) => {
    try {
      const label = s.existing_id
        ? { id: s.existing_id }
        : await api.createLabel(workspaceId, s.name);
      await save([...labels.map((l) => l.id), label.id]);
      setSuggestions((prev) => prev.filter((x) => x.name !== s.name));
      void reload();
    } catch {
      onError?.("Couldn't add the label.");
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = all.filter((l) => !q || l.name.toLowerCase().includes(q));
  const exactExists = all.some((l) => l.name.toLowerCase() === q);

  return (
    <View style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {labels.map((l) => (
          <Pressable
            key={l.id}
            style={[styles.chip, { borderColor: l.color, backgroundColor: `${l.color}20` }]}
            onLongPress={() => toggle(l)}
            accessibilityLabel={`Label ${l.name} (long-press to remove)`}
          >
            <View style={[styles.dot, { backgroundColor: l.color }]} />
            <Text style={styles.chipText}>{l.name}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.addBtn} onPress={() => setSheetOpen(true)}>
          <Feather name="plus" size={12} color={colors.inkSoft} />
          <Text style={styles.addText}>Label</Text>
        </Pressable>
        {aiAvailable ? (
          <Pressable style={styles.addBtn} onPress={() => void suggest()} disabled={suggesting}>
            {suggesting ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Feather name="zap" size={12} color={colors.accent} />
            )}
            <Text style={[styles.addText, { color: colors.accent }]}>Suggest</Text>
          </Pressable>
        ) : null}
        {suggestions.map((s) => (
          <Pressable
            key={s.name}
            style={[styles.chip, styles.suggestion, { borderColor: s.color ?? colors.accent }]}
            onPress={() => void accept(s)}
          >
            <Feather name="plus" size={11} color={colors.inkSoft} />
            <Text style={styles.chipText}>{s.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setSheetOpen(false)} />
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Labels</Text>
          <TextInput
            style={styles.input}
            value={query}
            placeholder="Filter or create…"
            placeholderTextColor={colors.inkSoft}
            onChangeText={setQuery}
            onSubmitEditing={() => {
              if (q && !exactExists) void createFromQuery();
            }}
          />
          <ScrollView style={styles.list}>
            {filtered.map((l) => {
              const on = labels.some((x) => x.id === l.id);
              return (
                <Pressable key={l.id} style={styles.item} onPress={() => toggle(l)}>
                  <View style={[styles.dot, { backgroundColor: l.color }]} />
                  <Text style={[styles.itemText, on && styles.itemOn]}>{l.name}</Text>
                  {on ? <Feather name="check" size={15} color={colors.accent} /> : null}
                </Pressable>
              );
            })}
            {q && !exactExists ? (
              <Pressable style={styles.item} onPress={() => void createFromQuery()}>
                <Feather name="plus" size={14} color={colors.accent} />
                <Text style={[styles.itemText, { color: colors.accent }]}>
                  Create “{query.trim()}”
                </Text>
              </Pressable>
            ) : null}
            {filtered.length === 0 && !q ? (
              <Text style={styles.empty}>No labels yet — type to create one.</Text>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    wrap: { paddingVertical: 2 },
    row: {
      alignItems: "center",
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: 1,
    },
    suggestion: { borderStyle: "dashed", backgroundColor: "transparent" },
    dot: { width: 7, height: 7, borderRadius: 4 },
    chipText: { fontSize: 12, color: colors.ink },
    addBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.hairline,
    },
    addText: { fontSize: 12, color: colors.inkSoft },
    scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      padding: spacing.md,
      maxHeight: "70%",
    },
    sheetTitle: { fontSize: 16, fontWeight: "600", color: colors.ink, marginBottom: spacing.sm },
    input: {
      borderWidth: 1,
      borderColor: colors.hairline,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: colors.ink,
      fontSize: 14,
    },
    list: { marginTop: spacing.sm },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 4,
    },
    itemText: { flex: 1, fontSize: 14, color: colors.ink },
    itemOn: { fontWeight: "600" },
    empty: { color: colors.inkSoft, fontSize: 13, padding: spacing.sm },
  });
