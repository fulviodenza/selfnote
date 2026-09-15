/**
 * LabelRow (mobile) — the note's labels as colored chips above the editor, with
 * an add/remove sheet over the workspace vocabulary and an AI "Suggest" flow.
 * Mobile parity for web's LabelBar (apps/web/src/LabelBar.tsx): suggestions are
 * only persisted when the user accepts them.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { api, type BulkLabelStatus, type Label, type LabelSuggestion } from "../api";
import { hitSlop, spacing } from "../theme";
import { useTheme } from "../theme-context";

/** The server's default palette, offered as swatches when editing a label. */
export const LABEL_COLORS = [
  "#2B44C7", "#1F9E6A", "#C1841E", "#8B5CF6", "#C4392B", "#0E7490", "#B4468A", "#5B6472",
];

/**
 * Entry point for the bulk "label everything" job (mobile parity for web's
 * BulkLabelButton) — shown on the document list; polls progress while running.
 */
export function BulkLabelButton({
  workspaceId,
  onError,
}: {
  workspaceId: string;
  onError?: (message: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [status, setStatus] = useState<BulkLabelStatus | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api.bulkLabelStatus(workspaceId);
        if (!alive) return;
        setStatus(s);
        if (s.running) timer = setTimeout(tick, 2000);
      } catch {
        /* older server / offline — leave idle */
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [workspaceId, status?.running]);

  const start = async () => {
    try {
      setStatus(await api.bulkLabelStart(workspaceId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      onError?.(
        /no ai provider/i.test(msg)
          ? "No AI provider configured."
          : /already running/i.test(msg)
            ? "Bulk labeling is already running."
            : "Couldn't start bulk labeling.",
      );
    }
  };

  const label = status?.running
    ? `Labeling ${status.done}/${status.total}…`
    : status && status.total > 0 && status.done === status.total
      ? `Labeled ${status.labeled} notes`
      : "Label all notes with AI";

  return (
    <Pressable
      style={styles.bulkBtn}
      onPress={() => void start()}
      disabled={status?.running ?? false}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {status?.running ? (
        <ActivityIndicator size="small" color={colors.accent} />
      ) : (
        <Feather name="zap" size={13} color={colors.accent} />
      )}
      <Text style={styles.bulkText}>{label}</Text>
    </Pressable>
  );
}

export function LabelRow({
  docId,
  workspaceId,
  aiAvailable,
  getText,
  trailing,
  onError,
}: {
  docId: string;
  workspaceId: string;
  aiAvailable: boolean;
  /** The note's current text/Markdown (for the AI suggester). */
  getText: () => Promise<string>;
  /**
   * Extra page-metadata affordances at the end of the row (today, the "Make
   * task" chip). Inside the scroll view on purpose, so it scrolls with the
   * chips instead of pinning itself over them.
   */
  trailing?: ReactNode;
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
  // Manage mode: the label being renamed/recolored/deleted in the sheet.
  const [editing, setEditing] = useState<Label | null>(null);

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

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const updated = await api.updateLabel(editing.id, {
        name: editing.name.trim(),
        color: editing.color,
      });
      setAll((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setLabels((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setEditing(null);
    } catch {
      onError?.("Couldn't update the label.");
    }
  };

  /** Delete the label from the workspace, detaching it from every note. */
  const removeLabel = async () => {
    if (!editing) return;
    try {
      await api.deleteLabel(editing.id);
      setAll((prev) => prev.filter((l) => l.id !== editing.id));
      setLabels((prev) => prev.filter((l) => l.id !== editing.id));
      setEditing(null);
    } catch {
      onError?.("Couldn't delete the label.");
    }
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setEditing(null);
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
          <View
            key={l.id}
            style={[styles.chip, { borderColor: l.color, backgroundColor: `${l.color}20` }]}
          >
            <View style={[styles.dot, { backgroundColor: l.color }]} />
            <Text style={styles.chipText}>{l.name}</Text>
            <Pressable
              onPress={() => toggle(l)}
              hitSlop={hitSlop(12)}
              accessibilityRole="button"
              accessibilityLabel={`Remove label ${l.name}`}
            >
              <Feather name="x" size={12} color={colors.inkSoft} />
            </Pressable>
          </View>
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
        {trailing}
      </ScrollView>

      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={closeSheet}>
        <Pressable style={styles.scrim} onPress={closeSheet} />
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
          {editing ? (
            <View style={styles.edit}>
              <TextInput
                style={styles.input}
                value={editing.name}
                placeholder="Label name"
                placeholderTextColor={colors.inkSoft}
                onChangeText={(name) => setEditing({ ...editing, name })}
                onSubmitEditing={() => void saveEdit()}
              />
              <View style={styles.swatches}>
                {LABEL_COLORS.map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setEditing({ ...editing, color: c })}
                    style={[
                      styles.swatch,
                      { backgroundColor: c },
                      editing.color === c && { borderColor: colors.ink },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Color ${c}`}
                    accessibilityState={{ selected: editing.color === c }}
                  />
                ))}
              </View>
              <View style={styles.editActions}>
                <Pressable
                  onPress={() => void removeLabel()}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete label ${editing.name}`}
                >
                  <Text style={styles.editDelete}>Delete</Text>
                </Pressable>
                <Pressable onPress={() => setEditing(null)} accessibilityRole="button">
                  <Text style={styles.editAction}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void saveEdit()}
                  accessibilityRole="button"
                  accessibilityLabel="Save label"
                >
                  <Text style={[styles.editAction, { color: colors.accent }]}>Save</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          <ScrollView style={styles.list}>
            {!editing &&
              filtered.map((l) => {
                const on = labels.some((x) => x.id === l.id);
                return (
                  <View key={l.id} style={styles.item}>
                    <Pressable
                      style={styles.itemMain}
                      onPress={() => toggle(l)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`Label ${l.name}`}
                    >
                      <View style={[styles.dot, { backgroundColor: l.color }]} />
                      <Text style={[styles.itemText, on && styles.itemOn]}>{l.name}</Text>
                      {on ? <Feather name="check" size={15} color={colors.accent} /> : null}
                    </Pressable>
                    <Pressable
                      onPress={() => setEditing(l)}
                      hitSlop={hitSlop(16)}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit label ${l.name}`}
                    >
                      <Feather name="edit-3" size={15} color={colors.inkSoft} />
                    </Pressable>
                  </View>
                );
              })}
            {!editing && q && !exactExists ? (
              <Pressable style={styles.item} onPress={() => void createFromQuery()}>
                <Feather name="plus" size={14} color={colors.accent} />
                <Text style={[styles.itemText, { color: colors.accent }]}>
                  Create “{query.trim()}”
                </Text>
              </Pressable>
            ) : null}
            {!editing && filtered.length === 0 && !q ? (
              <Text style={styles.empty}>No labels yet. Type to create one.</Text>
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
      // The editor body's gutter, so the chips line up with the page text and
      // with the task row rather than sitting 8px to their left.
      paddingHorizontal: spacing.gutter,
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
    itemMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
    itemText: { flex: 1, fontSize: 14, color: colors.ink },
    edit: { gap: spacing.sm, marginTop: spacing.sm },
    swatches: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: "transparent" },
    editActions: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
    editDelete: { fontSize: 14, fontWeight: "600", color: colors.danger, marginRight: "auto" },
    editAction: { fontSize: 14, fontWeight: "600", color: colors.inkSoft },
    itemOn: { fontWeight: "600" },
    empty: { color: colors.inkSoft, fontSize: 13, padding: spacing.sm },
    bulkBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.hairline,
      marginHorizontal: spacing.md,
      marginBottom: spacing.xs,
    },
    bulkText: { fontSize: 12, color: colors.accent },
  });
