/**
 * Runtime-configurable server settings, persisted with AsyncStorage.
 *
 * The sync (WebSocket) and API (HTTP) base URLs default to the values baked in at
 * build time (src/config.ts) but can be overridden from the in-app Settings screen,
 * so one build can point at any self-hosted Selfnote instance.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_API_URL, DEFAULT_SYNC_URL } from "./config";

export interface ServerSettings {
  syncUrl: string;
  apiUrl: string;
}

const SYNC_KEY = "selfnote.syncUrl";
const API_KEY = "selfnote.apiUrl";

let cached: ServerSettings = { syncUrl: DEFAULT_SYNC_URL, apiUrl: DEFAULT_API_URL };

/** Load persisted overrides into the in-memory cache. Call once on app boot. */
export async function loadSettings(): Promise<ServerSettings> {
  const [sync, api] = await Promise.all([
    AsyncStorage.getItem(SYNC_KEY),
    AsyncStorage.getItem(API_KEY),
  ]);
  cached = {
    syncUrl: sync?.trim() || DEFAULT_SYNC_URL,
    apiUrl: api?.trim() || DEFAULT_API_URL,
  };
  return cached;
}

/** Synchronous access to the current settings (valid after loadSettings). */
export function getSettings(): ServerSettings {
  return cached;
}

export async function saveSettings(next: ServerSettings): Promise<ServerSettings> {
  cached = {
    syncUrl: next.syncUrl.trim() || DEFAULT_SYNC_URL,
    apiUrl: next.apiUrl.trim() || DEFAULT_API_URL,
  };
  await Promise.all([
    AsyncStorage.setItem(SYNC_KEY, cached.syncUrl),
    AsyncStorage.setItem(API_KEY, cached.apiUrl),
  ]);
  return cached;
}

export const defaults: ServerSettings = { syncUrl: DEFAULT_SYNC_URL, apiUrl: DEFAULT_API_URL };

/** True once a server is configured — otherwise the app shows onboarding. */
export function isConfigured(): boolean {
  return cached.apiUrl.trim() !== "" && cached.syncUrl.trim() !== "";
}

/**
 * Derive API + sync URLs from a single instance base the user types in onboarding
 * (e.g. "selfnote.example.com" → https://…/api + wss://…/ws). Adds https:// if the
 * scheme is missing and strips a trailing slash.
 */
export function deriveFromBase(input: string): ServerSettings {
  let base = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  const wsBase = base.replace(/^http/i, "ws"); // http→ws, https→wss
  return { apiUrl: `${base}/api`, syncUrl: `${wsBase}/ws` };
}
