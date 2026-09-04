import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createDocConnection, type ConnectionStatus } from "@selfnote/core";
import { sqlitePersistence } from "./src/persistence/sqlite";
import { WebViewEditor, type EditorUser, type EditorHandle } from "./src/editor/WebViewEditor";
import { AssistDrawer } from "./src/editor/AssistDrawer";
import { api, ensureWorkspace, isAuthed, loadSession, type Document, type AiStatus } from "./src/api";
import {
  getSettings,
  loadSettings,
  saveSettings,
  deriveFromBase,
  isConfigured,
  defaults,
  type ServerSettings,
} from "./src/settings";
import { colors as lightPalette, radius, shadow, sizing, spacing } from "./src/theme";
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

const COLLAPSED_KEY = "selfnote.collapsed";

const USER: EditorUser = {
  name: `Mobile ${Math.floor(Math.random() * 90 + 10)}`,
  color: lightPalette.accent, // awareness cursor color — a fixed brand hue is fine
};

type Phase = "booting" | "onboarding" | "auth" | "app";

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
  const [phase, setPhase] = useState<Phase>("booting");
  const [showSettings, setShowSettings] = useState(false);
  const [openDoc, setOpenDoc] = useState<Document | null>(null);

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
            <EditorScreen doc={openDoc} onBack={() => setOpenDoc(null)} />
          ) : (
            <DocListScreen
              onOpen={setOpenDoc}
              onSettings={() => setShowSettings(true)}
              onLogout={async () => {
                await api.logout();
                setPhase("auth");
              }}
            />
          ))}

      {showSettings && <SettingsScreen onClose={() => setShowSettings(false)} />}
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
          <IconButton glyph="⚙" label="Settings" onPress={onSettings} />
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
  onSettings,
  onLogout,
}: {
  onOpen: (doc: Document) => void;
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
      const list = await api.listDocuments(ws);
      setDocs(list.filter((d) => !d.archived));
    } catch (e) {
      setError(friendly(e));
      setDocs([]);
    }
  }, [workspaceId]);

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

  const rename = async (doc: Document, title: string) => {
    setRenameDoc(null);
    try {
      await api.updateDocument(doc.id, { title: title.trim() || "Untitled" });
      await refresh();
    } catch (e) {
      setError(friendly(e));
    }
  };

  const archive = async (doc: Document) => {
    setActionsDoc(null);
    // Optimistically drop it, then offer Undo.
    setDocs((prev) => prev?.filter((d) => d.id !== doc.id) ?? prev);
    try {
      await api.updateDocument(doc.id, { archived: true });
      toast(`Archived "${doc.title || "Untitled"}"`, {
        actionLabel: "Undo",
        onAction: async () => {
          await api.updateDocument(doc.id, { archived: false });
          refresh();
        },
      });
    } catch (e) {
      setError(friendly(e));
      refresh();
    }
  };

  // Search shows a flat, filtered list; otherwise the collapsible tree.
  const q = query.trim().toLowerCase();
  const rows: TreeRow[] = !docs
    ? []
    : q
      ? docs
          .filter((d) => (d.title || "untitled").toLowerCase().includes(q))
          .map((doc) => ({ doc, depth: 0, hasChildren: false }))
      : flattenTree(docs, collapsed);

  return (
    <View style={styles.flex}>
      <View style={styles.topbar}>
        <Text style={[type.docTitle, styles.flex]}>Documents</Text>
        <IconButton glyph="⚙" label="Settings" onPress={onSettings} />
        <Button variant="ghost" label="Log out" onPress={onLogout} style={styles.logout} />
      </View>

      {docs && docs.length > 0 ? (
        <View style={styles.searchWrap}>
          <Input value={query} onChangeText={setQuery} placeholder="Search pages" autoCorrect={false} />
        </View>
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
          renderItem={({ item }) => (
            <Row
              indent={item.depth * 20}
              onPress={() => onOpen(item.doc)}
              onLongPress={() => setActionsDoc(item.doc)}
              accessibilityLabel={item.doc.title || "Untitled"}
              trailing={
                <IconButton glyph="＋" label="Add subpage" onPress={() => createDoc(item.doc.id)} />
              }
            >
              <View style={styles.rowInner}>
                {item.hasChildren ? (
                  <Pressable
                    onPress={() => toggleCollapse(item.doc.id)}
                    hitSlop={12}
                    accessibilityLabel={collapsed.has(item.doc.id) ? "Expand" : "Collapse"}
                    style={styles.chevron}
                  >
                    <Text style={styles.chevronGlyph}>
                      {collapsed.has(item.doc.id) ? "▸" : "▾"}
                    </Text>
                  </Pressable>
                ) : (
                  <View style={styles.chevron} />
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
        <Button label="New page" icon="＋" onPress={() => createDoc(null)} loading={creating} />
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
          <Button variant="destructive" label="Archive" onPress={() => archive(actionsDoc)} />
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

function EditorScreen({ doc, onBack }: { doc: Document; onBack: () => void }) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rt = await api.roomToken(doc.id);
        if (!cancelled) setToken(rt.token);
      } catch (e) {
        if (!cancelled) setError(friendly(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  if (error) {
    return (
      <View style={styles.flex}>
        <EditorTopbar title={doc.title} onBack={onBack} />
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
        </View>
      </View>
    );
  }

  if (!token) {
    return (
      <View style={styles.flex}>
        <EditorTopbar title={doc.title} onBack={onBack} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    );
  }

  return <ConnectedEditor doc={doc} token={token} onBack={onBack} />;
}

function ConnectedEditor({ doc, token, onBack }: { doc: Document; token: string; onBack: () => void }) {
  const connection = useMemo(
    () =>
      createDocConnection(doc.id, {
        serverUrl: getSettings().syncUrl,
        token,
        persistence: sqlitePersistence,
      }),
    [doc.id, token],
  );
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [status, setStatus] = useState<ConnectionStatus>(connection.status());
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [showAssist, setShowAssist] = useState(false);
  const editorRef = useRef<EditorHandle>(null);
  const toast = useToast();

  const share = async () => {
    try {
      const s = await api.createShare(doc.id, "rw");
      const origin = getSettings().apiUrl.replace(/\/api\/?$/, "");
      await Share.share({ message: `${origin}/shared/${s.id}` });
    } catch (e) {
      toast(friendly(e));
    }
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

  return (
    <View style={[styles.flex, { backgroundColor: colors.surface }]}>
      <EditorTopbar
        title={doc.title}
        onBack={onBack}
        status={status}
        onShare={share}
        onAssist={ai?.available ? () => setShowAssist(true) : undefined}
      />
      {offline ? (
        <Pressable style={styles.offlineBanner} onPress={() => connection.goOnline()}>
          <Text style={styles.offlineText}>Working offline — edits are saved on this device.</Text>
          <Text style={styles.offlineAction}>Reconnect</Text>
        </Pressable>
      ) : null}
      <WebViewEditor ref={editorRef} connection={connection} user={USER} />
      {showAssist && ai ? (
        <AssistDrawer
          status={ai}
          docId={doc.id}
          getText={() => editorRef.current?.getText() ?? Promise.resolve("")}
          onInsert={(text) => editorRef.current?.insert(text)}
          onClose={() => setShowAssist(false)}
        />
      ) : null}
    </View>
  );
}

function EditorTopbar({
  title,
  onBack,
  status,
  onAssist,
  onShare,
}: {
  title: string;
  onBack: () => void;
  status?: ConnectionStatus;
  onAssist?: () => void;
  onShare?: () => void;
}) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  return (
    <View style={styles.topbar}>
      <IconButton glyph="‹" label="Back to documents" onPress={onBack} />
      <Text style={[type.docTitle, styles.flex]} numberOfLines={1}>
        {title || "Untitled"}
      </Text>
      {onShare ? <IconButton glyph="↗" label="Share" onPress={onShare} /> : null}
      {onAssist ? <IconButton glyph="✦" label="AI Assist" onPress={onAssist} active /> : null}
      {status ? <StatusDot state={status} /> : null}
    </View>
  );
}

/* -------------------------------------------------------------- Settings --- */

function SettingsScreen({ onClose }: { onClose: () => void }) {
  const current = getSettings();
  const { mode, setMode, colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [syncUrl, setSyncUrl] = useState(current.syncUrl);
  const [apiUrl, setApiUrl] = useState(current.apiUrl);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await saveSettings({ syncUrl, apiUrl } as ServerSettings);
    setSaved(true);
    setTimeout(onClose, 400);
  };

  return (
    <Sheet title="Server" onClose={onClose}>
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

      <Button label={saved ? "Saved ✓" : "Save"} onPress={save} />
      <Text style={type.meta}>
        Defaults: {defaults.apiUrl} · {defaults.syncUrl}
      </Text>
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
  logout: { paddingHorizontal: spacing.sm },
  searchWrap: { paddingHorizontal: spacing.gutter, paddingVertical: spacing.md },
  segment: { flexDirection: "row", gap: spacing.sm },
  rowInner: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  chevron: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  chevronGlyph: { fontSize: 16, color: colors.inkSoft },
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
  fab: { position: "absolute", left: spacing.gutter, right: spacing.gutter, bottom: spacing.xxl, ...shadow.floating, borderRadius: radius.md },
});
