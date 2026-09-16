import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  activeUsedLabels,
  computeMove,
  createDocConnection,
  descendantIds,
  type ConnectionStatus,
} from "@selfnote/core";
import { sqlitePersistence, loadCachedState, wipeLocalCache } from "./src/persistence/sqlite";
import { WebViewEditor, type EditorUser, type EditorHandle } from "./src/editor/WebViewEditor";
import { BacklinksPanel } from "./src/editor/BacklinksPanel";
import { GraphView } from "./src/editor/GraphView";
import { AssistDrawer } from "./src/editor/AssistDrawer";
import { NoteAiActions } from "./src/editor/NoteAiActions";
import { AiDiffScreen } from "./src/editor/AiDiffScreen";
import { ShareAnalyticsSheet } from "./src/editor/ShareAnalyticsSheet";
import { HistoryScreen } from "./src/components/history/HistoryScreen";
import { HistoryPreviewScreen } from "./src/components/history/HistoryPreviewScreen";
import {
  api,
  ensureWorkspace,
  isAuthed,
  loadSession,
  type AiProposal,
  type Checkpoint,
  type Document,
  type AiStatus,
  type Label,
  type SearchResults,
  type Task,
} from "./src/api";
import {
  getSettings,
  loadSettings,
  saveSettings,
  deriveFromBase,
  isConfigured,
  defaults,
  type ServerSettings,
} from "./src/settings";
import { colors as lightPalette, hitSlop, radius, shadow, sizing, spacing } from "./src/theme";
import type { Palette, TypeRoles } from "./src/theme";
import {
  Button,
  IconButton,
  Input,
  Row,
  Screen,
  Sheet,
  StatusDot,
  ToastProvider,
  useToast,
  ErrorBoundary,
} from "./src/ui";
import { ThemeProvider, useTheme, type ThemeMode } from "./src/theme-context";
import { useAndroidBack } from "./src/hooks/useAndroidBack";
import { MakeTaskButton, TaskControls } from "./src/screens/TaskControls";
import { BulkLabelButton, LabelRow } from "./src/components/LabelRow";
import { PresenceChips } from "./src/components/PresenceChips";
import { TabCountButton, TabSwitcherScreen } from "./src/components/TabSwitcherScreen";
import { TasksScreen } from "./src/screens/TasksScreen";
import { AssetsScreen } from "./src/screens/AssetsScreen";
import { ShelfScreen, type Shelf } from "./src/screens/ShelfScreen";
import { CalendarFeedSection } from "./src/screens/CalendarFeedSection";
import { VoiceSection } from "./src/screens/VoiceSection";

const COLLAPSED_KEY = "selfnote.collapsed";
const TABS_KEY = "selfnote.tabs";

const USER: EditorUser = {
  name: `Mobile ${Math.floor(Math.random() * 90 + 10)}`,
  color: lightPalette.accent, // awareness cursor color — a fixed brand hue is fine
};

type Phase = "booting" | "onboarding" | "auth" | "app";

