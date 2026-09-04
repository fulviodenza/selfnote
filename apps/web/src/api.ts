import { apiBase } from "./server";

/** Same-origin `/api` in the browser; an absolute base when a server is configured. */
const API_BASE = apiBase();

/** Absolute URL for a relative API path (e.g. the ICS feed `url`). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

const ACCESS_KEY = "selfnote_access";
const REFRESH_KEY = "selfnote_refresh";

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
 * `expires_at` is null if the link never expires.
 */
export interface ShareAnalytics extends ShareInfo {
  view_count: number;
  last_viewed_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface ResolvedShare {
  doc_id: string;
  mode: "rw" | "ro";
  token: string;
  expires_in: number;
}

/** A recently-viewed note (GET /documents/recent). */
export interface RecentDocument {
  id: string;
  workspace_id: string;
  title: string;
  icon: string | null;
  viewed_at: string;
}

/**
 * A minimal document descriptor reused across the backlinks/graph responses
 * (the doc's `DocumentRef` shape).
 */
export interface DocumentRef {
  id: string;
  title: string;
  icon: string | null;
  parent_id: string | null;
}

/** One outgoing note reference (GET /documents/:id/links). */
export interface OutgoingLink {
  target: DocumentRef;
  label: string | null;
}

/** One backlink — a note that links *here* (GET /documents/:id/backlinks). */
export interface Backlink {
  source: DocumentRef;
  label: string | null;
}

/** A single outgoing edge to persist (PUT /documents/:id/links). */
export interface LinkInput {
  target_id: string;
  label: string | null;
}

/** An edge in the workspace graph (GET /workspaces/:id/graph). */
export interface GraphEdge {
  source: string;
  target: string;
  kind: "link" | "tree";
}

/** The workspace graph: one node per non-archived doc plus link/tree edges. */
export interface WorkspaceGraph {
  nodes: DocumentRef[];
  edges: GraphEdge[];
}

/** Base64 Yjs updates for a document's content (GET /documents/:id/content). */
export interface DocContent {
  updates: string[];
}

/** Task lifecycle state (a document promoted to a task). */
export type TaskStatus = "todo" | "in_progress" | "done";
/** Task importance. */
export type TaskPriority = "none" | "low" | "medium" | "high";

/**
 * A document promoted to a task (row in `document_tasks`, 1:1 with a document).
 * `title`/`icon` mirror the underlying document and are read-only here; edit
 * them through the document endpoints. `due_at` is nullable everywhere.
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

/** Body for POST /documents/:id/task (promote/upsert). All fields optional. */
export interface SetTaskInput {
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: string | null;
  due_all_day?: boolean;
}

/** Body for PATCH /documents/:id/task. Only present keys change. */
export interface UpdateTaskInput {
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: string | null;
  due_all_day?: boolean;
}

/** Query params for GET /tasks. */
export interface ListTasksParams {
  workspace_id: string;
  status?: TaskStatus[];
  due_before?: string;
  due_after?: string;
  include_undated?: boolean;
  sort?: "due_at" | "priority" | "created_at";
  limit?: number;
}

/** State of a workspace's ICS calendar feed (GET /workspaces/:id/calendar-feed). */
export interface CalendarFeed {
  enabled: boolean;
  /** Relative ICS path; prefix with API_BASE. May be absent per the doc. */
  url?: string;
  created_at?: string;
  last_used_at?: string | null;
}

/** Result of issuing/rotating a feed (POST /workspaces/:id/calendar-feed). */
export interface IssuedCalendarFeed {
  /** Plaintext `cal_…` token, shown once. */
  token: string;
  /** Relative ICS path; prefix with API_BASE. */
  url: string;
}

/** Where a staged AI edit came from. */
export type ProposalOrigin = "mcp" | "app";
/** Lifecycle of a staged AI edit. */
export type ProposalStatus = "pending" | "applied" | "rejected" | "superseded";
/** The mutating shape of a staged AI edit (mirrors the two MCP tools). */
export type ProposalOp = "append" | "replace";

/**
 * A staged AI edit (row in `ai_edit_proposals`). Any AI-originated write is
 * recorded as a proposal — a human reviews the before/after and accepts or
 * rejects it. `before_md`/`after_md` are Markdown for the diff view; the raw
 * `diff_base64`/`base_sv` are only present on GET /ai/proposals/:id.
 */
export interface AiProposal {
  id: string;
  document_id: string;
  workspace_id: string;
  op: ProposalOp;
  origin: ProposalOrigin;
  summary: string;
  status: ProposalStatus;
  before_md: string;
  after_md: string;
  created_by: string;
  created_at: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
  diff_base64?: string;
  base_sv?: string;
}

/** The lifecycle fields returned by accept/reject. */
export interface ProposalResolution {
  id: string;
  status: ProposalStatus;
  resolved_at: string;
  resolved_by: string;
}

/** Body for POST /ai/proposals (staged write). */
export interface CreateProposalInput {
  document_id: string;
  op: ProposalOp;
  markdown: string;
  origin?: ProposalOrigin;
  summary?: string;
}

/** Which side created a checkpoint (see docs/features/version-history.md §2). */
export type CheckpointKind = "manual" | "auto" | "restore";

/**
 * A version-history restore point (row in `doc_checkpoints`). Metadata shape
 * returned by list / create; `created_by`/`created_by_name` are null for `auto`
 * checkpoints. `size_bytes` is the byte size of the stored merged snapshot.
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

/** GET /documents/:id/history/:checkpoint_id — metadata plus the full state. */
export interface CheckpointState extends Checkpoint {
  /**
   * Ordered base64 v1 Yjs updates (same shape as `GET /documents/:id/content`);
   * for a checkpoint this is always exactly one element — the merged snapshot.
   */
  updates: string[];
}

/** GET /documents/:id/history response (newest-first, paginated). */
export interface HistoryPage {
  checkpoints: Checkpoint[];
  /** `created_at` cursor for the next page, or null when there are no more. */
  next_before: string | null;
}

/** Query params for GET /documents/:id/history (all optional). */
export interface ListHistoryParams {
  /** Default 50, max 200. */
  limit?: number;
  /** Return checkpoints strictly older than this RFC3339 timestamp. */
  before?: string;
  /** Filter to a single kind. */
  kind?: CheckpointKind;
}

/** POST /documents/:id/history/:checkpoint_id/restore response. */
export interface RestoreResult {
  restored_from: string;
  pre_restore_checkpoint: string;
  /** Base64 v1 Yjs update appended to the log — apply it to the live doc. */
  update: string;
}

let accessToken: string | null = localStorage.getItem(ACCESS_KEY);

function persist(auth: AuthResponse) {
  accessToken = auth.access_token;
  localStorage.setItem(ACCESS_KEY, auth.access_token);
  localStorage.setItem(REFRESH_KEY, auth.refresh_token);
}

export function clearSession() {
  accessToken = null;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export const isAuthed = () => !!accessToken;

async function raw<T>(path: string, options: RequestInit = {}, auth = true): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(body || `${res.status}`), { status: res.status });
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
  const refresh_token = localStorage.getItem(REFRESH_KEY);
  if (!refresh_token) return false;
  try {
    const auth = await raw<AuthResponse>(
      "/auth/refresh",
      { method: "POST", body: JSON.stringify({ refresh_token }) },
      false,
    );
    persist(auth);
    return true;
  } catch {
    clearSession();
    return false;
  }
}

