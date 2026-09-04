import type { ReactNode } from "react";
import { Platform, SafeAreaView, StatusBar, StyleSheet, View } from "react-native";
import { useTheme } from "../theme-context";

/** Root screen wrapper: themed background + Android status-bar inset. */
export function Screen({ children, surface = false }: { children: ReactNode; surface?: boolean }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView
      style={[
        styles.root,
        {
          backgroundColor: surface ? colors.surface : colors.paper,
          paddingTop: Platform.OS === "android" ? StatusBar.currentHeight ?? 0 : 0,
        },
      ]}
    >
      <View style={styles.body}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 }, body: { flex: 1 } });
