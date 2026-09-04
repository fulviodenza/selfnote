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

  createShare: (docId: string, mode: "rw" | "ro") =>
    req<ShareInfo>(`/documents/${docId}/shares`, { method: "POST", body: JSON.stringify({ mode }) }),

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
export interface ShareInfo {
  id: string;
  doc_id: string;
  mode: string;
  url: string;
}

/** Get the caller's workspace, creating a default one on first login. */
export async function ensureWorkspace(): Promise<string> {
  const workspaces = await api.listWorkspaces();
  const ws = workspaces[0] ?? (await api.createWorkspace("My Workspace"));
  return ws.id;
}
