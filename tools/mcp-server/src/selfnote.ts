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
  archived: boolean;
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
}
