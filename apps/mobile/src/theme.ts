/**
 * Selfnote design tokens — the single source of truth for the mobile UI.
 * See apps/mobile/docs/DESIGN.md. Components must read from here; no hard-coded
 * hex or sizing magic numbers elsewhere. Swapping `colors` is what makes dark
 * mode a value change rather than a refactor.
 */
import { Platform, type TextStyle } from "react-native";

export const colors = {
  paper: "#F3F3F0",
  surface: "#FFFFFF",
  surfaceSunken: "#ECECE8",
  ink: "#1B1D22",
  inkSoft: "#606670",
  inkFaint: "#9A9EA6",
  hairline: "#E2E1DC",
  accent: "#2B44C7",
  accentPressed: "#22369E",
  accentWash: "#EAEDFB",
  live: "#1F9E6A",
  warn: "#C1841E",
  danger: "#C4392B",
  onAccent: "#FFFFFF",
} as const;

/**
 * Dark palette (DESIGN.md §3.1). Groundwork: same keys as `colors`, so wiring a
 * ThemeProvider that resolves by `useColorScheme()` is a value swap, not a rewrite.
 */
export type Palette = Record<keyof typeof colors, string>;

export const darkColors: Palette = {
  paper: "#17181C",
  surface: "#202228",
  surfaceSunken: "#2A2C33",
  ink: "#ECECEA",
  inkSoft: "#A2A7B0",
  inkFaint: "#6B7078",
  hairline: "#2E3037",
  accent: "#7C8CF8",
  accentPressed: "#6675E8",
  accentWash: "#23263A",
  live: "#3FBF8A",
  warn: "#D79A3A",
  danger: "#E06456",
  onAccent: "#12131A",
};

/** Resolve a palette from the OS color scheme (for future ThemeProvider wiring). */
export function resolveColors(scheme: "light" | "dark" | null | undefined) {
  return scheme === "dark" ? darkColors : colors;
}

/** 4-based spacing scale. Screen gutter = 20. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
  gutter: 20,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  full: 999,
} as const;

/** Sizing rules from DESIGN.md §4 — the load-bearing touch-target numbers. */
export const sizing = {
  minTarget: 48,
  buttonPrimary: 52,
  buttonSecondary: 48,
  input: 52,
  row: 56,
  fab: 56,
  iconVisual: 44,
} as const;

/** The one allowed floating shadow (FAB, active sheet). Elsewhere use hairlines. */
export const shadow = {
  floating: {
    shadowColor: "#14161C",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
} as const;

// Fonts: system fallbacks mapped to the two DESIGN.md roles until Newsreader +
// Inter Tight are bundled via expo-font. `serif` renders a serif on both OSes.
const serif = Platform.select({ ios: "Georgia", android: "serif", default: "serif" });
const sans = Platform.select({ ios: "System", android: "sans-serif", default: undefined });

export const fonts = { serif, sans } as const;

type TypeRole = Pick<TextStyle, "fontFamily" | "fontSize" | "lineHeight" | "fontWeight" | "color">;

export type TypeRoles = Record<
  "title" | "docTitle" | "body" | "button" | "label" | "meta",
  TypeRole
>;

/** Build the type scale against a palette so dark mode uses the dark ink. */
export function makeType(c: Palette): TypeRoles {
  return {
    title: { fontFamily: serif, fontSize: 28, lineHeight: 34, fontWeight: "600", color: c.ink },
    docTitle: { fontFamily: serif, fontSize: 18, lineHeight: 24, fontWeight: "500", color: c.ink },
    body: { fontFamily: sans, fontSize: 16, lineHeight: 24, fontWeight: "400", color: c.ink },
    button: { fontFamily: sans, fontSize: 16, lineHeight: 20, fontWeight: "600", color: c.ink },
    label: { fontFamily: sans, fontSize: 14, lineHeight: 18, fontWeight: "500", color: c.inkSoft },
    meta: { fontFamily: sans, fontSize: 13, lineHeight: 16, fontWeight: "400", color: c.inkSoft },
  };
}

/** Light-mode type roles (kept for static imports / non-themed contexts). */
export const type: TypeRoles = makeType(colors);

/** Expand a small visual control to the 48px minimum touch target. */
export function hitSlop(visualSize: number, target = sizing.minTarget) {
  const pad = Math.max(0, Math.round((target - visualSize) / 2));
  return { top: pad, bottom: pad, left: pad, right: pad };
}

export const motion = { fast: 100, sheet: 220 } as const;

export const theme = { colors, spacing, radius, sizing, shadow, fonts, type, motion, hitSlop };
export type Theme = typeof theme;
