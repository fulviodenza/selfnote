/**
 * The shelf: books, the goals card, and book management.
 *
 * Importing copies the file into app storage rather than holding the picker's
 * URL, because a security-scoped URL does not survive a restart and the book
 * would silently stop opening.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  addBook,
  bookUri,
  booksFinishedSince,
  deleteBookRow,
  docUri,
  getNumberSetting,
  listNotePages,
  readingSecondsSince,
  setFinished,
  setNumberSetting,
  type Book,
} from "./db";
import type { Connection } from "./selfnote";
import { fonts, radius, scrim, shadow, spacing, type Palette, type TypeRoles } from "./theme";
import { useTheme } from "./theme-context";

const DAILY_KEY = "goal.daily_minutes";
const YEARLY_KEY = "goal.yearly_books";

function localMidnight(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function yearStart(): number {
  const d = new Date();
  return new Date(d.getFullYear(), 0, 1).getTime();
}

export function Library({
  books,
  connection,
  onOpen,
  onConnect,
  onChanged,
}: {
  books: Book[];
  connection: Connection | null;
  onOpen: (b: Book) => void;
  onConnect: () => void;
  onChanged: () => void;
}) {
  const [todayMin, setTodayMin] = useState(0);
  const [finishedThisYear, setFinishedThisYear] = useState(0);
  const [dailyGoal, setDailyGoal] = useState(30);
  const [yearlyGoal, setYearlyGoal] = useState(12);
  const [editingGoals, setEditingGoals] = useState(false);
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);

  const refreshGoals = useCallback(() => {
    void readingSecondsSince(localMidnight()).then((s) => setTodayMin(Math.round(s / 60)));
    void booksFinishedSince(yearStart()).then(setFinishedThisYear);
    void getNumberSetting(DAILY_KEY, 30).then(setDailyGoal);
    void getNumberSetting(YEARLY_KEY, 12).then(setYearlyGoal);
  }, []);
  useEffect(refreshGoals, [refreshGoals, books]);

  const importBook = useCallback(async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["application/epub+zip", "application/pdf", "application/zip", "*/*"],
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0];

    const dir = `${FileSystem.documentDirectory}books/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ext = asset.name?.toLowerCase().endsWith(".pdf") ? "pdf" : "epub";
    const relative = `books/${id}.${ext}`;
    await FileSystem.copyAsync({ from: asset.uri, to: `${FileSystem.documentDirectory}${relative}` });

    await addBook({
      id,
      // The reader reports real metadata once the book opens and the row is
      // updated then; the filename is the stand-in people recognise meanwhile.
      title: asset.name?.replace(/\.(epub|pdf)$/i, "") ?? "Untitled",
      author: null,
      // Relative on purpose; see the note on Book.file_path.
      file_path: relative,
      added_at: Date.now(),
      locations: null,
      sync_document_id: null,
      sync_page_title: null,
      finished_at: null,
      last_opened_at: null,
    });
    onChanged();
  }, [onChanged]);

  const confirmDelete = useCallback(
    (book: Book) => {
      Alert.alert(`Delete "${book.title}"?`, "The book, its highlights and reading history on this device are removed. Highlights already sent to Selfnote stay there.", [
        { text: "Keep", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            // File first: if this throws, the row survives and the book still
            // opens, which beats a ghost row pointing at nothing.
            await FileSystem.deleteAsync(bookUri(book), { idempotent: true }).catch(() => {});
            // Copied images live in a folder per insert. The rows go with the
            // book; the folders would not, so they go first.
            const pages = await listNotePages(book.id).catch(() => []);
            for (const p of pages) {
              try {
                await FileSystem.deleteAsync(docUri(`notes/${p.id}`), { idempotent: true });
              } catch {
                /* an orphaned image costs disk, not correctness */
              }
            }
            await deleteBookRow(book.id);
            onChanged();
          },
        },
      ]);
    },
    [onChanged],
  );

  const manage = useCallback(
    (book: Book) => {
      Alert.alert(book.title, book.author ?? undefined, [
        { text: "Open", onPress: () => onOpen(book) },
        {
          text: book.finished_at ? "Mark as not finished" : "Mark as finished",
          onPress: async () => {
            await setFinished(book.id, !book.finished_at);
            onChanged();
          },
        },
        { text: "Delete…", style: "destructive", onPress: () => confirmDelete(book) },
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [confirmDelete, onChanged, onOpen],
  );

  const lastOpened = books.find((b) => b.last_opened_at != null) ?? null;
  const dailyDone = dailyGoal > 0 && todayMin >= dailyGoal;

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.wordmark}>selfnote</Text>
            <Text style={styles.sub}>reader</Text>
          </View>
          <TouchableOpacity onPress={onConnect} hitSlop={12}>
            <Text style={styles.link}>{connection ? "Connected" : "Connect"}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={books}
        keyExtractor={(b) => b.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <TouchableOpacity style={styles.goals} onPress={() => setEditingGoals(true)}>
            <View style={styles.goalsRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.goalsTitle}>Today's reading</Text>
                <Text style={styles.goalsBig}>
                  {todayMin}
                  <Text style={styles.goalsUnit}> of {dailyGoal} min</Text>
                  {dailyDone ? <Text style={styles.goalsDone}>  done</Text> : null}
                </Text>
                <View style={styles.goalsBarTrack}>
                  <View
                    style={[
                      styles.goalsBarFill,
                      { width: `${Math.min(100, (todayMin / Math.max(1, dailyGoal)) * 100)}%` },
                    ]}
                  />
                </View>
                <Text style={styles.goalsYear}>
                  {finishedThisYear} of {yearlyGoal} books this year
                </Text>
              </View>
            </View>
            {lastOpened ? (
              <TouchableOpacity style={styles.continueBtn} onPress={() => onOpen(lastOpened)}>
                <Text style={styles.continueText} numberOfLines={1}>
                  Continue reading: {lastOpened.title}
                </Text>
              </TouchableOpacity>
            ) : null}
          </TouchableOpacity>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            No books yet. Add an EPUB to start reading. Everything stays on this device.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => onOpen(item)}
            onLongPress={() => manage(item)}
            delayLongPress={350}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={2}>
                {item.title}
              </Text>
              {item.author ? <Text style={styles.rowMeta}>{item.author}</Text> : null}
              {item.sync_page_title ? (
                <Text style={styles.rowSync}>Highlights to "{item.sync_page_title}"</Text>
              ) : null}
            </View>
            {item.finished_at ? <Text style={styles.finished}>Finished</Text> : null}
          </TouchableOpacity>
        )}
      />

      <TouchableOpacity style={styles.add} onPress={importBook}>
        <Text style={styles.addText}>Add an EPUB</Text>
      </TouchableOpacity>

      {editingGoals ? (
        <GoalsEditor
          daily={dailyGoal}
          yearly={yearlyGoal}
          onClose={async (d, y) => {
            await setNumberSetting(DAILY_KEY, d);
            await setNumberSetting(YEARLY_KEY, y);
            setEditingGoals(false);
            refreshGoals();
          }}
        />
      ) : null}
    </View>
  );
}

/** Two steppers and a Done. Deliberately not a settings labyrinth. */
function GoalsEditor({
  daily,
  yearly,
  onClose,
}: {
  daily: number;
  yearly: number;
  onClose: (daily: number, yearly: number) => void;
}) {
  const [d, setD] = useState(daily);
  const [y, setY] = useState(yearly);
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const Stepper = ({
    label,
    value,
    step,
    min,
    onChange,
  }: {
    label: string;
    value: number;
    step: number;
    min: number;
    onChange: (n: number) => void;
  }) => (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepper}>
        <TouchableOpacity hitSlop={10} onPress={() => onChange(Math.max(min, value - step))}>
          <Text style={styles.stepBtn}>-</Text>
        </TouchableOpacity>
        <Text style={styles.stepValue}>{value}</Text>
        <TouchableOpacity hitSlop={10} onPress={() => onChange(value + step)}>
          <Text style={styles.stepBtn}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
  return (
    <View style={styles.sheetBackdrop}>
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>Reading goals</Text>
        <Stepper label="Minutes per day" value={d} step={5} min={5} onChange={setD} />
        <Stepper label="Books per year" value={y} step={1} min={1} onChange={setY} />
        <TouchableOpacity style={styles.sheetDone} onPress={() => onClose(d, y)}>
          <Text style={styles.sheetDoneText}>Done</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.paper },
    header: { paddingHorizontal: 28, paddingTop: 72, paddingBottom: spacing.xl },
    headerRow: { flexDirection: "row", alignItems: "flex-start" },
    wordmark: { ...type.title },
    sub: { fontSize: 17, color: colors.inkSoft, marginTop: 2 },
    link: { ...type.button, color: colors.accent, paddingTop: spacing.sm },
    list: { paddingHorizontal: spacing.gutter, paddingBottom: 120 },
    goals: {
      padding: 18,
      marginBottom: 14,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.hairline,
    },
    goalsRow: { flexDirection: "row", alignItems: "center" },
    goalsTitle: { ...type.label },
    goalsBig: { fontSize: 30, fontWeight: "600", color: colors.ink, marginTop: spacing.xs },
    goalsUnit: { fontSize: 16, fontWeight: "500", color: colors.inkSoft },
    goalsDone: { fontSize: 15, fontWeight: "600", color: colors.inkSoft },
    goalsBarTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.hairline,
      marginTop: 10,
      overflow: "hidden",
    },
    goalsBarFill: { height: 4, borderRadius: 2, backgroundColor: colors.accent },
    goalsYear: { fontSize: 14, color: colors.inkSoft, marginTop: 10 },
    continueBtn: {
      marginTop: 14,
      paddingVertical: 11,
      paddingHorizontal: 14,
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceSunken,
    },
    continueText: { fontSize: 14, fontWeight: "600", color: colors.accent },
    empty: {
      ...type.body,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.lg,
      color: colors.inkSoft,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 18,
      paddingHorizontal: spacing.xl,
      marginBottom: 10,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.hairline,
    },
    rowTitle: {
      fontFamily: fonts.serif,
      fontSize: 18,
      lineHeight: 24,
      fontWeight: "600",
      color: colors.ink,
    },
    rowMeta: { fontSize: 14, color: colors.inkSoft, marginTop: spacing.xs },
    rowSync: { fontSize: 13, color: colors.accent, marginTop: 6 },
    finished: { ...type.meta, fontWeight: "500" },
    add: {
      position: "absolute",
      left: spacing.gutter,
      right: spacing.gutter,
      bottom: 40,
      height: 52,
      borderRadius: radius.md,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
      ...shadow.floating,
    },
    addText: { ...type.button, color: colors.onAccent },
    sheetBackdrop: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: scrim,
      alignItems: "center",
      justifyContent: "center",
    },
    sheet: {
      width: 420,
      maxWidth: "88%",
      borderRadius: radius.lg,
      backgroundColor: colors.surface,
      padding: spacing.xxl,
      ...shadow.floating,
    },
    sheetTitle: {
      fontFamily: fonts.serif,
      fontSize: 22,
      lineHeight: 28,
      fontWeight: "600",
      color: colors.ink,
      marginBottom: 14,
    },
    stepperRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: spacing.md,
    },
    stepperLabel: { ...type.body },
    stepper: { flexDirection: "row", alignItems: "center", gap: 18 },
    stepBtn: { fontSize: 26, fontWeight: "600", color: colors.accent, width: 30, textAlign: "center" },
    stepValue: { fontSize: 18, fontWeight: "600", color: colors.ink, minWidth: 44, textAlign: "center" },
    sheetDone: {
      marginTop: 18,
      height: 52,
      borderRadius: radius.md,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    sheetDoneText: { ...type.button, color: colors.onAccent },
  });
