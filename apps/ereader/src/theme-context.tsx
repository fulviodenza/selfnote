/**
 * Runtime theme: the palette follows the OS colour scheme and is read through
 * useTheme(), so light and dark are a live swap rather than a reload.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { colors as lightColors, darkColors, makeType, type Palette, type TypeRoles } from "./theme";

interface ThemeValue {
  colors: Palette;
  type: TypeRoles;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const isDark = useColorScheme() === "dark";
  const value = useMemo<ThemeValue>(() => {
    const colors: Palette = isDark ? darkColors : lightColors;
    return { colors, type: makeType(colors), isDark };
  }, [isDark]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used within ThemeProvider");
  return v;
}