export const api = {
  register: async (email: string, password: string) => {
    persist(
      await raw<AuthResponse>(
        "/auth/register",
        { method: "POST", body: JSON.stringify({ email, password }) },
        false,
      ),
    );
  },
  login: async (email: string, password: string) => {
    persist(
      await raw<AuthResponse>(
        "/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
        false,
      ),
    );
  },
  /** Restore a session from a stored refresh token. */
  restore: () => tryRefresh(),
  logout: clearSession,

  listWorkspaces: () => req<Workspace[]>("/workspaces"),
  createWorkspace: (name: string) =>
    req<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),

  listDocuments: (workspaceId: string) =>
    req<Document[]>(`/documents?workspace_id=${encodeURIComponent(workspaceId)}`),
  /** Full-text search over document titles within a workspace. */
  searchDocuments: (workspaceId: string, q: string) =>
    req<Document[]>(
      `/documents/search?workspace_id=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(q)}`,
    ),
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

  /** Seed a document's content with a base64 Yjs update (import). */
  setContent: (docId: string, updateBase64: string) =>
    req<void>(`/documents/${docId}/content`, {
      method: "POST",
      body: JSON.stringify({ update: updateBase64 }),
    }),

  /** Fetch a document's content as base64 Yjs updates (for headless render). */
  getContent: (docId: string) => req<DocContent>(`/documents/${docId}/content`),

  /** Record that the caller opened a document (fire-and-forget upsert). */
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

  /**
   * Outgoing note references for `docId` (GET /documents/:id/links). Archived
   * targets are excluded server-side.
   */
  getDocLinks: (docId: string) =>
    req<{ outgoing: OutgoingLink[] }>(`/documents/${docId}/links`).then((r) => r.outgoing),

  /**
   * Replace the full set of outgoing links for `docId` (PUT /documents/:id/links).
   * Self-links and cross-workspace targets are dropped server-side; returns the
   * number of edges stored after dedupe/filtering.
   */
  putDocLinks: (docId: string, links: LinkInput[]) =>
    req<{ source_id: string; count: number }>(`/documents/${docId}/links`, {
      method: "PUT",
      body: JSON.stringify({ links }),
    }).then((r) => r.count),

  /**
   * Notes that link *to* `docId` (GET /documents/:id/backlinks), ordered by
   * source title; archived sources excluded.
   */
  getBacklinks: (docId: string) =>
    req<{ backlinks: Backlink[] }>(`/documents/${docId}/backlinks`).then((r) => r.backlinks),

  /** The full node/edge set for the workspace graph (GET /workspaces/:id/graph). */
  getGraph: (workspaceId: string) => req<WorkspaceGraph>(`/workspaces/${workspaceId}/graph`),

  /**
   * Resolve link targets by title for the `[[`/`@` picker
   * (GET /documents/link-search). Excludes archived docs and, when given,
   * `exclude` (the doc being edited).
   */
  linkSearch: (workspaceId: string, q: string, exclude?: string) => {
    const qs = new URLSearchParams({ workspace_id: workspaceId, q });
    if (exclude) qs.set("exclude", exclude);
    return req<{ results: DocumentRef[] }>(`/documents/link-search?${qs.toString()}`).then(
      (r) => r.results,
    );
  },

  /** Upload a file (multipart); returns its served URL. */
  uploadFile: async (workspaceId: string, file: File): Promise<string> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_BASE}/files?workspace_id=${encodeURIComponent(workspaceId)}`, {
      method: "POST",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      body: fd,
    });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
    return ((await res.json()) as { url: string }).url;
  },

  createShare: (docId: string, mode: "rw" | "ro") =>
    req<ShareInfo>(`/documents/${docId}/shares`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  /** Public: resolve a share link into a scoped room token (no auth). */
  resolveShare: (shareId: string) => raw<ResolvedShare>(`/shares/${shareId}`, {}, false),

  /**
   * List a document's share links with analytics, newest-first
   * (GET /documents/:id/shares). Owner/editor only (viewers get 403).
   */
  listShares: (docId: string) =>
    req<{ shares: ShareAnalytics[] }>(`/documents/${docId}/shares`),
  /** Analytics for a single share link (GET /shares/:id/analytics). Owner/editor only. */
  shareAnalytics: (shareId: string) =>
    req<ShareAnalytics>(`/shares/${shareId}/analytics`),

  /** AI backend status. A missing endpoint (older server) counts as unavailable. */
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

  /** Multi-turn chat, streamed token-by-token over SSE. */
  aiChatStream: (body: ChatRequest, handlers: ChatStreamHandlers) =>
    openSseStream("/ai/chat/stream", body, handlers),

  // ---- Note-level AI actions (summarize / rewrite / extract action items) ----

  /** Run an action against the note (or selection), non-streaming (fallback). */
  aiAction: (body: AiActionRequest) =>
    req<AiComplete>("/ai/action", { method: "POST", body: JSON.stringify(body) }),

  /** Run an action, streamed token-by-token over SSE (primary path). */
  aiActionStream: (body: AiActionRequest, handlers: ChatStreamHandlers) =>
    openSseStream("/ai/action/stream", body, handlers),

  /** Read the caller's writing-voice profile (grounds "Rewrite in my voice"). */
  getVoice: () => req<VoiceProfile>("/ai/voice"),

  /** Set/update the caller's voice sample. Empty string clears it. */
  setVoice: (sample: string) =>
    req<VoiceProfile>("/ai/voice", { method: "PUT", body: JSON.stringify({ sample }) }),

  // ---- AI edit proposals (staged writes gated behind human review) ----

  /** Stage an AI edit as a `pending` proposal instead of writing the CRDT. */
  createAiProposal: (body: CreateProposalInput) =>
    req<AiProposal>("/ai/proposals", { method: "POST", body: JSON.stringify(body) }),

  /**
   * List proposals, newest first. Omit `documentId` to list across the caller's
   * workspaces; `status` defaults to `pending` server-side.
   */
  listAiProposals: (documentId?: string, status: ProposalStatus = "pending") => {
    const qs = new URLSearchParams();
    if (documentId) qs.set("document_id", documentId);
    if (status) qs.set("status", status);
    const q = qs.toString();
    return req<AiProposal[]>(`/ai/proposals${q ? `?${q}` : ""}`);
  },

  /** Fetch one proposal with its full diff payload (`diff_base64`, `base_sv`). */
  getAiProposal: (id: string) => req<AiProposal>(`/ai/proposals/${id}`),

  /** Accept (JWT only) — applies the staged diff to the note. */
  acceptAiProposal: (id: string) =>
    req<ProposalResolution>(`/ai/proposals/${id}/accept`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /** Reject (JWT only) — discards the proposal without touching the note. */
  rejectAiProposal: (id: string) =>
    req<ProposalResolution>(`/ai/proposals/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // Personal access tokens (for connecting the MCP server / scripts).
  listTokens: () => req<TokenInfo[]>("/auth/tokens"),
  createToken: (name: string) =>
    req<CreatedToken>("/auth/tokens", { method: "POST", body: JSON.stringify({ name }) }),
  deleteToken: (id: string) => req<void>(`/auth/tokens/${id}`, { method: "DELETE" }),

  // ---- Tasks (documents promoted to tasks) ----

  /** A document's task metadata. Throws `404` when the document is not a task. */
  getTask: (docId: string) => req<Task>(`/documents/${docId}/task`),
  /** Promote a document to a task (idempotent upsert of the provided fields). */
  setTask: (docId: string, body: SetTaskInput = {}) =>
    req<Task>(`/documents/${docId}/task`, { method: "POST", body: JSON.stringify(body) }),
  /** Patch a task; only present keys change. Explicit `due_at: null` clears it. */
  updateTask: (docId: string, patch: UpdateTaskInput) =>
    req<Task>(`/documents/${docId}/task`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** Demote a task (removes task metadata; the document is untouched). Idempotent. */
  deleteTask: (docId: string) => req<void>(`/documents/${docId}/task`, { method: "DELETE" }),

  /** List/agenda query. `status` is sent as a CSV; nulls sort last. */
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

  // ---- Calendar (ICS) feed ----

  /** Whether the workspace has a feed (never returns the plaintext token). */
  getCalendarFeed: (workspaceId: string) =>
    req<CalendarFeed>(`/workspaces/${workspaceId}/calendar-feed`),
  /** Issue/rotate the feed; returns a one-time `cal_…` token + relative URL. */
  issueCalendarFeed: (workspaceId: string) =>
    req<IssuedCalendarFeed>(`/workspaces/${workspaceId}/calendar-feed`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  /** Revoke all of the caller's feed tokens for the workspace. */
  revokeCalendarFeed: (workspaceId: string) =>
    req<void>(`/workspaces/${workspaceId}/calendar-feed`, { method: "DELETE" }),

  // ---- Version history / time-travel ----

  /**
   * List a document's restore points, newest-first (GET /documents/:id/history).
   * Any member (incl. viewer) may read. Paginate with `before` = the previous
   * page's `next_before`; a null `next_before` means the last page.
   */
  listHistory: (docId: string, params: ListHistoryParams = {}) => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.before) qs.set("before", params.before);
    if (params.kind) qs.set("kind", params.kind);
    const q = qs.toString();
    return req<HistoryPage>(`/documents/${docId}/history${q ? `?${q}` : ""}`);
  },

  /** One checkpoint's metadata plus its full merged state (base64 update). */
  getCheckpoint: (docId: string, checkpointId: string) =>
    req<CheckpointState>(`/documents/${docId}/history/${checkpointId}`),

  /**
   * Save the doc's current state as a `manual` checkpoint (member, non-viewer).
   * `label` is optional (max 200 chars; empty → stored as null).
   */
  createCheckpoint: (docId: string, label?: string) =>
    req<Checkpoint>(`/documents/${docId}/history`, {
      method: "POST",
      body: JSON.stringify(label != null ? { label } : {}),
    }),

  /**
   * Restore a checkpoint (member, non-viewer): captures a pre-restore checkpoint,
   * appends a forward update so all sync clients converge, and returns that
   * `update` so the live editor can apply it immediately without a round-trip.
   */
  restoreCheckpoint: (docId: string, checkpointId: string, label?: string) =>
    req<RestoreResult>(`/documents/${docId}/history/${checkpointId}/restore`, {
      method: "POST",
      body: JSON.stringify(label != null ? { label } : {}),
    }),

  /** Delete a checkpoint row (member, non-viewer); doc content is untouched. */
  deleteCheckpoint: (docId: string, checkpointId: string) =>
    req<void>(`/documents/${docId}/history/${checkpointId}`, { method: "DELETE" }),
};

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
/** An additional note folded into the chat as extra grounding context. */
export interface ExtraDoc {
  doc_id: string;
  title?: string;
  text: string;
  source?: "linked" | "recent" | "manual";
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
  signal?: AbortSignal;
}
export interface TokenInfo {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}
export interface CreatedToken {
  id: string;
  name: string;
  token: string;
  created_at: string;
}

