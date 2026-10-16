/**
 * Ink and Paper design tokens for the reader, the same system as the main
 * mobile app (apps/mobile/src/theme.ts, apps/mobile/docs/DESIGN.md). The colour
 * values are a copy of packages/core/tokens.json that scripts/check-tokens.mjs
 * keeps honest. Components read from here; no hex literals elsewhere.
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
  liveWash: "#E4F4EC",
  warn: "#C1841E",
  danger: "#C4392B",
  dangerWash: "#F8E7E4",
  onAccent: "#FFFFFF",
} as const;

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
  liveWash: "#1B2A24",
  warn: "#D79A3A",
  danger: "#E06456",
  dangerWash: "#2E2020",
  onAccent: "#12131A",
};

/** Modal scrim, the same in both schemes. */
export const scrim = "rgba(20, 22, 28, 0.45)";

/** A highlight on the page: the accent, washed. Pending versus saved is told
 * apart by a dashed outline, not by colour. */
export const highlightFill = {
  light: "rgba(43, 68, 199, 0.22)",
  dark: "rgba(124, 140, 248, 0.28)",
} as const;

/** Copy area: a lighter dim than the scrim, as the page under it is what is
 * being chosen, and a faint lift inside the dragged rectangle. */
export const capture = {
  dim: "rgba(20, 22, 28, 0.28)",
  fill: "rgba(255, 255, 255, 0.18)",
} as const;

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

/** The one allowed floating shadow (active sheet, floating bars). Elsewhere use hairlines.
 * shadowColor is the scrim's ink, rgba(20, 22, 28) as hex. */
export const shadow = {
  floating: {
    shadowColor: "#14161C",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
} as const;

// System fallbacks for the two DESIGN.md roles. `serif` renders a serif on both OSes.
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
