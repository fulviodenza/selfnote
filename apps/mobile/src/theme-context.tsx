/**
 * Runtime theme: resolves the palette from the OS color scheme (or a manual
 * override persisted across launches) and exposes it via useTheme(). Components
 * read colors/type from the hook so light↔dark is a live swap.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors as lightColors, darkColors, makeType, type Palette, type TypeRoles } from "./theme";

export type ThemeMode = "light" | "dark" | "system";
const MODE_KEY = "selfnote.themeMode";

interface ThemeValue {
  colors: Palette;
  type: TypeRoles;
  isDark: boolean;
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY).then((m) => {
      if (m === "light" || m === "dark" || m === "system") setModeState(m);
    });
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => undefined);
  }, []);

  const isDark = mode === "system" ? scheme === "dark" : mode === "dark";
  const value = useMemo<ThemeValue>(() => {
    const colors: Palette = isDark ? darkColors : lightColors;
    return { colors, type: makeType(colors), isDark, mode, setMode };
  }, [isDark, mode, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used within ThemeProvider");
  return v;
}
