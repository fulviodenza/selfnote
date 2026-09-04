import { apiBase } from "./server";

/** Same-origin `/api` in the browser; an absolute base when a server is configured. */
const API_BASE = apiBase();

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
}

export interface ResolvedShare {
  doc_id: string;
  mode: "rw" | "ro";
  token: string;
  expires_in: number;
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
};

export interface AiStatus {
  available: boolean;
  provider: string | null;
  model: string | null;
  features: string[];
}
export interface AiComplete {
  text: string;
}

/** Get the caller's workspace, creating a default one on first login. */
export async function ensureWorkspace(): Promise<string> {
  const workspaces = await api.listWorkspaces();
  const ws = workspaces[0] ?? (await api.createWorkspace("My Workspace"));
  return ws.id;
}
