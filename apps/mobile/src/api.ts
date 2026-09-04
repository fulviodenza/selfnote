/**
 * Typed Selfnote API client for React Native.
 *
 * Mirrors apps/web/src/api.ts, but:
 *  - the base URL is read at call time from runtime Settings (src/settings.ts),
 *    so the app can point at any self-hosted instance without a rebuild;
 *  - tokens are persisted in AsyncStorage instead of localStorage.
 *
 * Auth is bearer-token based: login/register return both an access and a refresh
 * token in the response body; the access token is sent as `Authorization: Bearer`,
 * and a 401 triggers one refresh-and-retry.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getSettings } from "./settings";

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
}

export interface Workspace {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
}

export interface Document {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoomToken {
  token: string;
  doc_id: string;
  mode: "rw" | "ro";
  expires_in: number;
}

/** A recently-viewed note, newest first (GET /documents/recent). */
export interface RecentDocument {
  id: string;
  workspace_id: string;
  title: string;
  icon: string | null;
  viewed_at: string;
}

/* ---- Backlinks & graph (docs/features/backlinks-graph.md) ---- */

/** Minimal document descriptor reused across backlinks/graph responses. */
export interface DocumentRef {
  id: string;
  title: string;
  icon: string | null;
  parent_id: string | null;
}

/** One outgoing link edge (GET /documents/:id/links). */
export interface OutgoingLink {
  target: DocumentRef;
  label: string | null;
}

/** One backlink — a note that links here (GET /documents/:id/backlinks). */
export interface Backlink {
  source: DocumentRef;
  label: string | null;
}

/** The set of outgoing links reported by the editor (PUT /documents/:id/links). */
export interface OutgoingLinkInput {
  target_id: string;
  label: string | null;
}

/** An edge in the workspace graph (GET /workspaces/:id/graph). */
export interface GraphEdge {
  source: string;
  target: string;
  kind: "link" | "tree";
}

/** The workspace graph payload (GET /workspaces/:id/graph). */
export interface WorkspaceGraph {
  nodes: DocumentRef[];
  edges: GraphEdge[];
}

/**
 * A staged AI edit (GET/POST /ai/proposals). An AI write — MCP update_note /
 * append_to_note, or an in-app "insert into note" — is recorded as a pending
 * proposal instead of being applied; a human accepts or rejects it after
 * reviewing the before/after Markdown. See docs/features/ai-edit-diff-preview.md.
 */
export interface AiProposal {
  id: string;
  document_id: string;
  workspace_id: string;
  op: "append" | "replace";
  origin: string; // "mcp" | "app"
  summary: string;
  status: "pending" | "applied" | "rejected" | "superseded";
  before_md: string;
  after_md: string;
  created_by: string;
  created_at: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
  /** Only present on GET /ai/proposals/:id — exposed for debugging/optimistic apply. */
  diff_base64?: string;
  base_sv?: string;
}

/** Body for POST /ai/proposals (the staged write). */
export interface CreateAiProposal {
  document_id: string;
  op: "append" | "replace";
  markdown: string;
  origin?: "mcp" | "app";
  summary?: string;
}

/** Result of accept/reject (POST /ai/proposals/:id/accept|reject). */
export interface AiProposalResolution {
  id: string;
  status: "applied" | "rejected" | "superseded";
  resolved_at: string;
  resolved_by: string;
}

export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "none" | "low" | "medium" | "high";

/**
 * Task metadata attached to a document (a document is a task iff this row
 * exists). `title`/`icon` are mirrored read-only from the document. See
 * docs/features/calendar-task-sync.md.
 */
