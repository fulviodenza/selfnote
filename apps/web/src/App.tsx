import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyUpdateBase64, createDocConnection, type ConnectionStatus } from "@selfnote/core";
import {
  CollaborativeEditor,
  createImporter,
  type EditorUser,
  type ExtractedLink,
  type LinkNoteDoc,
  type LinkNoteProvider,
} from "@selfnote/editor";
import {
  api,
  ensureWorkspace,
  isAuthed,
  type Document,
  type ResolvedShare,
  type ShareAnalytics,
  type AiStatus,
  type AiProposal,
} from "./api";
import { AssistPanel, type AiEditor } from "./AssistPanel";
import { HistoryPanel } from "./components/history/HistoryPanel";
import { NoteAiActions, type ActionEditor } from "./NoteAiActions";
import { AiProposalBanner, AiDiffPreview } from "./AiProposals";
import { BacklinksPanel } from "./BacklinksPanel";
import { GraphView } from "./GraphView";
import { importObsidianVault, type ImportProgress } from "./obsidian";
import { ConnectionsModal } from "./Connections";
import { TaskView } from "./TaskView";
import { TaskControls } from "./TaskControls";
import type { Task } from "./api";
import { syncUrl, needsOnboarding, saveServer, deriveFromBase } from "./server";

// Derived from the page origin in the browser; absolute when a server is configured.
const SYNC_URL = syncUrl();

const NAMES = ["Ada", "Linus", "Grace", "Alan", "Margaret", "Dennis", "Barbara", "Ken"];
const COLORS = ["#e11d48", "#7c3aed", "#0891b2", "#16a34a", "#ea580c", "#2563eb", "#db2777"];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const randomUser = (): EditorUser => ({
  name: `${pick(NAMES)} ${Math.floor(Math.random() * 90 + 10)}`,
  color: pick(COLORS),
});

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("selfnote_theme") as "light" | "dark") || "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("selfnote_theme", theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")) };
}

export function App() {
  const shared = window.location.pathname.match(/^\/shared\/([\w-]+)/);
  // Native (desktop) builds have no serving origin — ask which instance to use.
  if (needsOnboarding() && !shared) return <WebOnboarding />;
  return shared ? <SharedView shareId={shared[1]} /> : <AppRoot />;
}

