/**
 * Thin Selfnote API client for the MCP server. Authenticates with a personal
 * access token (SELFNOTE_TOKEN, an `snp_…` value minted in the app's Connections
 * settings) — long-lived, so no refresh dance is needed.
 */

export interface Workspace {
  id: string;
  name: string;
}

export interface Document {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  archived: boolean;
  trashed: boolean;
  /** Fractional sort key among siblings; see migration 0017. */
  position: number;
}

export interface AiProposal {
  id: string;
  document_id: string;
  workspace_id: string;
  op: string;
  origin: string;
  summary: string;
  status: string;
  before_md: string;
  after_md: string;
  created_by: string;
  created_at: string;
}

export interface Task {
  id: string;
  doc_id: string;
  block_id: string | null;
  workspace_id: string;
  title: string;
  doc_title: string;
  icon: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  due_all_day: boolean;
  completed_at: string | null;
  detached: boolean;
}

export interface Label {
  id: string;
  workspace_id: string;
  name: string;
  color: string;
}

export interface DocumentRef {
  id: string;
  title: string;
  icon: string | null;
  parent_id: string | null;
}

export interface SearchResults {
  pages: DocumentRef[];
  labels: Label[];
  texts: (DocumentRef & { snippet: string })[];
}

/**
 * A field the API reads three ways: absent leaves the stored value alone, an
 * explicit `null` clears it, a value sets it. `parent_id` and `due_at` both work
 * this way, and omitting the key where `null` was meant is a silent no-op rather
 * than an error, so callers build these patches deliberately.
 */
export type Tri<T> = { set: T } | { clear: true } | undefined;

function tri<T>(v: Tri<T>): { present: boolean; value: T | null } {
  if (v === undefined) return { present: false, value: null };
  return "clear" in v ? { present: true, value: null } : { present: true, value: v.set };
}

/**
 * The writable fields of a task. `dueAt` is three-state like `parentId`: absent
 * leaves the due date, `{clear: true}` removes it, a value sets it.
 */
export interface TaskFields {
  status?: string;
  priority?: string;
  dueAt?: Tri<string>;
  dueAllDay?: boolean;
}

function taskBody(fields: TaskFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.status !== undefined) body.status = fields.status;
  if (fields.priority !== undefined) body.priority = fields.priority;
  if (fields.dueAllDay !== undefined) body.due_all_day = fields.dueAllDay;
  const due = tri(fields.dueAt);
  if (due.present) body.due_at = due.value;
  return body;
}

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export const TASK_PRIORITIES = ["none", "low", "medium", "high"] as const;

export class SelfnoteClient {
  private readonly origin: string;
  private readonly apiBase: string;
  private readonly token: string;

