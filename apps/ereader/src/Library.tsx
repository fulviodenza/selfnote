/**
 * The shelf: books, the goals card, and book management.
 *
 * Importing copies the file into app storage rather than holding the picker's
 * URL, because a security-scoped URL does not survive a restart and the book
 * would silently stop opening.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  addBook,
  bookUri,
  booksFinishedSince,
  deleteBookRow,
  getNumberSetting,
  readingSecondsSince,
  setFinished,
  setNumberSetting,
  type Book,
} from "./db";
import type { Connection } from "./selfnote";

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

  const refreshGoals = useCallback(() => {
    void readingSecondsSince(localMidnight()).then((s) => setTodayMin(Math.round(s / 60)));
    void booksFinishedSince(yearStart()).then(setFinishedThisYear);
    void getNumberSetting(DAILY_KEY, 30).then(setDailyGoal);
    void getNumberSetting(YEARLY_KEY, 12).then(setYearlyGoal);
  }, []);
  useEffect(refreshGoals, [refreshGoals, books]);

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
      // The reader reports real metadata once the book opens and the row is
      // updated then; the filename is the stand-in people recognise meanwhile.
      title: asset.name?.replace(/\.epub$/i, "") ?? "Untitled",
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
            {item.finished_at ? <Text style={styles.finished}>finished</Text> : null}
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

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#faf5ef" },
  header: { paddingHorizontal: 28, paddingTop: 72, paddingBottom: 20 },
  headerRow: { flexDirection: "row", alignItems: "flex-start" },
  wordmark: { fontSize: 34, fontWeight: "700", color: "#1b1b1b", letterSpacing: -0.5 },
  sub: { fontSize: 17, color: "#6b6b6b", marginTop: 2 },
  link: { fontSize: 16, color: "#3730c4", fontWeight: "600", paddingTop: 8 },
  list: { paddingHorizontal: 20, paddingBottom: 120 },
  goals: {
    padding: 18,
    marginBottom: 14,
    borderRadius: 14,
    backgroundColor: "#fffdfa",
    borderWidth: 1,
    borderColor: "#eae2d6",
  },
  goalsRow: { flexDirection: "row", alignItems: "center" },
  goalsTitle: { fontSize: 13, fontWeight: "700", color: "#6b6b6b", textTransform: "uppercase" },
  goalsBig: { fontSize: 30, fontWeight: "700", color: "#1b1b1b", marginTop: 4 },
  goalsUnit: { fontSize: 16, fontWeight: "500", color: "#6b6b6b" },
  goalsDone: { fontSize: 15, fontWeight: "700", color: "#447a4e" },
  goalsBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#f0e8db",
    marginTop: 10,
    overflow: "hidden",
  },
  goalsBarFill: { height: 6, borderRadius: 3, backgroundColor: "#f2c94c" },
  goalsYear: { fontSize: 14, color: "#6b6b6b", marginTop: 10 },
  continueBtn: {
    marginTop: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "#f2ece3",
  },
  continueText: { fontSize: 14, fontWeight: "600", color: "#3730c4" },
  empty: { paddingHorizontal: 8, paddingTop: 16, fontSize: 16, lineHeight: 24, color: "#6b6b6b" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
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
  rowSync: { fontSize: 13, color: "#3730c4", marginTop: 6 },
  finished: { fontSize: 12, fontWeight: "700", color: "#447a4e" },
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
  sheetBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(27,27,27,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  sheet: {
    width: 420,
    maxWidth: "88%",
    borderRadius: 18,
    backgroundColor: "#faf5ef",
    padding: 24,
  },
  sheetTitle: { fontSize: 20, fontWeight: "700", color: "#1b1b1b", marginBottom: 14 },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  stepperLabel: { fontSize: 16, color: "#1b1b1b" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 18 },
  stepBtn: { fontSize: 26, fontWeight: "600", color: "#3730c4", width: 30, textAlign: "center" },
  stepValue: { fontSize: 18, fontWeight: "700", color: "#1b1b1b", minWidth: 44, textAlign: "center" },
  sheetDone: {
    marginTop: 18,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#3730c4",
    alignItems: "center",
  },
  sheetDoneText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
