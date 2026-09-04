import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { radius, shadow, spacing } from "../theme";
import { useTheme } from "../theme-context";

interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}
interface ToastState extends ToastOptions {
  message: string;
}

const ToastContext = createContext<(message: string, opts?: ToastOptions) => void>(() => {});

/** App-wide toast host. Wrap the app; call `useToast()` to show one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { colors, type } = useTheme();
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string, opts: ToastOptions = {}) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, ...opts });
    timer.current = setTimeout(() => setToast(null), opts.durationMs ?? (opts.actionLabel ? 4000 : 3000));
  }, []);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <View style={styles.host} pointerEvents="box-none">
          <View style={[styles.toast, { backgroundColor: colors.ink }]}>
            <Text style={[type.body, { color: colors.surface }, styles.text]} numberOfLines={2}>
              {toast.message}
            </Text>
            {toast.actionLabel ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={toast.actionLabel}
                hitSlop={12}
                onPress={() => {
                  toast.onAction?.();
                  dismiss();
                }}
              >
                <Text style={[type.button, { color: colors.accent }]}>{toast.actionLabel}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

const styles = StyleSheet.create({
  host: { position: "absolute", left: spacing.gutter, right: spacing.gutter, bottom: 96 },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    ...shadow.floating,
  },
  text: { flexShrink: 1 },
});