function WebOnboarding() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${deriveFromBase(url).api}/healthz`);
      if (!res.ok) throw new Error();
      saveServer(url);
      window.location.reload();
    } catch {
      setError("Couldn’t reach that server. Check the address.");
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">selfnote</div>
        <div className="auth-sub">Connect to your Selfnote server to get started.</div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="selfnote.example.com"
          onKeyDown={(e) => e.key === "Enter" && connect()}
          autoFocus
        />
        {error && <div className="auth-err">{error}</div>}
        <button className="auth-submit" disabled={busy} onClick={connect}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <div className="auth-switch">We add /api and /ws automatically, and default to https.</div>
      </div>
    </div>
  );
}

/* ============================= authenticated app ============================= */

function AppRoot() {
  const user = useMemo(randomUser, []);
  const { theme, toggle: toggleTheme } = useTheme();

  const [booting, setBooting] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which surface fills the main pane: the editor for a page, the agenda, or
  // the workspace graph.
  const [view, setView] = useState<"editor" | "tasks" | "graph">("editor");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (wsId: string) => {
    const list = await api.listDocuments(wsId);
    setDocs(list);
    return list;
  }, []);

  const boot = useCallback(async () => {
    setBooting(true);
    setError(null);
    try {
      const wsId = await ensureWorkspace();
      setWorkspaceId(wsId);
      const list = await reload(wsId);
      // Honor a #doc-<id> deep link (e.g. the location a saved conversation
      // reports), otherwise fall back to the current or first page.
      const deepLink = window.location.hash.match(/#doc-([\w-]+)/)?.[1];
      const target = deepLink && list.some((d) => d.id === deepLink) ? deepLink : null;
      setActiveId((cur) => target ?? cur ?? list[0]?.id ?? null);
      setAuthed(true);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setAuthed(false);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBooting(false);
    }
  }, [reload]);

  useEffect(() => {
    (async () => {
      if (isAuthed() || (await api.restore())) await boot();
      else setBooting(false);
    })();
  }, [boot]);

  const createPage = async (parentId: string | null) => {
    if (!workspaceId) return;
    const doc = await api.createDocument(workspaceId, parentId, "Untitled");
    await reload(workspaceId);
    setView("editor");
    setActiveId(doc.id);
  };
  const rename = async (id: string, title: string) => {
    await api.updateDocument(id, { title: title.trim() || "Untitled" });
    if (workspaceId) await reload(workspaceId);
  };
  const archive = async (id: string) => {
    await api.updateDocument(id, { archived: true });
    if (workspaceId) {
      const list = await reload(workspaceId);
      if (activeId === id) setActiveId(list[0]?.id ?? null);
    }
  };
  const logout = () => {
    api.logout();
    setAuthed(false);
    setDocs([]);
    setActiveId(null);
    setWorkspaceId(null);
  };

  const [importing, setImporting] = useState<ImportProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const runImport = async (files: FileList | null) => {
    if (!files || files.length === 0 || !workspaceId) return;
    setImporting({ done: 0, total: 0, label: "Starting…" });
    try {
      await importObsidianVault(Array.from(files), workspaceId, setImporting);
      const list = await reload(workspaceId);
      setActiveId((cur) => cur ?? list[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Test hook (only when ?__e2e is present) so the import can be driven without
  // the native folder-picker dialog.
  useEffect(() => {
    if (window.location.search.includes("__e2e")) {
      const w = window as unknown as { __runImport?: typeof runImport; __createImporter?: typeof createImporter };
      w.__runImport = runImport;
      w.__createImporter = createImporter;
    }
  });

  const activeDoc = docs.find((d) => d.id === activeId) ?? null;
  const childPages = docs.filter((d) => d.parent_id === activeId);

  const handleAutoTitle = async (title: string) => {
    const d = docs.find((x) => x.id === activeId);
    if (!d || d.title !== "Untitled" || !title || title === d.title) return;
    await api.updateDocument(d.id, { title });
    if (workspaceId) await reload(workspaceId);
  };

  if (booting) return <div className="center-msg">Loading…</div>;
  if (!authed) return <LoginScreen onDone={boot} theme={theme} onToggleTheme={toggleTheme} />;
  if (error) {
    return (
      <div className="fatal">
        <b>Something went wrong.</b>
        <div>{error}</div>
      </div>
    );
  }

  return (
    <div className="layout">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => runImport(e.target.files)}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
      {importing && (
        <div className="import-overlay">
          <div className="import-card">
            <div className="import-title">Importing your vault…</div>
            <div className="import-label">{importing.label}</div>
            <div className="import-bar">
              <div
                className="import-fill"
                style={{
                  width: `${importing.total ? (importing.done / importing.total) * 100 : 5}%`,
                }}
              />
            </div>
            <div className="import-count">
              {importing.done} / {importing.total || "…"}
            </div>
          </div>
        </div>
      )}
      <Sidebar
        docs={docs}
        activeId={activeId}
        workspaceId={workspaceId}
        tasksActive={view === "tasks"}
        graphActive={view === "graph"}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpen={(id) => {
          setView("editor");
          setActiveId(id);
        }}
        onOpenTasks={() => setView("tasks")}
        onOpenGraph={() => setView("graph")}
        onCreate={createPage}
        onRename={rename}
        onArchive={archive}
        onLogout={logout}
        onImport={() => fileInputRef.current?.click()}
      />
      <main className="main">
        {view === "graph" && workspaceId ? (
          <GraphView
            workspaceId={workspaceId}
            activeId={activeId}
            onOpen={(id) => {
              setView("editor");
              setActiveId(id);
            }}
            onClose={() => setView("editor")}
          />
        ) : view === "tasks" && workspaceId ? (
          <TaskView
            workspaceId={workspaceId}
            onOpen={(id) => {
              setView("editor");
              setActiveId(id);
            }}
          />
        ) : activeId && activeDoc ? (
          <EditorPane
            key={activeId}
            doc={activeDoc}
            user={user}
            theme={theme}
            childPages={childPages}
            onOpenPage={(id) => {
              setView("editor");
              setActiveId(id);
            }}
            onAutoTitle={handleAutoTitle}
          />
        ) : (
          <div className="empty">
            <p>No page selected.</p>
            <button onClick={() => createPage(null)}>Create your first page</button>
          </div>
        )}
      </main>
    </div>
  );
}

/* ============================= login ============================= */

function LoginScreen({
  onDone,
  theme,
  onToggleTheme,
}: {
  onDone: () => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "register") await api.register(email.trim(), password);
      else await api.login(email.trim(), password);
      await onDone();
    } catch {
      setErr(
        mode === "register"
          ? "Couldn’t create the account (email may be taken, or password under 8 chars)."
          : "Invalid email or password.",
      );
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <button className="auth-theme icon-btn" onClick={onToggleTheme}>
        {theme === "light" ? "🌙" : "☀️"}
      </button>
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">selfnote</div>
        <div className="auth-sub">{mode === "login" ? "Welcome back" : "Create your account"}</div>
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          autoComplete="email"
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password (min 8 characters)"
          value={password}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {err && <div className="auth-err">{err}</div>}
        <button className="auth-submit" type="submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>
        <div className="auth-switch">
          {mode === "login" ? "No account?" : "Already have an account?"}{" "}
          <a
            onClick={() => {
              setErr(null);
              setMode(mode === "login" ? "register" : "login");
            }}
          >
            {mode === "login" ? "Sign up" : "Log in"}
          </a>
        </div>
      </form>
    </div>
  );
}

/* ============================= sidebar ============================= */

function Sidebar({
  docs,
  activeId,
  workspaceId,
  tasksActive,
  graphActive,
  theme,
  onToggleTheme,
  onOpen,
  onOpenTasks,
  onOpenGraph,
  onCreate,
  onRename,
  onArchive,
  onLogout,
  onImport,
}: {
  docs: Document[];
  activeId: string | null;
  workspaceId: string | null;
  tasksActive: boolean;
  graphActive: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpen: (id: string) => void;
  onOpenTasks: () => void;
  onOpenGraph: () => void;
  onCreate: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onLogout: () => void;
  onImport: () => void;
}) {
  const [showConnections, setShowConnections] = useState(false);
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, Document[]>();
    for (const d of docs) {
      const key = d.parent_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(d);
    }
    return map;
  }, [docs]);

  const renderTree = (parentId: string | null, depth: number): ReactNode =>
    (childrenOf.get(parentId) ?? []).map((d) => (
      <Row
        key={d.id}
        doc={d}
        depth={depth}
        active={d.id === activeId}
        hasChildren={(childrenOf.get(d.id) ?? []).length > 0}
        onOpen={onOpen}
        onCreate={onCreate}
        onRename={onRename}
        onArchive={onArchive}
      >
        {renderTree(d.id, depth + 1)}
      </Row>
    ));

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">selfnote</span>
        <div className="head-actions">
          <button
            className="icon-btn"
            title={theme === "light" ? "Switch to dark" : "Switch to light"}
            onClick={onToggleTheme}
          >
            {theme === "light" ? "🌙" : "☀️"}
          </button>
          <button className="icon-btn" title="New page" onClick={() => onCreate(null)}>
            ＋
          </button>
        </div>
      </div>
      <div className="sidebar-nav">
        <button
          className={tasksActive ? "nav-item active" : "nav-item"}
          onClick={onOpenTasks}
        >
          <span className="nav-item-icon">☑</span>
          Tasks
        </button>
        <button
          className={graphActive ? "nav-item active" : "nav-item"}
          onClick={onOpenGraph}
        >
          <span className="nav-item-icon">◈</span>
          Graph
        </button>
      </div>
      <div className="tree">
        {docs.length === 0 ? <div className="tree-empty">No pages yet</div> : renderTree(null, 0)}
      </div>
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={onImport}>
          ⬇ Import Obsidian vault
        </button>
        <button className="foot-btn" onClick={() => setShowConnections(true)}>
          ⚙ Connections
        </button>
        <button className="foot-btn" onClick={onLogout}>
          Log out
        </button>
      </div>
      {showConnections && (
        <ConnectionsModal
          workspaceId={workspaceId}
          onClose={() => setShowConnections(false)}
        />
      )}
    </aside>
  );
}

function Row({
  doc,
  depth,
  active,
  hasChildren,
  onOpen,
  onCreate,
  onRename,
  onArchive,
  children,
}: {
  doc: Document;
  depth: number;
  active: boolean;
  hasChildren: boolean;
  onOpen: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(doc.title);

  const commit = () => {
    setEditing(false);
    if (draft !== doc.title) onRename(doc.id, draft);
  };

  return (
    <>
      <div
        className={active ? "row active" : "row"}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => !editing && onOpen(doc.id)}
      >
        <span className="row-icon">{hasChildren ? "▾" : "•"}</span>
        {editing ? (
          <input
            className="row-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(doc.title);
                setEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="row-title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(doc.title);
              setEditing(true);
            }}
          >
            {doc.title || "Untitled"}
          </span>
        )}
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button title="Add subpage" onClick={() => onCreate(doc.id)}>
            ＋
          </button>
          <button title="Rename" onClick={() => (setDraft(doc.title), setEditing(true))}>
            ✎
          </button>
          <button title="Archive" onClick={() => onArchive(doc.id)}>
            ×
          </button>
        </span>
      </div>
      {children}
    </>
  );
}

/* ======================= share link analytics ======================= */

/** Human-friendly "N units ago" for an ISO timestamp; "Never" when null. */
function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Never";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.34524, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = secs;
  let unit = "second";
  for (const [size, name] of units) {
    if (value < size) {
      unit = name;
      break;
    }
    value = value / size;
    unit = name;
  }
  const rounded = Math.floor(value);
  if (unit === "second" && rounded < 5) return "just now";
  return `${rounded} ${unit}${rounded === 1 ? "" : "s"} ago`;
}

/**
 * The Share panel: lists a document's share links with per-link view count and
 * last-viewed time, lets the owner/editor copy a link's URL, and creates new
 * links. Counts are (re)fetched each time the panel is opened; no live polling.
 */
function ShareAnalyticsPanel({ docId }: { docId: string }) {
  const [shares, setShares] = useState<ShareAnalytics[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setShares(null);
    setErr(null);
    api
      .listShares(docId)
      .then((r) => !cancelled && setShares(r.shares))
      .catch(() => !cancelled && setErr("Couldn’t load share links."));
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const urlFor = (s: { id: string }) => `${window.location.origin}/shared/${s.id}`;

  const copy = async (s: ShareAnalytics) => {
    await navigator.clipboard?.writeText(urlFor(s)).catch(() => undefined);
    setCopiedId(s.id);
  };

  const create = async () => {
    setCreating(true);
    setErr(null);
    try {
      const s = await api.createShare(docId, "rw");
      const created: ShareAnalytics = {
        id: s.id,
        doc_id: s.doc_id,
        mode: s.mode,
        url: s.url,
        view_count: s.view_count ?? 0,
        last_viewed_at: s.last_viewed_at ?? null,
        expires_at: null,
        created_at: new Date().toISOString(),
      };
      setShares((prev) => [created, ...(prev ?? [])]);
      await navigator.clipboard?.writeText(urlFor(created)).catch(() => undefined);
      setCopiedId(created.id);
    } catch {
      setErr("Couldn’t create a share link.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="share-bar">
      <div className="share-panel">
        <div className="share-panel-head">
          <span className="share-label">Share links</span>
          <button onClick={create} disabled={creating}>
            {creating ? "Creating…" : "Create link"}
          </button>
        </div>
        {err && <div className="share-empty">{err}</div>}
        {shares == null && !err && <div className="share-empty">Loading…</div>}
        {shares != null && shares.length === 0 && !err && (
          <div className="share-empty">No share links yet.</div>
        )}
        {shares?.map((s) => (
          <div className="share-row" key={s.id}>
            <span className={`share-mode ${s.mode === "rw" ? "rw" : "ro"}`}>{s.mode}</span>
            <input
              className="share-url"
              readOnly
              value={urlFor(s)}
              onFocus={(e) => e.target.select()}
            />
            <span className="share-stats">
              <span className="share-stat" title="Total views">
                {s.view_count} view{s.view_count === 1 ? "" : "s"}
              </span>
              <span className="share-stat share-dim" title="Last viewed">
                {relativeTime(s.last_viewed_at)}
              </span>
            </span>
            <button onClick={() => copy(s)}>{copiedId === s.id ? "Copied" : "Copy"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================= editor pane ============================= */

// Theme-aware via the "Ink & Paper" CSS tokens (matches the mobile StatusDot).
const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connecting: "var(--warn)",
  connected: "var(--live)",
  disconnected: "var(--danger)",
  offline: "var(--muted)",
};

function EditorPane(props: {
  doc: Document;
  user: EditorUser;
  theme: "light" | "dark";
  childPages: Document[];
  onOpenPage: (id: string) => void;
  onAutoTitle: (title: string) => void;
}) {
  const { doc } = props;
  const [token, setToken] = useState<string | null>(null);
  // The caller's access to this room: `ro` (viewer) hides history write actions.
  const [mode, setMode] = useState<"rw" | "ro">("rw");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setToken(null);
    setErr(null);
    api
      .roomToken(doc.id)
      .then((r) => {
        if (cancelled) return;
        setMode(r.mode);
        setToken(r.token);
      })
      .catch(() => !cancelled && setErr("You don’t have access to this page."));
    // Record the view for recently-viewed suggestions (fire-and-forget).
    void api.markViewed(doc.id).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  if (err) return <div className="center-msg">{err}</div>;
  if (!token) return <div className="center-msg">Opening…</div>;
  return <EditorPaneInner {...props} token={token} mode={mode} />;
}

function EditorPaneInner({
  doc,
  token,
  mode,
  user,
  theme,
  childPages,
  onOpenPage,
  onAutoTitle,
}: {
  doc: Document;
  token: string;
  mode: "rw" | "ro";
  user: EditorUser;
  theme: "light" | "dark";
  childPages: Document[];
  onOpenPage: (id: string) => void;
  onAutoTitle: (title: string) => void;
}) {
  const connection = useMemo(
    () => createDocConnection(doc.id, { serverUrl: SYNC_URL, token }),
    [doc.id, token],
  );
  const [status, setStatus] = useState<ConnectionStatus>(connection.status());
  const [offline, setOffline] = useState(false);
  const [showShares, setShowShares] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [showAssist, setShowAssist] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editor, setEditor] = useState<AiEditor | null>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Staged AI edits: a monotonic key re-polls the banner; `reviewing` holds the
  // proposals shown in the diff drawer.
  const [proposalRefresh, setProposalRefresh] = useState(0);
  const [reviewing, setReviewing] = useState<AiProposal[] | null>(null);
  const bumpProposals = () => setProposalRefresh((n) => n + 1);
  // Task metadata for this document: `undefined` while loading, `null` if the
  // document is not a task, otherwise the Task.
  const [task, setTask] = useState<Task | null | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  // Transient toast for slash-command feedback (e.g. an AI 409/network error).
  const [editorToast, setEditorToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setEditorToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setEditorToast(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Outgoing note references: the editor reports the current `selfnote:<id>` set
  // on change; we debounce (~1s, same cadence as content persistence) and PUT
  // the authoritative set to `/documents/:id/links`. Bumping `backlinksRefresh`
  // re-fetches the panel so the "Outgoing links" subsection stays current.
  const [backlinksRefresh, setBacklinksRefresh] = useState(0);
  const linksTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLinks = useRef<ExtractedLink[] | null>(null);
  const flushLinks = useCallback(() => {
    const links = pendingLinks.current;
    if (links === null) return;
    pendingLinks.current = null;
    api
      .putDocLinks(doc.id, links)
      .then(() => setBacklinksRefresh((n) => n + 1))
      .catch(() => undefined);
  }, [doc.id]);
  const onLinksChange = useCallback(
    (links: ExtractedLink[]) => {
      pendingLinks.current = links;
      if (linksTimer.current) clearTimeout(linksTimer.current);
      linksTimer.current = setTimeout(flushLinks, 1000);
    },
    [flushLinks],
  );
  // Flush any pending link update when leaving the document.
  useEffect(
    () => () => {
      if (linksTimer.current) {
        clearTimeout(linksTimer.current);
        flushLinks();
      }
    },
    [flushLinks],
  );

  // Note-picker data source for `/link-note` and the `[[` / `@` triggers:
  // recents (GET /documents) and title search via the link-search endpoint
  // (GET /documents/link-search), scoped to this workspace and excluding the
  // doc being edited. Membership is enforced server-side.
  const linkNoteProvider = useMemo<LinkNoteProvider>(() => {
    const toLinkDoc = (d: Document): LinkNoteDoc => ({
      id: d.id,
      title: d.title,
      icon: d.icon,
      updated_at: d.updated_at,
    });
    return {
      recents: () =>
        api
          .listDocuments(doc.workspace_id)
          .then((ds) => ds.filter((d) => d.id !== doc.id).map(toLinkDoc)),
      search: (q) =>
        api.linkSearch(doc.workspace_id, q, doc.id).then((rs) =>
          // link-search returns DocumentRef (no updated_at); recents ordering
          // is server-side, so a placeholder timestamp is fine here.
          rs.map((r) => ({ id: r.id, title: r.title, icon: r.icon, updated_at: "" })),
        ),
    };
  }, [doc.workspace_id, doc.id]);

  // `/ai-summarize` runner — POST /ai/complete with intent "summarize".
  const summarize = useCallback(
    (context: string) =>
      api
        .aiComplete({ doc_id: doc.id, intent: "summarize", context })
        .then((r) => r.text),
    [doc.id],
  );

  useEffect(() => {
    const off = connection.onStatus(setStatus);
    return () => {
      off();
      connection.destroy();
    };
  }, [connection]);

  // One-shot: does this server have an AI backend? (Silently false if not.)
  useEffect(() => {
    let alive = true;
    api.aiStatus().then((s) => alive && setAi(s));
    return () => {
      alive = false;
    };
  }, []);

  // Load this document's task metadata (404 = not a task).
  useEffect(() => {
    let alive = true;
    setTask(undefined);
    api
      .getTask(doc.id)
      .then((t) => alive && setTask(t))
      .catch(() => alive && setTask(null));
    return () => {
      alive = false;
    };
  }, [doc.id]);

  const removeTask = async () => {
    setMenuOpen(false);
    await api.deleteTask(doc.id).catch(() => undefined);
    setTask(null);
  };

  const onFirstHeadingChange = (text: string) => {
    if (doc.title !== "Untitled") return;
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => onAutoTitle(text), 600);
  };

  const toggleOffline = () => {
    if (offline) connection.goOnline();
    else connection.goOffline();
    setOffline(!offline);
  };

  // Apply a version-history restore update to the live doc so this client
  // converges immediately; every other client receives it over the sync socket.
  const applyRestore = useCallback(
    (update: string) => {
      try {
        applyUpdateBase64(connection.doc, update);
      } catch {
        /* the server also broadcasts the update over sync; ignore local decode */
      }
    },
    [connection],
  );

  // Keyboard shortcut: ⌘/Ctrl+⇧+H opens Version history (mirrors the header item).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "h" || e.key === "H")) {
        e.preventDefault();
        setShowHistory((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="editor-pane">
      <div className="topbar">
        <span className="user" style={{ color: user.color }}>
          ● {user.name}
        </span>
        <span className="status">
          <span className="dot" style={{ background: STATUS_COLOR[status] }} />
          {offline ? "Offline" : status}
        </span>
        <div className="topbar-right">
          {ai?.available && (
            <NoteAiActions editor={editor as unknown as ActionEditor | null} docId={doc.id} />
          )}
          {ai?.available && (
            <button
              className={showAssist ? "toggle on" : "toggle"}
              onClick={() => setShowAssist((v) => !v)}
            >
              ✦ Assist
            </button>
          )}
          <button
            className={showHistory ? "toggle on" : "toggle"}
            title="Version history (⌘⇧H)"
            onClick={() => setShowHistory((v) => !v)}
          >
            🕑 History
          </button>
          <button
            className={showShares ? "toggle on" : "toggle"}
            onClick={() => setShowShares((v) => !v)}
          >
            Share
          </button>
          <button className={offline ? "toggle on" : "toggle"} onClick={toggleOffline}>
            {offline ? "Go online" : "Simulate offline"}
          </button>
          {task && (
            <div className="page-menu">
              <button
                className="toggle"
                title="Page menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                ⋯
              </button>
              {menuOpen && (
                <>
                  <div className="page-menu-scrim" onClick={() => setMenuOpen(false)} />
                  <div className="page-menu-pop">
                    <button className="page-menu-item danger" onClick={removeTask}>
                      Remove task
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {task !== undefined && (
        <TaskControls docId={doc.id} task={task} onChange={setTask} />
      )}

      {showShares && <ShareAnalyticsPanel docId={doc.id} />}

      <AiProposalBanner
        docId={doc.id}
        refreshKey={proposalRefresh}
        onReview={(proposals) => setReviewing(proposals)}
      />

      <div className="editor-body">
        <div
          className="editor-scroll"
          onClickCapture={(e) => {
            const a = (e.target as HTMLElement).closest("a");
            // Note references use the `selfnote:<id>` scheme — intercept them so
            // they route in-app instead of the browser/OS opening the URL.
            const m = a?.getAttribute("href")?.match(/^selfnote:([\w-]+)$/);
            if (m) {
              e.preventDefault();
              e.stopPropagation();
              onOpenPage(m[1]);
            }
          }}
        >
          <CollaborativeEditor
            connection={connection}
            user={user}
            theme={theme}
            onFirstHeadingChange={onFirstHeadingChange}
            onEditorReady={(e) => setEditor(e as unknown as AiEditor)}
            linkNoteProvider={linkNoteProvider}
            onNavigateToDoc={onOpenPage}
            onLinksChange={onLinksChange}
            aiFeatures={ai?.features}
            summarize={ai?.available ? summarize : undefined}
            onError={showToast}
          />
          {editorToast && <div className="editor-toast">{editorToast}</div>}
          {childPages.length > 0 && (
            <div className="subpages">
              <div className="subpages-title">Sub-pages</div>
              {childPages.map((c) => (
                <button key={c.id} className="subpage-link" onClick={() => onOpenPage(c.id)}>
                  <span className="subpage-icon">📄</span>
                  {c.title || "Untitled"}
                </button>
              ))}
            </div>
          )}
          <BacklinksPanel docId={doc.id} refreshKey={backlinksRefresh} onOpen={onOpenPage} />
        </div>
        {showAssist && ai && (
          <AssistPanel
            editor={editor}
            status={ai}
            docId={doc.id}
            workspaceId={doc.workspace_id}
            onClose={() => setShowAssist(false)}
            onStaged={(proposal) => {
              bumpProposals();
              setReviewing([proposal]);
            }}
          />
        )}
        {showHistory && (
          <HistoryPanel
            docId={doc.id}
            theme={theme}
            canWrite={mode === "rw"}
            onClose={() => setShowHistory(false)}
            onRestored={applyRestore}
          />
        )}
      </div>

      {reviewing && (
        <AiDiffPreview
          proposals={reviewing}
          onClose={() => setReviewing(null)}
          onResolved={bumpProposals}
        />
      )}
    </div>
  );
}

/* ============================= public shared view ============================= */

function SharedView({ shareId }: { shareId: string }) {
  const user = useMemo(randomUser, []);
  const { theme, toggle } = useTheme();
  const [share, setShare] = useState<ResolvedShare | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .resolveShare(shareId)
      .then(setShare)
      .catch(() => setFailed(true));
  }, [shareId]);

  if (failed) return <div className="center-msg">This link is invalid or has expired.</div>;
  if (!share) return <div className="center-msg">Opening shared page…</div>;
  return <SharedEditor share={share} user={user} theme={theme} onToggleTheme={toggle} />;
}

function SharedEditor({
  share,
  user,
  theme,
  onToggleTheme,
}: {
  share: ResolvedShare;
  user: EditorUser;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const connection = useMemo(
    () => createDocConnection(share.doc_id, { serverUrl: SYNC_URL, token: share.token }),
    [share.doc_id, share.token],
  );
  useEffect(() => () => connection.destroy(), [connection]);
  const editable = share.mode === "rw";

  return (
    <div className="shared-view">
      <div className="shared-bar">
        <span className="brand">selfnote</span>
        <span className="shared-tag">Shared page · {editable ? "editable" : "read-only"}</span>
        <button className="icon-btn" onClick={onToggleTheme}>
          {theme === "light" ? "🌙" : "☀️"}
        </button>
      </div>
      <div className="editor-scroll">
        <CollaborativeEditor
          connection={connection}
          user={user}
          theme={theme}
          editable={editable}
        />
      </div>
    </div>
  );
}