export interface Task {
  doc_id: string;
  workspace_id: string;
  title: string;
  icon: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  due_all_day: boolean;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Body for POST /documents/:id/task (promote/upsert) — all fields optional. */
export interface SetTaskBody {
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: string | null;
  due_all_day?: boolean;
}

/** Body for PATCH /documents/:id/task — only present keys change. */
export interface UpdateTaskBody {
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: string | null;
  due_all_day?: boolean;
}

/** Query params for GET /tasks (agenda). `workspace_id` is required. */
export interface ListTasksParams {
  workspace_id: string;
  status?: TaskStatus[];
  due_before?: string;
  due_after?: string;
  include_undated?: boolean;
  sort?: "due_at" | "priority" | "created_at";
  limit?: number;
}

/** GET /workspaces/:id/calendar-feed — reports whether a feed exists. */
export interface CalendarFeedInfo {
  enabled: boolean;
  url?: string;
  created_at?: string;
  last_used_at?: string | null;
}

/** POST /workspaces/:id/calendar-feed — the one-time plaintext token + URL. */
export interface CalendarFeedIssued {
  token: string;
  url: string;
}

/* ---- Version history / time-travel (docs/features/version-history.md) ---- */

/** The kind of a checkpoint: manual "Save version", periodic/on-drop auto, or the pre-restore capture. */
export type CheckpointKind = "manual" | "auto" | "restore";

/**
 * A version-history checkpoint — an immutable point-in-time snapshot of a doc's
 * CRDT state. `created_by`/`created_by_name` are null for `auto` checkpoints.
 * List/get item (GET /documents/:id/history, POST /documents/:id/history).
 */
export interface Checkpoint {
  id: string;
  doc_id: string;
  kind: CheckpointKind;
  label: string | null;
  size_bytes: number;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

/** Query params for GET /documents/:id/history — all optional. */
export interface ListHistoryParams {
  limit?: number;
  before?: string;
  kind?: CheckpointKind;
}

/** A page of history (GET /documents/:id/history). `next_before` is null on the last page. */
export interface HistoryPage {
  checkpoints: Checkpoint[];
  next_before: string | null;
}

/**
 * A checkpoint plus its full state (GET /documents/:id/history/:checkpoint_id).
 * `updates` is an ordered list of base64 v1 Yjs updates — for a checkpoint always
 * exactly one element, the full merged snapshot (same shape as GET …/content).
 */
export interface CheckpointDetail extends Checkpoint {
  updates: string[];
}

/** Result of POST /documents/:id/history/:checkpoint_id/restore. */
export interface RestoreResult {
  restored_from: string;
  pre_restore_checkpoint: string;
  /** The base64 v1 Yjs update appended to the log — apply it live to converge immediately. */
  update: string;
}

const ACCESS_KEY = "selfnote.access";
const REFRESH_KEY = "selfnote.refresh";

let accessToken: string | null = null;
let refreshToken: string | null = null;

/** Rehydrate tokens from storage into memory. Call once on app boot. */
export async function loadSession(): Promise<void> {
  [accessToken, refreshToken] = await Promise.all([
    AsyncStorage.getItem(ACCESS_KEY),
    AsyncStorage.getItem(REFRESH_KEY),
  ]);
}

async function persist(auth: AuthResponse) {
  accessToken = auth.access_token;
  refreshToken = auth.refresh_token;
  await Promise.all([
    AsyncStorage.setItem(ACCESS_KEY, auth.access_token),
    AsyncStorage.setItem(REFRESH_KEY, auth.refresh_token),
  ]);
}

export async function clearSession(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  await Promise.all([AsyncStorage.removeItem(ACCESS_KEY), AsyncStorage.removeItem(REFRESH_KEY)]);
}

export const isAuthed = () => !!accessToken;

async function raw<T>(path: string, options: RequestInit = {}, auth = true): Promise<T> {
  const res = await fetch(`${getSettings().apiUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(body || `HTTP ${res.status}`), { status: res.status });
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Authed request with one automatic refresh-and-retry on 401. */
async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    return await raw<T>(path, options);
  } catch (e) {
    if ((e as { status?: number }).status === 401 && (await tryRefresh())) {
      return await raw<T>(path, options);
    }
    throw e;
  }
}

async function tryRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const auth = await raw<AuthResponse>(
      "/auth/refresh",
      { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) },
      false,
    );
    await persist(auth);
    return true;
  } catch {
    await clearSession();
    return false;
  }
}

export const api = {
  register: async (email: string, password: string) => {
    await persist(
      await raw<AuthResponse>(
        "/auth/register",
        { method: "POST", body: JSON.stringify({ email, password }) },
        false,
      ),
    );
  },
  login: async (email: string, password: string) => {
    await persist(
      await raw<AuthResponse>(
        "/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
        false,
      ),
    );
  },
  /** Restore a session from the stored refresh token. */
  restore: () => tryRefresh(),
  logout: clearSession,

  listWorkspaces: () => req<Workspace[]>("/workspaces"),
  createWorkspace: (name: string) =>
    req<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),

  listDocuments: (workspaceId: string) =>
    req<Document[]>(`/documents?workspace_id=${encodeURIComponent(workspaceId)}`),
  createDocument: (workspaceId: string, parentId: string | null, title: string) =>
    req<Document>("/documents", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, parent_id: parentId, title }),
    }),
  updateDocument: (
    id: string,
    patch: Partial<{ title: string; parent_id: string | null; archived: boolean }>,
  ) => req<Document>(`/documents/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  roomToken: (docId: string) =>
    req<RoomToken>(`/documents/${docId}/room-token`, { method: "POST" }),

  /** Full-text search over document titles within a workspace. */
  searchDocuments: (workspaceId: string, q: string) =>
    req<Document[]>(
      `/documents/search?workspace_id=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(q)}`,
    ),

  /** Record that the caller opened a note (fire-and-forget on open). */
  markViewed: (docId: string) =>
    req<{ ok: boolean }>(`/documents/${docId}/viewed`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /** The caller's recently-viewed, non-archived notes, newest first. */
  recentDocuments: (limit?: number) =>
    req<{ documents: RecentDocument[] }>(
      `/documents/recent${limit != null ? `?limit=${limit}` : ""}`,
    ).then((r) => r.documents),

  /* ---- Backlinks & graph (docs/features/backlinks-graph.md) ---- */

  /** The current outgoing links of a note (archived targets excluded). */
  getDocLinks: (docId: string) =>
    req<{ outgoing: OutgoingLink[] }>(`/documents/${docId}/links`).then((r) => r.outgoing),

  /**
   * Full-replace a note's outgoing links from the editor's extracted set.
   * Self-links and cross-workspace targets are dropped server-side; returns the
   * number of edges stored after dedupe/filtering.
   */
  putDocLinks: (docId: string, links: OutgoingLinkInput[]) =>
    req<{ source_id: string; count: number }>(`/documents/${docId}/links`, {
      method: "PUT",
      body: JSON.stringify({ links }),
    }).then((r) => r.count),

  /** Notes that link to this one ("linked references"), archived sources excluded. */
  getBacklinks: (docId: string) =>
    req<{ backlinks: Backlink[] }>(`/documents/${docId}/backlinks`).then((r) => r.backlinks),

  /** The full workspace graph: non-archived nodes plus link + tree edges. */
  getGraph: (workspaceId: string) => req<WorkspaceGraph>(`/workspaces/${workspaceId}/graph`),

  /** Resolve link targets by title for the "@ / [[" picker (limit 20). */
  linkSearch: (workspaceId: string, q: string, exclude?: string) => {
    const qs = new URLSearchParams({ workspace_id: workspaceId, q });
    if (exclude) qs.set("exclude", exclude);
    return req<{ results: DocumentRef[] }>(`/documents/link-search?${qs.toString()}`).then(
      (r) => r.results,
    );
  },

  createShare: (docId: string, mode: "rw" | "ro") =>
    req<ShareInfo>(`/documents/${docId}/shares`, { method: "POST", body: JSON.stringify({ mode }) }),

  /* ---- Share link analytics (docs/features/share-analytics.md) ---- */

  /** List a document's share links with analytics, newest-first (owner/editor). */
  listShares: (docId: string) =>
    req<{ shares: ShareAnalytics[] }>(`/documents/${docId}/shares`),

  /** Analytics for a single share link (owner/editor of its workspace). */
  shareAnalytics: (shareId: string) =>
    req<ShareAnalytics>(`/shares/${shareId}/analytics`),

  /** AI backend status. Treats a missing endpoint (older server) as unavailable. */
  aiStatus: async (): Promise<AiStatus> => {
    try {
      return await req<AiStatus>("/ai/status");
    } catch {
      return { available: false, provider: null, model: null, features: [] };
    }
  },
  aiComplete: (body: {
    doc_id?: string;
    intent: string;
    prompt?: string;
    selection?: string;
    context?: string;
  }) => req<AiComplete>("/ai/complete", { method: "POST", body: JSON.stringify(body) }),

  /** Multi-turn chat, non-streaming (fallback). */
  aiChat: (body: ChatRequest) =>
    req<AiComplete>("/ai/chat", { method: "POST", body: JSON.stringify(body) }),

  /* ---- Note-level AI actions (docs/features/note-level-ai-actions.md) ---- */

  /** Run a note action non-streaming (fallback path). Returns the result Markdown. */
  aiAction: (body: AiActionRequest) =>
    req<AiComplete>("/ai/action", { method: "POST", body: JSON.stringify(body) }),

  /** Read the caller's writing-voice profile (used by "Rewrite in my voice"). */
  getVoice: () => req<VoiceProfile>("/ai/voice"),

  /** Set/replace the caller's writing-voice sample (server caps at 8000 chars). */
  setVoice: (sample: string) =>
    req<VoiceProfile>("/ai/voice", { method: "PUT", body: JSON.stringify({ sample }) }),

  /**
   * Stage an AI edit as a pending proposal instead of writing the CRDT directly.
   * In-app "insert into note" uses `origin: "app"`; the diff is applied only when
   * a human accepts it. Returns the created (pending) proposal.
   */
  createAiProposal: (body: CreateAiProposal) =>
    req<AiProposal>("/ai/proposals", { method: "POST", body: JSON.stringify(body) }),

  /** List proposals, newest first. Defaults to pending for the given document. */
  listAiProposals: (documentId?: string, status: string = "pending") => {
    const qs = new URLSearchParams();
    if (documentId) qs.set("document_id", documentId);
    if (status) qs.set("status", status);
    const q = qs.toString();
    return req<AiProposal[]>(`/ai/proposals${q ? `?${q}` : ""}`);
  },

  /** Full proposal payload including before_md/after_md and the staged diff. */
  getAiProposal: (id: string) => req<AiProposal>(`/ai/proposals/${id}`),

  /** Apply a pending proposal (human gate — JWT only). */
  acceptAiProposal: (id: string) =>
    req<AiProposalResolution>(`/ai/proposals/${id}/accept`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /** Discard a pending proposal (JWT only). */
  rejectAiProposal: (id: string) =>
    req<AiProposalResolution>(`/ai/proposals/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /* ---- Tasks (docs/features/calendar-task-sync.md) ---- */

  /** Read a document's task metadata (404 if it isn't a task). */
  getTask: (docId: string) => req<Task>(`/documents/${docId}/task`),

  /** Promote a document to a task / upsert its metadata (member, non-viewer). */
  setTask: (docId: string, body: SetTaskBody) =>
    req<Task>(`/documents/${docId}/task`, { method: "POST", body: JSON.stringify(body) }),

  /** Patch a task; only present keys change. Explicit `due_at: null` clears it. */
  updateTask: (docId: string, patch: UpdateTaskBody) =>
    req<Task>(`/documents/${docId}/task`, { method: "PATCH", body: JSON.stringify(patch) }),

  /** Demote — remove task metadata (204, idempotent). The document is untouched. */
  deleteTask: (docId: string) => req<void>(`/documents/${docId}/task`, { method: "DELETE" }),

  /** Agenda query. Scoped to `workspace_id`; see the doc for filter semantics. */
  listTasks: (params: ListTasksParams) => {
    const qs = new URLSearchParams();
    qs.set("workspace_id", params.workspace_id);
    if (params.status && params.status.length) qs.set("status", params.status.join(","));
    if (params.due_before) qs.set("due_before", params.due_before);
    if (params.due_after) qs.set("due_after", params.due_after);
    if (params.include_undated != null) qs.set("include_undated", String(params.include_undated));
    if (params.sort) qs.set("sort", params.sort);
    if (params.limit != null) qs.set("limit", String(params.limit));
    return req<{ tasks: Task[] }>(`/tasks?${qs.toString()}`).then((r) => r.tasks);
  },

  /* ---- Calendar feed ---- */

  /** Whether an ICS feed exists for this workspace (never returns the token). */
  getCalendarFeed: (workspaceId: string) =>
    req<CalendarFeedInfo>(`/workspaces/${workspaceId}/calendar-feed`),

  /** Issue/rotate the ICS feed; returns the one-time `cal_…` token + URL. */
  issueCalendarFeed: (workspaceId: string) =>
    req<CalendarFeedIssued>(`/workspaces/${workspaceId}/calendar-feed`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /** Revoke all feed tokens for this workspace+user (204). */
  revokeCalendarFeed: (workspaceId: string) =>
    req<void>(`/workspaces/${workspaceId}/calendar-feed`, { method: "DELETE" }),

  /* ---- Version history / time-travel (docs/features/version-history.md) ---- */

  /**
   * List a document's checkpoints, newest-first (any member incl. viewer).
   * `before` (RFC3339) paginates; page with the returned `next_before` until null.
   */
  listHistory: (docId: string, params: ListHistoryParams = {}) => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.before) qs.set("before", params.before);
    if (params.kind) qs.set("kind", params.kind);
    const q = qs.toString();
    return req<HistoryPage>(`/documents/${docId}/history${q ? `?${q}` : ""}`);
  },

  /** Fetch a checkpoint's metadata + its full base64 Yjs state (any member). */
  getCheckpoint: (docId: string, checkpointId: string) =>
    req<CheckpointDetail>(`/documents/${docId}/history/${checkpointId}`),

  /**
   * Capture the doc's current merged state as a manual checkpoint (member,
   * non-viewer). `label` optional (max 200 chars; trimmed empty → null).
   */
  createCheckpoint: (docId: string, label?: string | null) =>
    req<Checkpoint>(`/documents/${docId}/history`, {
      method: "POST",
      body: JSON.stringify({ label: label ?? null }),
    }),

  /**
   * Restore a checkpoint (member, non-viewer). Captures the pre-restore state as
   * a `kind='restore'` checkpoint, then appends a forward update to the log so all
   * clients converge; returns that `update` for immediate local apply.
   */
  restoreCheckpoint: (docId: string, checkpointId: string, label?: string | null) =>
    req<RestoreResult>(`/documents/${docId}/history/${checkpointId}/restore`, {
      method: "POST",
      body: JSON.stringify(label != null ? { label } : {}),
    }),

  /** Delete a checkpoint row (member, non-viewer); does not touch content (204). */
  deleteCheckpoint: (docId: string, checkpointId: string) =>
    req<void>(`/documents/${docId}/history/${checkpointId}`, { method: "DELETE" }),
};

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Where a context note came from — advisory, used for prompt labeling. */
export type ExtraDocSource = "linked" | "recent" | "manual";

/**
 * An additional note folded into the chat's grounding context. The client sends
 * the note body as Markdown (rendered from Yjs, exactly like `context`); the
 * server authorizes each `doc_id` and injects the text under "Related notes".
 */
export interface ExtraDoc {
  doc_id: string;
  title?: string;
  text: string;
  source?: ExtraDocSource;
}

export interface ChatRequest {
  doc_id?: string;
  messages: ChatMessage[];
  context?: string;
  selection?: string;
  extra_docs?: ExtraDoc[];
}
export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}
export interface ChatStreamHandle {
  abort: () => void;
}

/**
 * Stream a POST SSE endpoint via XMLHttpRequest — React Native's fetch can't
 * expose an incremental response body, but XHR's growing `responseText` can be
 * parsed as SSE frames arrive. Both /ai/chat/stream and /ai/action/stream share
 * the identical `{delta}` / `event: done` / `event: error` wire format, so this
 * helper is reused for both. Refreshes the access token once on a 401.
 */
function streamSse(path: string, body: unknown, handlers: ChatStreamHandlers): ChatStreamHandle {
  let xhr: XMLHttpRequest | null = null;
  let aborted = false;
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      handlers.onDone?.();
    }
  };

  const start = (allowRefresh: boolean) => {
    const x = new XMLHttpRequest();
    xhr = x;
    x.open("POST", `${getSettings().apiUrl}${path}`);
    x.setRequestHeader("content-type", "application/json");
    if (accessToken) x.setRequestHeader("authorization", `Bearer ${accessToken}`);

    let offset = 0;
    let buf = "";
    let refreshing = false;

    const parse = () => {
      const text = x.responseText;
      if (text.length <= offset) return;
      buf += text.slice(offset);
      offset = text.length;
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        const data = dataLines.join("\n");
        if (event === "error") {
          try {
            handlers.onError?.(JSON.parse(data).error ?? "Assist failed.");
          } catch {
            handlers.onError?.("Assist failed.");
          }
        } else if (event !== "done") {
          try {
            const j = JSON.parse(data) as { delta?: string };
            if (typeof j.delta === "string") handlers.onDelta(j.delta);
          } catch {
            /* keep-alive or partial frame */
          }
        }
      }
    };

    x.onreadystatechange = () => {
      if (x.readyState === 2 && x.status === 401 && allowRefresh) {
        refreshing = true;
        x.abort();
        void tryRefresh().then((ok) => {
          if (aborted) return;
          if (ok) start(false);
          else handlers.onError?.("Session expired. Please sign in again.");
        });
      }
    };
    x.onprogress = () => {
      if (!refreshing) parse();
    };
    x.onload = () => {
      if (!refreshing) {
        parse();
        finish();
      }
    };
    x.onerror = () => {
      if (!refreshing && !aborted) {
        handlers.onError?.("Network error.");
        finish();
      }
    };
    x.send(JSON.stringify(body));
  };

  start(true);
  return {
    abort: () => {
      aborted = true;
      done = true;
      xhr?.abort();
    },
  };
}

/** Stream a multi-turn chat reply (POST /ai/chat/stream). */
export function aiChatStream(body: ChatRequest, handlers: ChatStreamHandlers): ChatStreamHandle {
  return streamSse("/ai/chat/stream", body, handlers);
}

/** Stream a note-level AI action (POST /ai/action/stream), same wire format. */
export function aiActionStream(
  body: AiActionRequest,
  handlers: ChatStreamHandlers,
): ChatStreamHandle {
  return streamSse("/ai/action/stream", body, handlers);
}

/** One of the three note-level AI actions. */
export type AiAction = "summarize" | "rewrite" | "action_items";
/** Whether an action operates on the whole note or the selected passage. */
export type AiScope = "note" | "selection";

/**
 * Body for POST /ai/action and /ai/action/stream. `text` is the note's plain
 * text (ground truth); when `scope` is "selection" the server operates on
 * `selection` if present, else falls back to `text`.
 */
export interface AiActionRequest {
  action: AiAction;
  scope: AiScope;
  doc_id?: string | null;
  text: string;
  selection?: string | null;
}

/** The caller's writing-voice profile (GET/PUT /ai/voice). */
export interface VoiceProfile {
  sample: string;
  updated_at: string | null;
}

export interface AiStatus {
  available: boolean;
  provider: string | null;
  model: string | null;
  features: string[];
}
export interface AiComplete {
  text: string;
}
export interface ShareInfo {
  id: string;
  doc_id: string;
  mode: string;
  url: string;
  view_count: number;
  last_viewed_at: string | null;
}

/**
 * A share link with its full analytics (GET /documents/:id/shares and
 * GET /shares/:id/analytics). `last_viewed_at` is null if never viewed;
 * `expires_at` is null if the link never expires. See
 * docs/features/share-analytics.md §5.
 */
export interface ShareAnalytics extends ShareInfo {
  view_count: number;
  last_viewed_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/** Get the caller's workspace, creating a default one on first login. */
export async function ensureWorkspace(): Promise<string> {
  const workspaces = await api.listWorkspaces();
  const ws = workspaces[0] ?? (await api.createWorkspace("My Workspace"));
  return ws.id;
}