/** The System shelves, mirroring the web sidebar's "System" group. */
type SystemView = "assets" | Shelf;

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <AppInner />
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function AppInner() {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("booting");
  // Load the Feather icon font before rendering any UI. In release builds the
  // lazy per-glyph load @expo/vector-icons does on its own can silently fail,
  // leaving every icon blank — the font is also embedded natively via the
  // expo-font config plugin (app.json), so this normally resolves instantly.
  const [fontsLoaded, fontError] = useFonts(Feather.font);
  const [showSettings, setShowSettings] = useState(false);
  // Browser-style page tabs: the ordered ids of the open pages plus the one
  // filling the screen. The ids are persisted so the open set survives a
  // restart; the Documents behind them come from whichever screen last listed
  // the workspace, which is what keeps a tab's title current after a rename.
  // The set is surfaced by TabSwitcherScreen, a full-screen grid of cards
  // (Chrome's model) reached from the count button in the editor topbar.
  const [tabIds, setTabIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showTabs, setShowTabs] = useState(false);
  const [docsById, setDocsById] = useState<Map<string, Document>>(new Map());
  // The signed-in workspace (single-workspace model), lifted so the Tasks screen
  // and the calendar-feed settings section can share it.
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  // System shelves (web sidebar's "System" group): the workspace's uploaded
  // files, plus the archived and trashed pages. null = the page tree.
  const [systemView, setSystemView] = useState<SystemView | null>(null);

  // Restore the open set once on launch, then keep it written back. The write
  // waits for the read so the initial empty state can't erase it.
  const tabsHydrated = useRef(false);
  useEffect(() => {
    AsyncStorage.getItem(TABS_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const stored = JSON.parse(raw) as string[];
          // Merge rather than replace: a page opened while this read was in
          // flight is already in state and must stay open.
          setTabIds((cur) => [...stored.filter((id) => !cur.includes(id)), ...cur]);
        } catch {
          /* ignore malformed */
        }
      })
      .finally(() => {
        tabsHydrated.current = true;
      });
  }, []);
  useEffect(() => {
    if (!tabsHydrated.current) return;
    AsyncStorage.setItem(TABS_KEY, JSON.stringify(tabIds)).catch(() => undefined);
  }, [tabIds]);

  /*
   * Where activeId should land once the switcher closes. `undefined` means
   * nothing is pending.
   *
   * Re-pointing activeId while the switcher is open would remount EditorScreen
   * under the overlay (its key is the doc id), spinning up a WebView, a Yjs
   * provider and a socket for a page nobody is looking at, once per close.
   * Closing five tabs in one visit would build and tear down five editors,
   * which is exactly the cost the overlay exists to avoid.
   */
  const deferredActive = useRef<string | null | undefined>(undefined);

  /** Show a page: it joins the tab strip if it isn't already open. */
  const openPage = useCallback((doc: Document) => {
    setDocsById((cur) => (cur.get(doc.id) === doc ? cur : new Map(cur).set(doc.id, doc)));
    setTabIds((cur) => (cur.includes(doc.id) ? cur : [...cur, doc.id]));
    setShowTasks(false);
    setShowGraph(false);
    setSystemView(null);
    setShowTabs(false);
    deferredActive.current = undefined;
    setActiveId(doc.id);
  }, []);

  /**
   * Closing the active tab shows its right neighbour, or the last one left.
   * `defer` holds that move until the switcher is dismissed.
   */
  const closeTab = useCallback((id: string, defer = false) => {
    setTabIds((cur) => {
      const idx = cur.indexOf(id);
      if (idx === -1) return cur;
      const next = cur.filter((t) => t !== id);
      setActiveId((active) => {
        if (active !== id) return active;
        const replacement = next[Math.min(idx, next.length - 1)] ?? null;
        if (!defer) return replacement;
        deferredActive.current = replacement;
        return active; // still mounted, but hidden behind the switcher
      });
      return next;
    });
  }, []);

  /** Leave the switcher, applying whichever tab the closes settled on. */
  const dismissTabs = useCallback(() => {
    setShowTabs(false);
    if (deferredActive.current !== undefined) {
      setActiveId(deferredActive.current);
      deferredActive.current = undefined;
    }
  }, []);

  /**
   * The page list just loaded. Re-point the tabs at the fresh Documents so a
   * rename reaches the strip, and drop any tab whose page has left the active
   * shelf (archived, trashed, or deleted from another device).
   */
  const syncDocs = useCallback((list: Document[]) => {
    const byId = new Map(list.map((d) => [d.id, d]));
    setDocsById(byId);
    setTabIds((cur) => {
      const next = cur.filter((id) => byId.has(id));
      return next.length === cur.length ? cur : next;
    });
    setActiveId((active) => (active && byId.has(active) ? active : null));
  }, []);

  const clearTabs = useCallback(() => {
    setTabIds([]);
    deferredActive.current = undefined;
    setActiveId(null);
    setDocsById(new Map());
  }, []);

  // Open a note from the Tasks screen (which only knows the doc id): fetch the
  // workspace's documents and open the matching one.
  const openDocById = useCallback(
    async (docId: string) => {
      try {
        const ws = workspaceId ?? (await ensureWorkspace());
        const docs = await api.listDocuments(ws);
        const doc = docs.find((d) => d.id === docId);
        if (doc) openPage(doc);
        else toast("That note is no longer available.");
      } catch {
        toast("Couldn't open the note.");
      }
    },
    [workspaceId, toast, openPage],
  );

  /** The "+" in the tab switcher: a new root page, opened in its own tab. */
  const createPage = useCallback(async () => {
    if (!workspaceId) return;
    try {
      openPage(await api.createDocument(workspaceId, null, "Untitled"));
    } catch {
      toast("Couldn't create the page.");
    }
  }, [workspaceId, openPage, toast]);

  const tabs = useMemo(
    () => tabIds.map((id) => docsById.get(id)).filter((d): d is Document => !!d),
    [tabIds, docsById],
  );
  const openDoc = activeId ? docsById.get(activeId) ?? null : null;

  /*
   * Keep `showTabs` honest. Tabs can empty from several directions: closing the
   * last card, "close all", or syncDocs dropping pages that left the active
   * shelf. Deriving the dismissal from the rendered tab list covers all of them,
   * where comparing raw `tabIds` would miss the case of an id with no Document
   * yet and leave the flag set, swallowing the next back press and popping the
   * switcher open again once the ids resolved.
   */
  useEffect(() => {
    if (tabs.length === 0) dismissTabs();
  }, [tabs.length, dismissTabs]);

  const goPostConfig = useCallback(async () => {
    await loadSession();
    const restored = isAuthed() ? await api.restore() : false;
    setPhase(restored ? "app" : "auth");
  }, []);

  useEffect(() => {
    (async () => {
      await loadSettings();
      // No server configured yet → first-launch onboarding to pick the instance.
      if (!isConfigured()) {
        setPhase("onboarding");
        return;
      }
      await goPostConfig();
    })();
  }, [goPostConfig]);

  // Android back: close the topmost thing, one level at a time. The editor
  // registers its own handler for its overlays (RN runs handlers LIFO, so the
  // editor gets first refusal); returning false at the root lets the OS
  // background the app.
  useAndroidBack(
    useCallback(() => {
      if (showSettings) {
        setShowSettings(false);
        return true;
      }
      // The switcher sits above the editor, so it takes back first.
      if (showTabs) {
        dismissTabs();
        return true;
      }
      if (openDoc) {
        setActiveId(null);
        return true;
      }
      if (showGraph) {
        setShowGraph(false);
        return true;
      }
      if (showTasks) {
        setShowTasks(false);
        return true;
      }
      if (systemView) {
        setSystemView(null);
        return true;
      }
      return false;
    }, [showSettings, showTabs, dismissTabs, openDoc, showGraph, showTasks, systemView]),
  );

  // Hold at the boot spinner until the icon font is ready — but never brick
  // the app if the load errors; icons degrade to blanks in that case.
  if (!fontsLoaded && !fontError) {
    return (
      <Screen>
        <StatusBar style="auto" />
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <StatusBar style="auto" />
      {phase === "booting" && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}

        {phase === "onboarding" && <OnboardingScreen onConnected={goPostConfig} />}

        {phase === "auth" && (
          <AuthScreen onAuthed={() => setPhase("app")} onSettings={() => setShowSettings(true)} />
        )}

        {phase === "app" &&
          (openDoc ? (
            <EditorScreen
              key={openDoc.id}
              doc={openDoc}
              tabCount={tabs.length}
              onShowTabs={() => setShowTabs(true)}
              onBack={() => setActiveId(null)}
              onNavigateToDoc={openDocById}
            />
          ) : showGraph && workspaceId ? (
            <GraphView
              workspaceId={workspaceId}
              onBack={() => setShowGraph(false)}
              onOpenDoc={openDocById}
            />
          ) : showTasks && workspaceId ? (
            <TasksScreen
              workspaceId={workspaceId}
              onBack={() => setShowTasks(false)}
              onOpenTask={openDocById}
            />
          ) : systemView === "assets" && workspaceId ? (
            <AssetsScreen
              workspaceId={workspaceId}
              onBack={() => setSystemView(null)}
              onOpenPage={openDocById}
            />
          ) : systemView && systemView !== "assets" && workspaceId ? (
            <ShelfScreen
              key={systemView}
              shelf={systemView}
              workspaceId={workspaceId}
              onBack={() => setSystemView(null)}
            />
          ) : (
            <DocListScreen
              onOpen={openPage}
              onDocs={syncDocs}
              onWorkspace={setWorkspaceId}
              onTasks={() => setShowTasks(true)}
              onGraph={() => setShowGraph(true)}
              onSystem={setSystemView}
              onSettings={() => setShowSettings(true)}
              onLogout={async () => {
                await api.logout();
                clearTabs();
                setPhase("auth");
              }}
            />
          ))}

      {/*
        An overlay, not a sibling branch of the editor. Rendering it as a branch
        unmounted EditorScreen, tearing down the WebView, the Yjs provider and
        the socket on every visit, so glancing at the tabs and dismissing cost a
        full reload: spinner, resync, lost scroll position and undo history.
      */}
      {phase === "app" && showTabs && tabs.length > 0 && (
        <View style={styles.overlay}>
          <TabSwitcherScreen
            tabs={tabs}
            activeId={activeId}
            onSelect={openPage}
            onClose={(id) => closeTab(id, true)}
            onCloseAll={() => {
              clearTabs();
              setShowTabs(false);
            }}
            onNew={() => void createPage()}
            onDismiss={dismissTabs}
          />
        </View>
      )}

      {showSettings && (
        <SettingsScreen
          workspaceId={phase === "app" ? workspaceId : null}
          onClose={() => setShowSettings(false)}
          onWiped={() => {
            setShowSettings(false);
            clearTabs();
            setWorkspaceId(null);
            setShowTasks(false);
            setShowGraph(false);
            setSystemView(null);
            setPhase("auth");
          }}
        />
      )}
    </Screen>
  );
}

/* ------------------------------------------------------------------ Auth --- */

