/**
 * The screenshot tour: a file the App Store screenshot script
 * (scripts/appstore-shots.mjs) drops into the documents directory to say which
 * server to use, which demo account to sign in with and which screen to show,
 * because synthetic taps into the Simulator cannot be relied on. It never
 * exists on a real device, so its absence is the normal case and costs one
 * failed local read.
 *
 * expo-file-system is not linked into this app, so the documents directory is
 * found through expo-sqlite (its default database directory is
 * Documents/SQLite) and the file is read with a file:// fetch, which React
 * Native's networking layer serves from disk.
 */
import { defaultDatabaseDirectory } from "expo-sqlite";
import type { ServerSettings } from "./settings";

export type TourOpen = "home" | "graph" | "tasks" | { note: string };

export interface Tour {
  server: ServerSettings;
  login: { email: string; password: string };
  open: TourOpen;
}

const FILE = ".screenshot-tour.json";

function tourPath(): string | null {
  const dir: unknown = defaultDatabaseDirectory;
  if (typeof dir !== "string" || !dir) return null;
  return `${dir.replace(/\/SQLite\/?$/, "")}/${FILE}`;
}

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The tour, or null when there is none or it does not parse. Never throws. */
export async function readTour(): Promise<Tour | null> {
  try {
    const path = tourPath();
    if (!path) return null;
    const res = await fetch(`file://${encodeURI(path)}`);
    if (!res.ok) return null;
    const raw: unknown = JSON.parse(await res.text());
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    const server = t.server as Record<string, unknown> | undefined;
    const login = t.login as Record<string, unknown> | undefined;
    if (!server || !str(server.apiUrl) || !str(server.syncUrl)) return null;
    if (!login || !str(login.email) || !str(login.password)) return null;
    let open: TourOpen = "home";
    if (t.open === "graph" || t.open === "tasks") open = t.open;
    else if (t.open && typeof t.open === "object") {
      const note = (t.open as Record<string, unknown>).note;
      if (str(note)) open = { note };
    }
    return {
      server: { apiUrl: server.apiUrl, syncUrl: server.syncUrl },
      login: { email: login.email, password: login.password },
      open,
    };
  } catch {
    return null;
  }
}
