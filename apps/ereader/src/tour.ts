/**
 * The screenshot tour: a file the App Store screenshot script drops into the
 * documents directory to say which book to open and where, because synthetic
 * taps into the Simulator cannot be relied on. It never exists on a real
 * device, so its absence is the normal case and costs one stat.
 */
import * as FileSystem from "expo-file-system/legacy";

export interface Tour {
  /** A book id to open from the shelf. */
  open?: string;
  /** A PDF page to show. */
  page?: number;
  /** Show the first insert after the page. */
  note?: boolean;
}

export async function readTour(): Promise<Tour | null> {
  try {
    const uri = (FileSystem.documentDirectory ?? "") + ".screenshot-tour.json";
    if (!(await FileSystem.getInfoAsync(uri)).exists) return null;
    const raw: unknown = JSON.parse(await FileSystem.readAsStringAsync(uri));
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    return {
      open: typeof t.open === "string" ? t.open : undefined,
      page: typeof t.page === "number" && t.page > 0 ? Math.floor(t.page) : undefined,
      note: t.note === true,
    };
  } catch {
    return null;
  }
}