function OnboardingScreen({ onConnected }: { onConnected: () => void }) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    const derived = deriveFromBase(url);
    try {
      const res = await fetch(`${derived.apiUrl}/healthz`, { method: "GET" });
      if (!res.ok) throw new Error(String(res.status));
      await saveSettings(derived);
      onConnected();
    } catch {
      setError("Couldn't reach that server. Check the address and that it's running.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.authBody} keyboardShouldPersistTaps="handled">
        <Text style={type.title}>selfnote</Text>
        <Text style={[type.body, { color: colors.inkSoft, marginBottom: spacing.sm }]}>
          Connect to your Selfnote server to get started.
        </Text>
        <Input
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="selfnote.example.com"
          label="Server address"
          error={error}
          onSubmitEditing={connect}
        />
        <Button label="Connect" onPress={connect} loading={busy} style={{ marginTop: spacing.sm }} />
        <Text style={[type.meta, styles.serverNote]}>
          Enter your self-hosted instance — we add /api and /ws automatically, and default to https.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function AuthScreen({ onAuthed, onSettings }: { onAuthed: () => void; onSettings: () => void }) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await api.login(email.trim(), password);
      else await api.register(email.trim(), password);
      onAuthed();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.authBody} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Text style={type.title}>selfnote</Text>
          <IconButton icon="settings" label="Settings" onPress={onSettings} />
        </View>
        <Text style={[type.body, { color: colors.inkSoft, marginBottom: spacing.sm }]}>
          {mode === "login" ? "Sign in to your instance." : "Create your account."}
        </Text>

        <Input
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder="you@example.com"
          label="Email"
        />
        <Input
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Password"
          label="Password"
          error={error}
        />

        <Button
          label={mode === "login" ? "Sign in" : "Create account"}
          onPress={submit}
          loading={busy}
          style={{ marginTop: spacing.sm }}
        />
        <Button
          variant="ghost"
          label={mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
          onPress={() => setMode(mode === "login" ? "register" : "login")}
        />

        <Text style={[type.meta, styles.serverNote]}>{getSettings().apiUrl}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/* -------------------------------------------------------------- Doc list --- */

interface TreeRow {
  doc: Document;
  depth: number;
  hasChildren: boolean;
}

/**
 * A page's id plus every descendant's. Shelf state cascades to the subtree on
 * the server, so the local list has to drop the same set: leaving the children
 * behind would re-root them in the tree (see flattenTree) as pages that are
 * archived or trashed on the server but still shown.
 */
function subtreeIds(docs: Document[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const d of docs) {
    if (!d.parent_id) continue;
    childrenOf.set(d.parent_id, [...(childrenOf.get(d.parent_id) ?? []), d.id]);
  }
  const ids = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      if (ids.has(child)) continue; // a cycle would otherwise spin forever
      ids.add(child);
      stack.push(child);
    }
  }
  return ids;
}