  /**
   * @param url    the instance origin, e.g. https://notes.example.com
   * @param token  a personal access token (snp_…)
   * @param apiUrl optional explicit API base (defaults to `${url}/api`)
   */
  constructor(url: string, token: string, apiUrl?: string) {
    this.origin = url.replace(/\/+$/, "");
    this.apiBase = (apiUrl ?? `${this.origin}/api`).replace(/\/+$/, "");
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Selfnote API ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /** A shareable link that opens this note in the web app. */
  deepLink(docId: string): string {
    return `${this.origin}/#doc-${docId}`;
  }

  listWorkspaces(): Promise<Workspace[]> {
    return this.request<Workspace[]>("/workspaces");
  }

  /** The user's first workspace — created on their first login, so it exists. */
  async ensureWorkspace(): Promise<string> {
    const workspaces = await this.listWorkspaces();
    if (!workspaces.length) throw new Error("No workspace found for this token's user.");
    return workspaces[0].id;
  }

  listDocuments(workspaceId: string): Promise<Document[]> {
    return this.request<Document[]>(
      `/documents?workspace_id=${encodeURIComponent(workspaceId)}`,
    );
  }

  searchDocuments(workspaceId: string, query: string): Promise<Document[]> {
    const qs = new URLSearchParams({ workspace_id: workspaceId, q: query });
    return this.request<Document[]>(`/documents/search?${qs.toString()}`);
  }

  createDocument(
    workspaceId: string,
    parentId: string | null,
    title: string,
  ): Promise<Document> {
    return this.request<Document>("/documents", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, parent_id: parentId, title }),
    });
  }

  /** Append a base64 Yjs update to a note's content log. */
  async setContent(docId: string, updateBase64: string): Promise<void> {
    await this.request<void>(`/documents/${docId}/content`, {
      method: "POST",
      body: JSON.stringify({ update: updateBase64 }),
    });
  }

  /**
   * Stage an AI edit as a pending proposal instead of writing it to the note. The
   * server computes the diff and before/after Markdown; a human accepts or rejects
   * it in the app. Returns the created proposal.
   */
  async createProposal(
    docId: string,
    op: "append" | "replace",
    markdown: string,
    summary?: string,
  ): Promise<AiProposal> {
    return this.request<AiProposal>("/ai/proposals", {
      method: "POST",
      body: JSON.stringify({
        document_id: docId,
        op,
        markdown,
        origin: "mcp",
        ...(summary ? { summary } : {}),
      }),
    });
  }

  /** The note's current CRDT state as ordered base64 Yjs updates. */
  async getContent(docId: string): Promise<string[]> {
    const r = await this.request<{ updates: string[] }>(`/documents/${docId}/content`);
    return r.updates;
  }

  /** Find a top-level note with this exact title, or create one. */
  async findOrCreateNote(workspaceId: string, title: string): Promise<Document> {
    const docs = await this.listDocuments(workspaceId);
    const existing = docs.find((d) => d.parent_id === null && d.title === title);
    return existing ?? this.createDocument(workspaceId, null, title);
  }

  /* ------------------------------------------------------ documents --- */

  getDocument(docId: string): Promise<Document> {
    return this.request<Document>(`/documents/${docId}`);
  }

  /**
   * Patch a page. `parentId` is three-state: leaving it undefined keeps the
   * current parent, `{clear: true}` moves the page to the top level. Sending no
   * key where `null` was meant leaves the page where it was and reports success,
   * so the caller has to be explicit.
   */
  updateDocument(
    docId: string,
    patch: {
      title?: string;
      icon?: string;
      parentId?: Tri<string>;
      position?: number;
      archived?: boolean;
      trashed?: boolean;
    },
  ): Promise<Document> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.icon !== undefined) body.icon = patch.icon;
    if (patch.archived !== undefined) body.archived = patch.archived;
    if (patch.trashed !== undefined) body.trashed = patch.trashed;
    if (patch.position !== undefined) body.position = patch.position;
    const parent = tri(patch.parentId);
    if (parent.present) body.parent_id = parent.value;
    return this.request<Document>(`/documents/${docId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * A sort key that puts a page last among its new siblings. Positions are
   * fractional so a move is a single-row write, and the server rejects
   * non-finite values, so this stays well inside the float range rather than
   * doubling the maximum forever.
   */
  async positionAtEnd(
    workspaceId: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<number> {
    const docs = await this.listDocuments(workspaceId);
    const siblings = docs.filter(
      (d) => d.parent_id === parentId && d.id !== excludeId && !d.trashed,
    );
    if (!siblings.length) return 1;
    const max = Math.max(...siblings.map((d) => d.position).filter(Number.isFinite));
    return Number.isFinite(max) ? max + 1 : 1;
  }

  /* ---------------------------------------------------------- tasks --- */

  /** Every task on a page: the page task, if any, plus tasks anchored to blocks. */
  listDocTasks(docId: string): Promise<Task[]> {
    return this.request<{ tasks: Task[] }>(`/documents/${docId}/tasks`).then((r) => r.tasks);
  }

  /** Promote a page to a task. Idempotent: omitted fields keep their value. */
  setPageTask(docId: string, fields: TaskFields): Promise<Task> {
    return this.request<Task>(`/documents/${docId}/task`, {
      method: "POST",
      body: JSON.stringify(taskBody(fields)),
    });
  }

  /** Make a task out of a block inside a page. */
  createBlockTask(docId: string, blockId: string, fields: TaskFields & { title?: string }): Promise<Task> {
    // The server upserts on (doc_id, block_id) and sets `title = excluded.title`,
    // so an absent title is not "leave it alone", it is "blank it". Omit the key
    // rather than sending undefined, which JSON.stringify drops into the same trap.
    const body: Record<string, unknown> = { block_id: blockId, ...taskBody(fields) };
    if (fields.title !== undefined) body.title = fields.title;
    return this.request<Task>(`/documents/${docId}/tasks`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Edit a task by id, which works for page and block tasks alike. */
  updateTask(taskId: string, fields: TaskFields): Promise<Task> {
    return this.request<Task>(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(taskBody(fields)),
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.request<void>(`/tasks/${taskId}`, { method: "DELETE" });
  }

  /** The agenda query. Filters map straight onto `GET /tasks`. */
  listTasks(params: {
    workspaceId: string;
    status?: string[];
    dueBefore?: string;
    dueAfter?: string;
    includeUndated?: boolean;
    docId?: string;
    labelIds?: string[];
    sort?: string;
    limit?: number;
  }): Promise<Task[]> {
    const qs = new URLSearchParams({ workspace_id: params.workspaceId });
    if (params.status?.length) qs.set("status", params.status.join(","));
    if (params.dueBefore) qs.set("due_before", params.dueBefore);
    if (params.dueAfter) qs.set("due_after", params.dueAfter);
    if (params.includeUndated !== undefined) qs.set("include_undated", String(params.includeUndated));
    if (params.docId) qs.set("doc_id", params.docId);
    if (params.labelIds?.length) qs.set("label_id", params.labelIds.join(","));
    if (params.sort) qs.set("sort", params.sort);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    return this.request<{ tasks: Task[] }>(`/tasks?${qs.toString()}`).then((r) => r.tasks);
  }

  /* --------------------------------------------------------- labels --- */

  listLabels(workspaceId: string): Promise<Label[]> {
    return this.request<{ labels: Label[] }>(`/workspaces/${workspaceId}/labels`).then(
      (r) => r.labels,
    );
  }

  /** Create a label, or return the existing one with that name. */
  createLabel(workspaceId: string, name: string, color?: string): Promise<Label> {
    return this.request<Label>(`/workspaces/${workspaceId}/labels`, {
      method: "POST",
      body: JSON.stringify({ name, ...(color ? { color } : {}) }),
    });
  }

  docLabels(docId: string): Promise<Label[]> {
    return this.request<{ labels: Label[] }>(`/documents/${docId}/labels`).then((r) => r.labels);
  }

  /**
   * Authoritative full replace of a page's labels. Adding one label means
   * reading the current set and sending it back with the addition, which
   * `setDocLabels` callers must do rather than sending the single new id.
   */
  setDocLabels(docId: string, labelIds: string[]): Promise<Label[]> {
    return this.request<{ labels: Label[] }>(`/documents/${docId}/labels`, {
      method: "PUT",
      body: JSON.stringify({ label_ids: labelIds }),
    }).then((r) => r.labels);
  }

  /* ------------------------------------------------- search + links --- */

  search(workspaceId: string, q: string): Promise<SearchResults> {
    const qs = new URLSearchParams({ workspace_id: workspaceId, q });
    return this.request<SearchResults>(`/search?${qs.toString()}`);
  }

  outgoingLinks(docId: string): Promise<{ target: DocumentRef; label: string | null }[]> {
    return this.request<{ outgoing: { target: DocumentRef; label: string | null }[] }>(
      `/documents/${docId}/links`,
    ).then((r) => r.outgoing);
  }

  backlinks(docId: string): Promise<{ source: DocumentRef; label: string | null }[]> {
    return this.request<{ backlinks: { source: DocumentRef; label: string | null }[] }>(
      `/documents/${docId}/backlinks`,
    ).then((r) => r.backlinks);
  }
}
