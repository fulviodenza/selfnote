/**
 * Server resolution for the web client, shared by the browser and the desktop
 * (Tauri) build:
 *  - Browser (served BY an instance): same-origin — `/api` for HTTP and
 *    `wss://<host>/ws` for sync, derived from the page origin. Works on any domain
 *    with nothing baked in.
 *  - Desktop / explicit override: a saved base URL (collected via onboarding),
 *    since a native app has no serving origin to derive from.
 */
const KEY = "selfnote.server";

function savedBase(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// "Served by an instance" = a real http(s) origin. Desktop (Tauri) loads over
// tauri:// or a localhost/tauri.localhost host, which has no API to talk to.
const host = typeof location !== "undefined" ? location.hostname : "";
const isServedOrigin =
  typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:") &&
  host !== "" &&
  host !== "localhost" &&
  host !== "127.0.0.1" &&
  host !== "tauri.localhost";

/** Desktop (no served origin) with no configured server needs onboarding. */
export function needsOnboarding(): boolean {
  return !savedBase() && !isServedOrigin;
}

export function deriveFromBase(input: string): { base: string; api: string; ws: string } {
  let base = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  const ws = base.replace(/^http/i, "ws"); // http→ws, https→wss
  return { base, api: `${base}/api`, ws: `${ws}/ws` };
}

export function saveServer(input: string): void {
  localStorage.setItem(KEY, deriveFromBase(input).base);
}

/** HTTP API base — same-origin `/api` in the browser, absolute when configured. */
export function apiBase(): string {
  const b = savedBase();
  return b ? `${b}/api` : "/api";
}

/** Sync WebSocket URL — derived from origin in the browser, absolute when configured. */
export function syncUrl(): string {
  const b = savedBase();
  if (b) return `${b.replace(/^http/i, "ws")}/ws`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