/** Flatten docs into a depth-tagged list; children of collapsed nodes are hidden. */
function flattenTree(docs: Document[], collapsed: Set<string>): TreeRow[] {
  const ids = new Set(docs.map((d) => d.id));
  const childrenOf = new Map<string | null, Document[]>();
  for (const d of docs) {
    const key = d.parent_id && ids.has(d.parent_id) ? d.parent_id : null;
    const arr = childrenOf.get(key) ?? [];
    arr.push(d);
    childrenOf.set(key, arr);
  }
  const rows: TreeRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const d of childrenOf.get(parentId) ?? []) {
      const kids = childrenOf.get(d.id) ?? [];
      rows.push({ doc: d, depth, hasChildren: kids.length > 0 });
      if (!collapsed.has(d.id)) walk(d.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function DocListScreen({
  onOpen,
  onDocs,
  onWorkspace,
  onTasks,
  onGraph,
  onSystem,
  onSettings,
  onLogout,
}: {
  onOpen: (doc: Document) => void;
  /** Report the loaded page list up, so the tab strip can track it. */
  onDocs: (docs: Document[]) => void;
  onWorkspace: (id: string) => void;
  onTasks: () => void;
  onGraph: () => void;
  onSystem: (view: SystemView) => void;
  onSettings: () => void;
  onLogout: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [actionsDoc, setActionsDoc] = useState<Document | null>(null);
  const [renameDoc, setRenameDoc] = useState<Document | null>(null);
  // "Move to…": the page being moved, while the destination picker is open.
  const [moveDoc, setMoveDoc] = useState<Document | null>(null);
  // The overflow menu: the System shelves plus the app-level actions that used
  // to sit loose in the topbar (web keeps the same split in its sidebar foot).
  const [menuOpen, setMenuOpen] = useState(false);
  // Workspace labels + doc→labels map, for the label filter chips.
  const [wsLabels, setWsLabels] = useState<Label[]>([]);
  const [docLabelIds, setDocLabelIds] = useState<Map<string, string[]>>(new Map());
  const [filterLabel, setFilterLabel] = useState<string | null>(null);
  // Server-side categorized search results for the current query (debounced).
  const [serverHits, setServerHits] = useState<SearchResults | null>(null);

  // Load persisted collapse state once.
  useEffect(() => {
    AsyncStorage.getItem(COLLAPSED_KEY).then((raw) => {
      if (raw) {
        try {
          setCollapsed(new Set(JSON.parse(raw) as string[]));
        } catch {
          /* ignore malformed */
        }
      }
    });
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const ws = workspaceId ?? (await ensureWorkspace());
      setWorkspaceId(ws);
      onWorkspace(ws);
      // The server's default shelf ("active") already excludes archived and
      // trashed pages, so the tree is exactly what it returns.
      const list = await api.listDocuments(ws);
      setDocs(list);
      onDocs(list);
      // Labels are decoration — fetch them best-effort alongside the tree.
      try {
        const [labels, assignments] = await Promise.all([
          api.listLabels(ws),
          api.listDocumentLabels(ws),
        ]);
        setWsLabels(labels);
        const map = new Map<string, string[]>();
        for (const a of assignments) {
          const l = map.get(a.document_id) ?? [];
          l.push(a.label_id);
          map.set(a.document_id, l);
        }
        setDocLabelIds(map);
      } catch {
        /* older server — no labels UI */
      }
    } catch (e) {
      // Leave the tabs alone on a failed load: an unreachable server is not
      // evidence that any page is gone.
      setError(friendly(e));
      setDocs([]);
    }
  }, [workspaceId, onWorkspace, onDocs]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createDoc = async (parentId: string | null) => {
    if (!workspaceId || creating) return;
    setCreating(true);
    try {
      const doc = await api.createDocument(workspaceId, parentId, "Untitled");
      await refresh();
      onOpen(doc);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setCreating(false);
    }
  };

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      AsyncStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])).catch(() => undefined);
      return next;
    });

  // Collapse/expand the whole tree in one tap (mirrors the web sidebar header):
  // "Collapse all" while anything is open, flipping to "Expand all" once every
  // parent is shut.
  const parentIds = useMemo(
    () =>
      docs
        ? flattenTree(docs, new Set())
            .filter((r) => r.hasChildren)
            .map((r) => r.doc.id)
        : [],
    [docs],
  );
  const allCollapsed = parentIds.length > 0 && parentIds.every((id) => collapsed.has(id));
  const toggleCollapseAll = () => {
    const next = allCollapsed ? new Set<string>() : new Set(parentIds);
    setCollapsed(next);
    AsyncStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])).catch(() => undefined);
  };

  const rename = async (doc: Document, title: string) => {
    setRenameDoc(null);
    try {
      await api.updateDocument(doc.id, { title: title.trim() || "Untitled" });
      await refresh();
    } catch (e) {
      setError(friendly(e));
    }
  };

  /**
   * Move a page to a shelf. The server applies the flag to the whole subtree
   * (and undoes it the same way), so dropping just this row locally is enough
   * until the next refresh.
   */
  const shelve = async (doc: Document, shelf: Shelf) => {
    setActionsDoc(null);
    const patch = shelf === "archive" ? { archived: true } : { trashed: true };
    const undo = shelf === "archive" ? { archived: false } : { trashed: false };
    // Optimistically drop the page and its subtree, then offer Undo (the
    // server restores the same subtree). Reporting the shorter list up is what
    // closes the tabs of the pages that just left the tree.
    const shelved = subtreeIds(docs ?? [], doc.id);
    const remaining = (docs ?? []).filter((d) => !shelved.has(d.id));
    setDocs(remaining);
    onDocs(remaining);
    try {
      await api.updateDocument(doc.id, patch);
      toast(
        shelf === "archive"
          ? `Archived "${doc.title || "Untitled"}"`
          : `Trashed "${doc.title || "Untitled"}"`,
        {
          actionLabel: "Undo",
          onAction: async () => {
            await api.updateDocument(doc.id, undo);
            refresh();
          },
        },
      );
    } catch (e) {
      setError(friendly(e));
      refresh();
    }
  };

  /*
   * Deliberately not drag and drop.
   *
   * Dragging inside a scrolling tree on a phone fights the scroll gesture: the
   * press that starts a drag is the same press that starts a scroll, and
   * resolving that means a long-press delay that makes both feel wrong. A
   * destination picker and two ordering actions reach the same API and the same
   * result with gestures that suit the device.
   */
  const applyMove = async (doc: Document, patch: { parent_id: string | null; position: number }) => {
    // Optimistic, then reconcile: the row lands where asked without waiting.
    setDocs((cur) =>
      cur
        ? cur.map((d) => (d.id === doc.id ? { ...d, ...patch } : d)).sort((a, b) => a.position - b.position)
        : cur,
    );
    try {
      await api.updateDocument(doc.id, patch);
    } catch (e) {
      // A toast, not setError: refresh() below starts with setError(null), so
      // the message would be cleared in the same tick it was set and the row
      // would just snap back with no explanation.
      toast(friendly(e));
    } finally {
      refresh();
    }
  };

  /** Move a page under `parentId` (null = top level), after its new siblings. */
  const moveUnder = async (doc: Document, parentId: string | null) => {
    setMoveDoc(null);
    setActionsDoc(null);
    const patch = computeMove(docs ?? [], doc.id, parentId, "inside");
    // null means the destination is inside the page's own subtree, or the move
    // changes nothing; either way there is no request worth making.
    if (patch) await applyMove(doc, patch);
  };

  /** Swap a page with its neighbour in the same sibling group. */
  const nudge = async (doc: Document, dir: -1 | 1) => {
    setActionsDoc(null);
    const sibs = (docs ?? [])
      .filter((d) => d.parent_id === doc.parent_id)
      .sort((a, b) => a.position - b.position);
    const i = sibs.findIndex((d) => d.id === doc.id);
    const neighbour = sibs[i + dir];
    if (!neighbour) return; // already at the end of its group
    const patch = computeMove(docs ?? [], doc.id, neighbour.id, dir === -1 ? "before" : "after");
    if (patch) await applyMove(doc, patch);
  };

  /** Close the overflow menu, then run whatever it chose. */
  const go = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  // Categorized server search for the current query (labels + body text; the
  // title list itself still filters locally so it works offline).
  useEffect(() => {
    const q = query.trim();
    if (!q || !workspaceId) {
      setServerHits(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.search(workspaceId, q);
        if (!stale) setServerHits(r);
      } catch {
        if (!stale) setServerHits(null); // older server — local titles only
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, workspaceId]);

  // Only labels that still tag at least one active page are offered as filters
  // (parity with the web sidebar): shelving a label's last page hides the chip.
  const usedLabels = useMemo(
    () => activeUsedLabels(wsLabels, docLabelIds, new Set((docs ?? []).map((d) => d.id))),
    [wsLabels, docLabelIds, docs],
  );

  // If the active filter's label just vanished, drop the filter so the list
  // doesn't stay stuck on an empty state.
  useEffect(() => {
    if (filterLabel && !usedLabels.some((l) => l.id === filterLabel)) {
      setFilterLabel(null);
    }
  }, [filterLabel, usedLabels]);

  /*
   * Destinations the "Move to…" picker may offer: everything except the page
   * being moved and its own subtree, since a page cannot be moved inside
   * itself. The subtree is computed once here rather than per candidate, which
   * would walk the whole tree for every row and block the JS thread before the
   * sheet paints on a large workspace.
   */
  const moveCandidates = useMemo(() => {
    if (!moveDoc) return [];
    const blocked = descendantIds(docs ?? [], moveDoc.id);
    return (docs ?? []).filter((d) => d.id !== moveDoc.id && !blocked.has(d.id));
  }, [moveDoc, docs]);

  // Search / label filter show a flat list; otherwise the collapsible tree.
  const q = query.trim().toLowerCase();
  const rows: TreeRow[] = !docs
    ? []
    : filterLabel
      ? docs
          .filter((d) => (docLabelIds.get(d.id) ?? []).includes(filterLabel))
          .map((doc) => ({ doc, depth: 0, hasChildren: false }))
      : q
        ? docs
            .filter((d) => (d.title || "untitled").toLowerCase().includes(q))
            .map((doc) => ({ doc, depth: 0, hasChildren: false }))
        : flattenTree(docs, collapsed);

  return (
    <View style={styles.flex}>
      <View style={styles.topbar}>
        <Text style={[type.docTitle, styles.flex]} numberOfLines={1} adjustsFontSizeToFit>
          Documents
        </Text>
        <IconButton
          icon={allCollapsed ? "chevrons-down" : "chevrons-up"}
          label={allCollapsed ? "Expand all" : "Collapse all"}
          onPress={toggleCollapseAll}
          disabled={parentIds.length === 0}
        />
        <IconButton icon="check-square" label="Tasks" onPress={onTasks} />
        <IconButton icon="git-branch" label="Graph" onPress={onGraph} />
        <IconButton icon="more-horizontal" label="Menu" onPress={() => setMenuOpen(true)} />
      </View>

      {docs && docs.length > 0 ? (
        <View style={styles.searchWrap}>
          <Input value={query} onChangeText={setQuery} placeholder="Search pages" autoCorrect={false} />
        </View>
      ) : null}

      {workspaceId && docs && docs.length > 0 ? (
        <BulkLabelButton workspaceId={workspaceId} onError={(m) => toast(m)} />
      ) : null}

      {usedLabels.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.labelFilterRow}
          contentContainerStyle={styles.labelFilterContent}
        >
          {usedLabels.map((l) => {
            const on = filterLabel === l.id;
            return (
              <Pressable
                key={l.id}
                onPress={() => setFilterLabel((cur) => (cur === l.id ? null : l.id))}
                style={[
                  styles.labelFilterChip,
                  { borderColor: l.color },
                  on && { backgroundColor: `${l.color}22` },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`Filter by label ${l.name}`}
              >
                <View style={[styles.labelFilterDot, { backgroundColor: l.color }]} />
                <Text style={[styles.labelFilterText, on && { color: colors.ink, fontWeight: "600" }]}>
                  {l.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {error ? <Text style={[styles.error, styles.pad]}>{error}</Text> : null}

      {docs === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Text style={[type.docTitle, { color: colors.inkSoft, marginBottom: spacing.lg }]}>
            {q ? "No pages match." : "Nothing here yet."}
          </Text>
          {q ? null : (
            <Button label="Create your first page" onPress={() => createDoc(null)} loading={creating} />
          )}
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.doc.id}
          onRefresh={refresh}
          refreshing={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listPad}
          ListFooterComponent={
            q && serverHits && (serverHits.labels.length > 0 || serverHits.texts.length > 0) ? (
              <View>
                {serverHits.labels.length > 0 ? (
                  <View>
                    <Text style={styles.searchSection}>Labels</Text>
                    {serverHits.labels.map((l) => (
                      <Row
                        key={l.id}
                        onPress={() => {
                          setFilterLabel(l.id);
                          setQuery("");
                        }}
                        accessibilityLabel={`Filter by label ${l.name}`}
                      >
                        <View style={styles.rowInner}>
                          <View style={[styles.labelFilterDot, { backgroundColor: l.color }]} />
                          <Text style={[type.docTitle, styles.flex]} numberOfLines={1}>
                            {l.name}
                          </Text>
                          <Text style={styles.searchHint}>filter pages</Text>
                        </View>
                      </Row>
                    ))}
                  </View>
                ) : null}
                {serverHits.texts.length > 0 ? (
                  <View>
                    <Text style={styles.searchSection}>Text in page</Text>
                    {serverHits.texts.map((t) => {
                      const target = docs?.find((d) => d.id === t.id);
                      return (
                        <Row
                          key={t.id}
                          onPress={() => target && onOpen(target)}
                          accessibilityLabel={t.title || "Untitled"}
                        >
                          <View style={styles.flex}>
                            <Text style={type.docTitle} numberOfLines={1}>
                              {t.title || "Untitled"}
                            </Text>
                            <Text style={styles.searchSnippet} numberOfLines={2}>
                              {t.snippet.split(/<\/?mark>/).map((part, i) =>
                                i % 2 === 1 ? (
                                  <Text key={i} style={styles.searchMark}>
                                    {part}
                                  </Text>
                                ) : (
                                  part
                                ),
                              )}
                            </Text>
                          </View>
                        </Row>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Row
              indent={item.depth * 20}
              /*
               * A page with children is a container, and a tap on one almost
               * always means "show me what is inside" rather than "open this
               * mostly empty container note". Container rows therefore toggle,
               * and the trailing button opens the page. Leaf rows still open on
               * tap. Search and label-filter rows are built with
               * hasChildren: false, so those flat lists need no special case.
               */
              onPress={() =>
                item.hasChildren ? toggleCollapse(item.doc.id) : onOpen(item.doc)
              }
              onLongPress={() => setActionsDoc(item.doc)}
              accessibilityLabel={item.doc.title || "Untitled"}
              trailing={
                // "Add subpage" already lives in the long-press sheet, so the
                // trailing slot means exactly one thing: open this page. It is
                // present precisely where a tap does not open it.
                item.hasChildren ? (
                  <IconButton
                    icon="file-text"
                    label="Open page"
                    onPress={() => onOpen(item.doc)}
                  />
                ) : null
              }
            >
              <View style={styles.rowInner}>
                {item.hasChildren ? (
                  <Pressable
                    onPress={() => toggleCollapse(item.doc.id)}
                    hitSlop={hitSlop(24)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: !collapsed.has(item.doc.id) }}
                    accessibilityLabel={collapsed.has(item.doc.id) ? "Expand" : "Collapse"}
                    style={styles.chevron}
                  >
                    <Feather
                      name={collapsed.has(item.doc.id) ? "chevron-right" : "chevron-down"}
                      size={16}
                      color={colors.inkSoft}
                    />
                  </Pressable>
                ) : (
                  <View style={styles.chevron}>
                    <View style={styles.rowBullet} />
                  </View>
                )}
                <Text style={[type.docTitle, styles.flex]} numberOfLines={1}>
                  {item.doc.title || "Untitled"}
                </Text>
              </View>
            </Row>
          )}
        />
      )}

      <View style={styles.fab}>
        <Button label="New page" icon="plus" onPress={() => createDoc(null)} loading={creating} />
      </View>

      {actionsDoc ? (
        <Sheet title={actionsDoc.title || "Untitled"} onClose={() => setActionsDoc(null)}>
          <Button
            variant="secondary"
            label="Rename"
            onPress={() => {
              setRenameDoc(actionsDoc);
              setActionsDoc(null);
            }}
          />
          <Button
            variant="secondary"
            label="Add subpage"
            onPress={() => {
              const d = actionsDoc;
              setActionsDoc(null);
              createDoc(d.id);
            }}
          />
          <Button
            variant="secondary"
            icon="corner-down-right"
            label="Move to…"
            onPress={() => {
              setMoveDoc(actionsDoc);
              setActionsDoc(null);
            }}
          />
          <Button
            variant="secondary"
            icon="arrow-up"
            label="Move up"
            onPress={() => void nudge(actionsDoc, -1)}
          />
          <Button
            variant="secondary"
            icon="arrow-down"
            label="Move down"
            onPress={() => void nudge(actionsDoc, 1)}
          />
          <Button
            variant="secondary"
            label="Archive"
            onPress={() => shelve(actionsDoc, "archive")}
          />
          <Button
            variant="destructive"
            label="Move to trash"
            onPress={() => shelve(actionsDoc, "trash")}
          />
        </Sheet>
      ) : null}

      {menuOpen ? (
        <Sheet title="Menu" onClose={() => setMenuOpen(false)}>
          <Text style={type.label}>System</Text>
          <Button
            variant="secondary"
            icon="paperclip"
            label="Assets"
            onPress={() => go(() => onSystem("assets"))}
          />
          <Button
            variant="secondary"
            icon="archive"
            label="Archive"
            onPress={() => go(() => onSystem("archive"))}
          />
          <Button
            variant="secondary"
            icon="trash-2"
            label="Trash"
            onPress={() => go(() => onSystem("trash"))}
          />
          <Text style={type.label}>App</Text>
          <Button
            variant="secondary"
            icon="settings"
            label="Settings"
            onPress={() => go(onSettings)}
          />
          <Button variant="ghost" icon="log-out" label="Log out" onPress={() => go(onLogout)} />
        </Sheet>
      ) : null}

      {moveDoc ? (
        <Sheet title={`Move "${moveDoc.title || "Untitled"}"`} onClose={() => setMoveDoc(null)}>
          <ScrollView style={styles.movePicker} keyboardShouldPersistTaps="handled">
            <Button
              variant="secondary"
              icon="home"
              label="Top level"
              onPress={() => void moveUnder(moveDoc, null)}
            />
            {moveCandidates.map((d) => (
              <Button
                key={d.id}
                variant="secondary"
                icon="file-text"
                label={d.title || "Untitled"}
                onPress={() => void moveUnder(moveDoc, d.id)}
              />
            ))}
          </ScrollView>
        </Sheet>
      ) : null}

      {renameDoc ? <RenameSheet doc={renameDoc} onClose={() => setRenameDoc(null)} onSave={rename} /> : null}
    </View>
  );
}

function RenameSheet({
  doc,
  onClose,
  onSave,
}: {
  doc: Document;
  onClose: () => void;
  onSave: (doc: Document, title: string) => void;
}) {
  const [title, setTitle] = useState(doc.title || "");
  return (
    <Sheet title="Rename page" onClose={onClose}>
      <Input value={title} onChangeText={setTitle} placeholder="Page title" autoFocus label="Title" />
      <Button label="Save" onPress={() => onSave(doc, title)} />
    </Sheet>
  );
}

/* ---------------------------------------------------------------- Editor --- */

function EditorScreen({
  doc,
  tabCount,
  onShowTabs,
  onBack,
  onNavigateToDoc,
}: {
  doc: Document;
  /** Open pages, shown on the topbar's tab-count button. */
  tabCount: number;
  onShowTabs: () => void;
  onBack: () => void;
  onNavigateToDoc: (id: string) => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [token, setToken] = useState<string | null>(null);
  // Room mode gates history write actions client-side (server also enforces).
  const [mode, setMode] = useState<"rw" | "ro">("rw");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rt = await api.roomToken(doc.id);
        if (!cancelled) {
          setToken(rt.token);
          setMode(rt.mode);
        }
      } catch (e) {
        if (!cancelled) setError(friendly(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  // Record the view so it can be suggested as AI context (fire-and-forget).
  useEffect(() => {
    api.markViewed(doc.id).catch(() => undefined);
  }, [doc.id]);

  if (error) {
    return (
      <View style={styles.flex}>
        <EditorTopbar
          title={doc.title}
          tabCount={tabCount}
          onShowTabs={onShowTabs}
          onBack={onBack}
        />
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
        </View>
      </View>
    );
  }

  if (!token) {
    return (
      <View style={styles.flex}>
        <EditorTopbar
          title={doc.title}
          tabCount={tabCount}
          onShowTabs={onShowTabs}
          onBack={onBack}
        />
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    );
  }

  return (
    <ConnectedEditor
      doc={doc}
      token={token}
      canWrite={mode === "rw"}
      tabCount={tabCount}
      onShowTabs={onShowTabs}
      onBack={onBack}
      onNavigateToDoc={onNavigateToDoc}
    />
  );
}

function ConnectedEditor({
  doc,
  token,
  canWrite,
  tabCount,
  onShowTabs,
  onBack,
  onNavigateToDoc,
}: {
  doc: Document;
  token: string;
  canWrite: boolean;
  tabCount: number;
  onShowTabs: () => void;
  onBack: () => void;
  onNavigateToDoc: (id: string) => void;
}) {
  const connection = useMemo(
    () =>
      createDocConnection(doc.id, {
        serverUrl: getSettings().syncUrl,
        token,
        persistence: sqlitePersistence,
      }),
    [doc.id, token],
  );
  const { colors, type, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [status, setStatus] = useState<ConnectionStatus>(connection.status());
  const [ai, setAi] = useState<AiStatus | null>(null);
  /*
   * This page's task metadata, owned here rather than inside TaskControls: both
   * the label row (which carries the "Make task" chip) and the task row need to
   * know whether the page is a task, so one owner above them is the only
   * arrangement that keeps them consistent. Matches the web contract.
   * `undefined` = the lookup is still in flight, `null` = not a task.
   */
  const [task, setTask] = useState<Task | null | undefined>(undefined);
  const [showAssist, setShowAssist] = useState(false);
  const [showActions, setShowActions] = useState(false);
  // The topbar's overflow sheet: every page action that used to be its own icon.
  const [showPageMenu, setShowPageMenu] = useState(false);
  // "Render math" is in flight; the result itself is reported by a toast.
  const [mathBusy, setMathBusy] = useState(false);
  // Version history (docs/features/version-history.md §5): the timeline modal and
  // the checkpoint currently open in the read-only preview overlay.
  const [showHistory, setShowHistory] = useState(false);
  const [previewCheckpoint, setPreviewCheckpoint] = useState<Checkpoint | null>(null);
  // Share link analytics (docs/features/share-analytics.md §5): the Share action
  // opens a sheet listing this doc's links with view counts + last-viewed times.
  const [showShares, setShowShares] = useState(false);
  // Staged AI edits awaiting review (banner) + the one currently open in the diff.
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const [reviewing, setReviewing] = useState<AiProposal | null>(null);
  // Composer prefill for the selection bar's "Ask AI".
  const [assistPrefill, setAssistPrefill] = useState("");


  // Attach a file: pick → upload (multipart) → insert the matching block.
  const attachFile = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.length) return;
      const asset = picked.assets[0];
      toast("Uploading…");
      const url = await api.uploadFileUri(
        doc.workspace_id,
        {
          uri: asset.uri,
          name: asset.name ?? "file",
          mimeType: asset.mimeType,
        },
        doc.id,
      );
      editorRef.current?.insertFile({ url, name: asset.name ?? "file", mime: asset.mimeType });
      toast("Attached.");
    } catch {
      toast("Couldn't upload the file.");
    }
  };
  // Bumped after the editor re-scans + stores its outgoing links, so the
  // backlinks/outgoing panel re-fetches (docs/features/backlinks-graph.md §5).
  const [linksVersion, setLinksVersion] = useState(0);
  const editorRef = useRef<EditorHandle>(null);
  const toast = useToast();

  // Load this page's task metadata (404 = not a task).
  useEffect(() => {
    let alive = true;
    setTask(undefined);
    api
      .getTask(doc.id)
      .then((t) => alive && setTask(t))
      .catch((e: unknown) => {
        if (!alive) return;
        // Fall back to "not a task" either way, so the page stays usable, but
        // say so when the reason was not a 404: silently offering "Make task"
        // on a page that IS a task, because the server was unreachable, reads
        // as data loss.
        setTask(null);
        if ((e as { status?: number }).status !== 404) toast("Couldn't load the task.");
      });
    return () => {
      alive = false;
    };
  }, [doc.id, toast]);

  // Poll pending proposals for this doc — on open and after each assistant reply.
  const refreshProposals = useCallback(async () => {
    try {
      setProposals(await api.listAiProposals(doc.id, "pending"));
    } catch {
      /* offline / older server without proposals — leave the banner empty */
    }
  }, [doc.id]);

  useEffect(() => {
    refreshProposals();
  }, [refreshProposals]);

  // Stage an in-app "insert into note" as a proposal (origin: "app") and open the
  // same accept/reject gate as remote MCP edits, instead of writing Yjs directly.
  const insertViaProposal = async (text: string) => {
    try {
      const p = await api.createAiProposal({
        document_id: doc.id,
        op: "append",
        markdown: text,
        origin: "app",
        summary: "Insert from Assist",
      });
      setProposals((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);
      setShowAssist(false);
      setReviewing(p);
    } catch {
      toast("Couldn't stage the edit. Try again.");
    }
  };

  const onProposalResolved = (
    resolvedStatus: "applied" | "rejected",
    p: AiProposal,
  ) => {
    setProposals((prev) => prev.filter((x) => x.id !== p.id));
    setReviewing(null);
    toast(resolvedStatus === "applied" ? "Edit applied." : "Edit discarded.");
  };

  const notedOffline = useRef(false);
  useEffect(() => {
    const unsub = connection.onStatus((s) => {
      setStatus(s);
      // One-time reassurance the first time we drop offline mid-session.
      if ((s === "disconnected" || s === "offline") && !notedOffline.current) {
        notedOffline.current = true;
        toast("Saved on this device — will sync when you're back online.");
      }
      if (s === "connected") notedOffline.current = false;
    });
    return () => {
      unsub();
      connection.destroy();
    };
  }, [connection, toast]);

  // One-shot: does this server have an AI backend? (Silently false if not.)
  useEffect(() => {
    let alive = true;
    api.aiStatus().then((s) => alive && setAi(s));
    return () => {
      alive = false;
    };
  }, []);

  const offline = status === "disconnected" || status === "offline";

  // Android back closes overlays top-down (mirroring their visual stacking);
  // with nothing open it falls through to the root handler, which pops back
  // to the document list.
  useAndroidBack(
    useCallback(() => {
      if (previewCheckpoint) {
        editorRef.current?.clearPreview();
        setPreviewCheckpoint(null);
        setShowHistory(true);
        return true;
      }
      if (showHistory) {
        setShowHistory(false);
        return true;
      }
      if (reviewing) {
        setReviewing(null);
        refreshProposals();
        return true;
      }
      if (showShares) {
        setShowShares(false);
        return true;
      }
      if (showPageMenu) {
        setShowPageMenu(false);
        return true;
      }
      if (showActions) {
        setShowActions(false);
        return true;
      }
      if (showAssist) {
        setShowAssist(false);
        return true;
      }
      return false;
    }, [previewCheckpoint, showHistory, reviewing, showShares, showPageMenu, showActions, showAssist, refreshProposals]),
  );

  return (
    <View style={[styles.flex, { backgroundColor: colors.surface }]}>
      <EditorTopbar
        title={doc.title}
        presence={<PresenceChips connection={connection} />}
        tabCount={tabCount}
        onShowTabs={onShowTabs}
        onBack={onBack}
        status={status}
        onMenu={() => setShowPageMenu(true)}
      />
      {offline ? (
        <Pressable style={styles.offlineBanner} onPress={() => connection.goOnline()}>
          <Text style={styles.offlineText}>Working offline — edits are saved on this device.</Text>
          <Text style={styles.offlineAction}>Reconnect</Text>
        </Pressable>
      ) : null}
      {proposals.length > 0 ? (
        <Pressable
          style={styles.proposalBanner}
          onPress={() => setReviewing(proposals[0])}
          accessibilityRole="button"
          accessibilityLabel={`Review ${proposals.length} pending AI edit${proposals.length > 1 ? "s" : ""}`}
        >
          <Text style={styles.proposalText}>
            {proposals.length} pending AI edit{proposals.length > 1 ? "s" : ""}
          </Text>
          <Text style={styles.proposalAction}>Review</Text>
        </Pressable>
      ) : null}
      <LabelRow
        docId={doc.id}
        workspaceId={doc.workspace_id}
        aiAvailable={ai?.available ?? false}
        getText={() => editorRef.current?.getText() ?? Promise.resolve("")}
        /*
          Promoting a page is page metadata, so it belongs with the labels
          rather than in a row of its own: that row's entire content, for every
          page that is not a task, was this one button. `undefined` means the
          lookup is still in flight, so neither is shown yet.
        */
        trailing={
          task === null ? (
            <MakeTaskButton
              docId={doc.id}
              onChange={setTask}
              onError={(m) => m && toast(m)}
            />
          ) : null
        }
        onError={(m) => toast(m)}
      />
      {task ? (
        <View style={styles.taskControls}>
          <TaskControls
            docId={doc.id}
            task={task}
            onChange={setTask}
            onError={(m) => m && toast(m)}
          />
        </View>
      ) : null}
      <WebViewEditor
        ref={editorRef}
        connection={connection}
        user={USER}
        docId={doc.id}
        workspaceId={doc.workspace_id}
        theme={isDark ? "dark" : "light"}
        aiAvailable={ai?.available ?? false}
        aiFeatures={ai?.features ?? []}
        onNavigateToDoc={onNavigateToDoc}
        onLinksChanged={() => setLinksVersion((v) => v + 1)}
        onError={(m) => toast(m)}
        onCopyMarkdown={(md) => {
          Clipboard.setStringAsync(md)
            .then(() => toast("Copied as Markdown."))
            .catch(() => toast("Couldn't copy."));
        }}
        onAskAi={(selection) => {
          setAssistPrefill(
            selection
              ? `About this passage:\n> ${selection.replace(/\n/g, "\n> ")}\n\n`
              : "",
          );
          setShowAssist(true);
        }}
      />
      <BacklinksPanel
        docId={doc.id}
        offline={offline}
        refreshKey={linksVersion}
        onNavigateToDoc={onNavigateToDoc}
      />
      {showAssist && ai ? (
        <AssistDrawer
          status={ai}
          docId={doc.id}
          workspaceId={doc.workspace_id}
          prefill={assistPrefill}
          getText={() => editorRef.current?.getText() ?? Promise.resolve("")}
          resolveMarkdown={async (id) => {
            // The current note is already mounted — read it live; others come
            // from the local SQLite cache, rendered headlessly in the WebView.
            if (id === doc.id) return (await editorRef.current?.getText()) ?? "";
            const state = await loadCachedState(id);
            if (!state) return "";
            return (await editorRef.current?.renderMarkdown(state)) ?? "";
          }}
          onInsert={(text) => void insertViaProposal(text)}
          onReply={refreshProposals}
          onClose={() => setShowAssist(false)}
        />
      ) : null}
      {showPageMenu ? (
        <Sheet title="Page" onClose={() => setShowPageMenu(false)}>
          {canWrite ? (
            <Button
              variant="secondary"
              icon="paperclip"
              label="Attach file"
              onPress={() => {
                setShowPageMenu(false);
                void attachFile();
              }}
            />
          ) : null}
          <Button
            variant="secondary"
            icon="clock"
            label="Version history"
            onPress={() => {
              setShowPageMenu(false);
              setShowHistory(true);
            }}
          />
          <Button
            variant="secondary"
            icon="share"
            label="Share"
            onPress={() => {
              setShowPageMenu(false);
              setShowShares(true);
            }}
          />
          {ai?.available ? (
            <Button
              variant="secondary"
              icon="zap"
              label="AI actions"
              onPress={() => {
                setShowPageMenu(false);
                setShowActions(true);
              }}
            />
          ) : null}
          {ai?.available ? (
            <Button
              variant="secondary"
              icon="star"
              label="AI Assist"
              onPress={() => {
                setShowPageMenu(false);
                setShowAssist(true);
              }}
            />
          ) : null}
          {canWrite ? (
            <Button
              variant="secondary"
              icon="hash"
              label="Render math"
              loading={mathBusy}
              onPress={async () => {
                setMathBusy(true);
                const n = (await editorRef.current?.renderMath()) ?? -1;
                setMathBusy(false);
                setShowPageMenu(false);
                toast(
                  n === -2
                    ? "Still working; the page may update in a moment."
                    : n < 0
                      ? "Couldn't convert this page."
                      : n === 0
                        ? "No literal math found in this page."
                        : `Rendered ${n} formula${n === 1 ? "" : "s"}.`,
                );
              }}
            />
          ) : null}
        </Sheet>
      ) : null}

      {showActions && ai ? (
        <NoteAiActions
          status={ai}
          docId={doc.id}
          getSelection={() =>
            editorRef.current?.getSelection() ?? Promise.resolve({ text: "", selection: "" })
          }
          onInsert={(text) => void insertViaProposal(text)}
          onReplace={(text) => {
            // Selection or whole-note replace flows through Yjs to the server.
            editorRef.current?.replace(text);
            toast("Note replaced.");
          }}
          onClose={() => setShowActions(false)}
        />
      ) : null}
      {showShares ? (
        <ShareAnalyticsSheet docId={doc.id} onClose={() => setShowShares(false)} />
      ) : null}
      {reviewing ? (
        <AiDiffScreen
          proposal={reviewing}
          onResolved={onProposalResolved}
          onClose={() => {
            setReviewing(null);
            refreshProposals();
          }}
        />
      ) : null}
      {/*
        Version history (docs/features/version-history.md §5). The timeline is a
        full-screen modal; opening a preview hides it (setShowHistory(false)) so the
        WebView's read-only past state — driven by editorRef.preview() — is visible
        behind the transparent HistoryPreviewScreen overlay. "Back" reopens the list.
      */}
      {showHistory && !previewCheckpoint ? (
        <HistoryScreen
          docId={doc.id}
          canWrite={canWrite}
          offline={offline}
          onClose={() => setShowHistory(false)}
          onPreview={(cp) => {
            setShowHistory(false);
            setPreviewCheckpoint(cp);
          }}
        />
      ) : null}
      {previewCheckpoint ? (
        <HistoryPreviewScreen
          docId={doc.id}
          checkpoint={previewCheckpoint}
          editorRef={editorRef}
          canWrite={canWrite}
          onBack={() => {
            editorRef.current?.clearPreview();
            setPreviewCheckpoint(null);
            setShowHistory(true);
          }}
          onRestored={() => {
            setPreviewCheckpoint(null);
            setShowHistory(false);
          }}
          onDeleted={() => {
            editorRef.current?.clearPreview();
            setPreviewCheckpoint(null);
            setShowHistory(true);
          }}
        />
      ) : null}
    </View>
  );
}

/*
 * Note topbar: back, title, tab count, overflow.
 *
 * Every page action used to sit here as its own icon. On a phone that was seven
 * controls competing with the title: the title was squeezed to nothing and the
 * last icon was clipped off the right edge, so AI Assist could not be tapped at
 * all. They live in the overflow sheet now, which also gives each one a label
 * instead of a bare glyph. The tab count stays out, immediately left of the
 * overflow, because it is a state readout as much as a button.
 */
function EditorTopbar({
  title,
  presence,
  tabCount,
  onShowTabs,
  onBack,
  status,
  onMenu,
}: {
  title: string;
  /** Other editors in the room; absent when alone. See PresenceChips. */
  presence?: ReactNode;
  /** Open pages. Omitted by the history-preview topbar, which has no tabs. */
  tabCount?: number;
  onShowTabs?: () => void;
  onBack: () => void;
  status?: ConnectionStatus;
  /** Opens the page-actions sheet. Omitted where there are no page actions. */
  onMenu?: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  return (
    <View style={styles.topbar}>
      <IconButton icon="chevron-left" label="Back to documents" onPress={onBack} />
      <Text style={[type.docTitle, styles.flex]} numberOfLines={1}>
        {title || "Untitled"}
      </Text>
      {presence}
      {status ? <StatusDot state={status} /> : null}
      {onShowTabs && tabCount ? <TabCountButton count={tabCount} onPress={onShowTabs} /> : null}
      {onMenu ? <IconButton icon="more-vertical" label="Page actions" onPress={onMenu} /> : null}
    </View>
  );
}

/* -------------------------------------------------------------- Settings --- */

function SettingsScreen({
  workspaceId,
  onClose,
  onWiped,
}: {
  workspaceId: string | null;
  onClose: () => void;
  onWiped: () => void;
}) {
  const current = getSettings();
  const { mode, setMode, colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [syncUrl, setSyncUrl] = useState(current.syncUrl);
  const [apiUrl, setApiUrl] = useState(current.apiUrl);
  const [saved, setSaved] = useState(false);
  // Voice settings only make sense when the server has an AI provider.
  const [aiAvailable, setAiAvailable] = useState(false);

  useEffect(() => {
    if (workspaceId == null) return; // only signed-in (app phase) can call /ai
    let alive = true;
    api.aiStatus().then((s) => alive && setAiAvailable(s.available));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const save = async () => {
    await saveSettings({ syncUrl, apiUrl } as ServerSettings);
    setSaved(true);
    setTimeout(onClose, 400);
  };

  // Wipe everything this device holds: session tokens, server settings, theme
  // and tree preferences, and the cached note bodies. Notes on the server are
  // untouched; signing back in re-syncs them.
  const wipeDevice = async () => {
    await api.logout().catch(() => undefined);
    await AsyncStorage.clear().catch(() => undefined);
    await wipeLocalCache();
    await loadSettings(); // reset the in-memory URLs to the defaults
    setMode("system"); // theme override is device data too
    onWiped();
  };

  const deleteAllData = () => {
    Alert.alert(
      "Delete all data on this phone?",
      "This signs you out and removes cached notes, settings, and preferences from this device. Notes on your server are not affected.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void wipeDevice() },
      ],
    );
  };

  return (
    <Sheet title="Settings" onClose={onClose}>
      <Text style={[type.body, { color: colors.inkSoft }]}>
        Point the app at your self-hosted Selfnote instance.
      </Text>
      <Input
        value={apiUrl}
        onChangeText={setApiUrl}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={defaults.apiUrl}
        label="API URL (HTTP)"
      />
      <Input
        value={syncUrl}
        onChangeText={setSyncUrl}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={defaults.syncUrl}
        label="Sync URL (WebSocket)"
      />
      <Text style={type.label}>Appearance</Text>
      <View style={styles.segment}>
        {(["system", "light", "dark"] as ThemeMode[]).map((m) => (
          <View key={m} style={styles.flex}>
            <Button
              variant={mode === m ? "primary" : "secondary"}
              label={m[0].toUpperCase() + m.slice(1)}
              onPress={() => setMode(m)}
            />
          </View>
        ))}
      </View>

      <Button label={saved ? "Saved" : "Save"} onPress={save} />
      <Text style={type.meta}>
        Defaults: {defaults.apiUrl} · {defaults.syncUrl}
      </Text>

      {aiAvailable ? <VoiceSection /> : null}

      {workspaceId ? <CalendarFeedSection workspaceId={workspaceId} /> : null}

      <Text style={type.label}>This device</Text>
      <Button variant="destructive" label="Delete all data on this phone" onPress={deleteAllData} />
    </Sheet>
  );
}

/* ----------------------------------------------------------------- utils --- */

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/network request failed/i.test(msg)) return "Can't reach the server. Check the URL in Settings.";
  if (/^HTTP 401/.test(msg) || /unauthor/i.test(msg)) return "Wrong email or password.";
  return msg.slice(0, 200);
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
  flex: { flex: 1 },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxl },
  authBody: { padding: spacing.xxl, gap: spacing.md, flexGrow: 1, justifyContent: "center" },
  pad: { paddingHorizontal: spacing.gutter, paddingTop: spacing.md },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  serverNote: { marginTop: spacing.lg, textAlign: "center" },
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
  searchWrap: { paddingHorizontal: spacing.gutter, paddingVertical: spacing.md },
  segment: { flexDirection: "row", gap: spacing.sm },
  rowInner: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowBullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.inkFaint },
  // flexShrink: 0 — when the page list below grows (e.g. expanding a subtree),
  // the flex column would otherwise compress this row and clip the chips.
  labelFilterRow: { flexGrow: 0, flexShrink: 0 },
  labelFilterContent: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
    alignItems: "center",
  },
  labelFilterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  labelFilterDot: { width: 7, height: 7, borderRadius: 4 },
  labelFilterText: { fontSize: 12, color: colors.inkSoft },
  searchSection: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: colors.inkSoft,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  searchHint: { fontSize: 11, color: colors.inkSoft },
  searchSnippet: { fontSize: 12, color: colors.inkSoft, marginTop: 2 },
  searchMark: { color: colors.ink, fontWeight: "600" },
  chevron: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  // Bounded so a large workspace's picker cannot push the sheet off-screen.
  movePicker: { maxHeight: 360 },
  // Covers the mounted screen rather than replacing it (see the tab switcher).
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.paper },
  error: { ...type.body, color: colors.danger },
  listPad: { paddingBottom: 96 },
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.gutter,
    backgroundColor: colors.accentWash,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  offlineText: { ...type.meta, color: colors.ink, flexShrink: 1 },
  offlineAction: { ...type.button, color: colors.accent },
  proposalBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.gutter,
    backgroundColor: colors.accentWash,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  proposalText: { ...type.meta, color: colors.ink, flexShrink: 1, fontWeight: "600" },
  proposalAction: { ...type.button, color: colors.accent },
  fab: { position: "absolute", left: spacing.gutter, right: spacing.gutter, bottom: spacing.xxl, ...shadow.floating, borderRadius: radius.md },
  taskControls: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
});
