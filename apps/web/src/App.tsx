import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createDocConnection, type ConnectionStatus } from "@selfnote/core";
import { CollaborativeEditor, createImporter, type EditorUser } from "@selfnote/editor";
import { api, ensureWorkspace, isAuthed, type Document, type ResolvedShare, type AiStatus } from "./api";
import { AssistPanel, type AiEditor } from "./AssistPanel";
import { importObsidianVault, type ImportProgress } from "./obsidian";
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
      setActiveId((cur) => cur ?? list[0]?.id ?? null);
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
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpen={setActiveId}
        onCreate={createPage}
        onRename={rename}
        onArchive={archive}
        onLogout={logout}
        onImport={() => fileInputRef.current?.click()}
      />
      <main className="main">
        {activeId && activeDoc ? (
          <EditorPane
            key={activeId}
            doc={activeDoc}
            user={user}
            theme={theme}
            childPages={childPages}
            onOpenPage={setActiveId}
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
  theme,
  onToggleTheme,
  onOpen,
  onCreate,
  onRename,
  onArchive,
  onLogout,
  onImport,
}: {
  docs: Document[];
  activeId: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpen: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onLogout: () => void;
  onImport: () => void;
}) {
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
      <div className="tree">
        {docs.length === 0 ? <div className="tree-empty">No pages yet</div> : renderTree(null, 0)}
      </div>
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={onImport}>
          ⬇ Import Obsidian vault
        </button>
        <button className="foot-btn" onClick={onLogout}>
          Log out
        </button>
      </div>
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
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setToken(null);
    setErr(null);
    api
      .roomToken(doc.id)
      .then((r) => !cancelled && setToken(r.token))
      .catch(() => !cancelled && setErr("You don’t have access to this page."));
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  if (err) return <div className="center-msg">{err}</div>;
  if (!token) return <div className="center-msg">Opening…</div>;
  return <EditorPaneInner {...props} token={token} />;
}

function EditorPaneInner({
  doc,
  token,
  user,
  theme,
  childPages,
  onOpenPage,
  onAutoTitle,
}: {
  doc: Document;
  token: string;
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
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [showAssist, setShowAssist] = useState(false);
  const [editor, setEditor] = useState<AiEditor | null>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const share = async () => {
    const s = await api.createShare(doc.id, "rw");
    setShareUrl(`${window.location.origin}/shared/${s.id}`);
    setCopied(false);
  };
  const copy = async () => {
    if (!shareUrl) return;
    await navigator.clipboard?.writeText(shareUrl).catch(() => undefined);
    setCopied(true);
  };

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
            <button
              className={showAssist ? "toggle on" : "toggle"}
              onClick={() => setShowAssist((v) => !v)}
            >
              ✦ Assist
            </button>
          )}
          <button className="toggle" onClick={share}>
            Share
          </button>
          <button className={offline ? "toggle on" : "toggle"} onClick={toggleOffline}>
            {offline ? "Go online" : "Simulate offline"}
          </button>
        </div>
      </div>

      {shareUrl && (
        <div className="share-bar">
          <span className="share-label">Anyone with this link can edit:</span>
          <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
          <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      )}

      <div className="editor-body">
        <div
          className="editor-scroll"
          onClickCapture={(e) => {
            const a = (e.target as HTMLElement).closest("a");
            const m = a?.getAttribute("href")?.match(/#doc-([\w-]+)/);
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
          />
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
        </div>
        {showAssist && ai && (
          <AssistPanel
            editor={editor}
            status={ai}
            docId={doc.id}
            onClose={() => setShowAssist(false)}
          />
        )}
      </div>
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
