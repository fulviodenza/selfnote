/**
 * The optional Selfnote side.
 *
 * Everything here is additive: the reader works fully with no connection, and
 * nothing in this file runs until the user deliberately connects an instance.
 *
 * Credentials: the user logs in once with email and password, and the app
 * immediately exchanges that for a personal access token, keeping only the token.
 * The password is never stored and the short-lived JWT is discarded, so there is
 * no refresh dance to get wrong, and the user can revoke "Selfnote eReader" from
 * their own account page without changing their password.
 */
import * as SecureStore from "expo-secure-store";

export interface Connection {
  /** API base, e.g. "https://selfnote-sync.fulvio.dev/api". */
  baseUrl: string;
  token: string;
  workspaceId: string;
  email: string;
}

export interface Page {
  id: string;
  title: string;
}

const KEY = "selfnote.connection";

/**
 * Accepts what a person actually types ("selfnote-sync.fulvio.dev") and turns it
 * into the API base.
 *
 * The "/api" suffix is not optional: a Selfnote instance serves the REST API under
 * /api and the sync socket under /ws, with the web app at the root. Posting to the
 * root gets whatever the ingress serves there, which answers a login POST with 405.
 * This mirrors deriveFromBase in apps/mobile/src/settings.ts; the two have to agree
 * or the same address works in one app and not the other.
 *
 * Defaults to https, because asking someone to type a scheme to reach their own
 * server is a poor first impression and defaulting to http would put their
 * password on the wire in the clear.
 */
export function normaliseBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Enter your Selfnote address");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (!url.hostname) throw new Error("That does not look like an address");
  // Tolerate someone pasting the API base itself rather than the instance root.
  const path = url.pathname.replace(/\/+$/, "");
  return path.endsWith("/api") ? `${url.origin}${path}` : `${url.origin}${path}/api`;
}

async function call<T>(
  baseUrl: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  if (!res.ok) {
    // The API returns {"error": "..."} and that text is written for people.
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = String(body.error);
    } catch {
      /* not JSON; the status is all we have */
    }
    throw new Error(detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * Log in and immediately trade the session for a long-lived token. Returns a
 * Connection ready to store; the caller never sees the password again.
 */
export async function connect(
  rawUrl: string,
  email: string,
  password: string,
): Promise<Connection> {
  const baseUrl = normaliseBaseUrl(rawUrl);
  const auth = await call<{ access_token: string }>(baseUrl, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const minted = await call<{ token: string }>(baseUrl, "/auth/tokens", {
    method: "POST",
    token: auth.access_token,
    body: JSON.stringify({ name: "Selfnote eReader" }),
  });
  const workspaces = await call<{ id: string; name: string }[]>(baseUrl, "/workspaces", {
    token: minted.token,
  });
  if (!workspaces.length) {
    throw new Error("This account has no workspace yet. Create one in Selfnote first.");
  }
  return { baseUrl, token: minted.token, workspaceId: workspaces[0].id, email: email.trim() };
}

export async function saveConnection(c: Connection): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(c));
}

export async function loadConnection(): Promise<Connection | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Connection;
  } catch {
    return null;
  }
}

export async function disconnect(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

/** Pages whose title matches, for the picker. */
export async function searchPages(c: Connection, query: string): Promise<Page[]> {
  const q = encodeURIComponent(query.trim());
  const path = q
    ? `/documents/search?workspace_id=${c.workspaceId}&q=${q}`
    : `/documents?workspace_id=${c.workspaceId}&state=active`;
  const rows = await call<Page[]>(c.baseUrl, path, { token: c.token });
  return rows.map((r) => ({ id: r.id, title: r.title }));
}

export async function createPage(c: Connection, title: string): Promise<Page> {
  const doc = await call<Page>(c.baseUrl, "/documents", {
    method: "POST",
    token: c.token,
    body: JSON.stringify({ workspace_id: c.workspaceId, title }),
  });
  return { id: doc.id, title: doc.title };
}

export interface OutgoingHighlight {
  id: string;
  text: string;
  note?: string | null;
  locator?: unknown;
}

/**
 * Push highlights onto the page the user chose for this book.
 *
 * The ids are the local highlight ids, generated once at creation, which is what
 * lets the server drop anything it has already written. Re-sending is therefore
 * safe and is the normal way this recovers from a dropped response.
 */
export async function sendHighlights(
  c: Connection,
  documentId: string,
  book: { key: string; title: string; author?: string | null },
  highlights: OutgoingHighlight[],
): Promise<{ applied: number; skipped: number }> {
  return call(c.baseUrl, "/integrations/highlights", {
    method: "POST",
    token: c.token,
    body: JSON.stringify({
      workspace_id: c.workspaceId,
      document_id: documentId,
      book,
      highlights: highlights.map((h) => ({
        id: h.id,
        text: h.text,
        note: h.note ?? null,
        locator: h.locator ?? null,
      })),
    }),
  });
}