/**
 * POST a JSON body to an SSE endpoint and parse the Server-Sent Events, calling
 * onDelta for each text chunk. Refreshes the access token once on a 401. Uses
 * fetch (not EventSource) so we can send the Authorization header and a POST
 * body. Shared by `/ai/chat/stream` and `/ai/action/stream` (identical wire
 * format: `{delta}` events, `event: done`, `event: error`).
 */
async function openSseStream(
  path: string,
  body: unknown,
  handlers: ChatStreamHandlers,
  retry = true,
): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });
  if (res.status === 401 && retry && (await tryRefresh())) {
    return openSseStream(path, body, handlers, false);
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw Object.assign(new Error(t || `assist failed (${res.status})`), { status: res.status });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    // SSE frames are separated by a blank line.
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
        let msg = "Assist failed.";
        try {
          msg = JSON.parse(data).error ?? msg;
        } catch {
          /* keep default */
        }
        handlers.onError?.(msg);
      } else if (event !== "done") {
        try {
          const parsed = JSON.parse(data) as { delta?: string };
          if (typeof parsed.delta === "string") handlers.onDelta(parsed.delta);
        } catch {
          /* keep-alive comment or partial frame */
        }
      }
    }
  }
  handlers.onDone?.();
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

/** One of the three note-level actions. */
export type AiActionKind = "summarize" | "rewrite" | "action_items";
/** Whether an action runs over the whole note or just the current selection. */
export type AiActionScope = "note" | "selection";

/** Body for POST /ai/action and /ai/action/stream (mirrors the doc's §3.1). */
export interface AiActionRequest {
  action: AiActionKind;
  scope: AiActionScope;
  doc_id?: string | null;
  /** The note's plain-text content — ground truth for the action. */
  text: string;
  /** The selected passage; operated on when `scope === "selection"`. */
  selection?: string | null;
}

/** The caller's writing-voice profile (GET/PUT /ai/voice). */
export interface VoiceProfile {
  sample: string;
  updated_at: string | null;
}

/** Get the caller's workspace, creating a default one on first login. */
export async function ensureWorkspace(): Promise<string> {
  const workspaces = await api.listWorkspaces();
  const ws = workspaces[0] ?? (await api.createWorkspace("My Workspace"));
  return ws.id;
}
