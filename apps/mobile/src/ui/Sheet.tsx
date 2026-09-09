import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { radius, shadow, spacing } from "../theme";
import { useTheme } from "../theme-context";
import { IconButton } from "./IconButton";

/**
 * Bottom sheet: a scrim + a surface panel with a grabber and a close button.
 * Mount/unmount is controlled by the caller. Slides in on mount; dragging the
 * grabber/header (or tapping the scrim / X) slides it out, and a downward
 * fling anywhere on the handle dismisses. Content scrolls when taller than
 * the height cap.
 */
export function Sheet({
  title,
  onClose,
  children,
  scroll = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wrap children in a ScrollView (default). Pass false for self-scrolling content. */
  scroll?: boolean;
}) {
  const { colors, type } = useTheme();
  const screenH = Dimensions.get("window").height;
  const translateY = useRef(new Animated.Value(screenH)).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useRef(() => {
    Animated.timing(translateY, {
      toValue: Dimensions.get("window").height,
      duration: 180,
      useNativeDriver: true,
    }).start(() => onCloseRef.current());
  }).current;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue: 0,
      useNativeDriver: true,
      damping: 24,
      stiffness: 260,
      mass: 0.9,
    }).start();
  }, [translateY]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 120 || g.vy > 0.8) close();
        else
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            damping: 24,
            stiffness: 260,
            mass: 0.9,
          }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  const body = scroll ? (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={styles.content}>{children}</View>
  );

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={close} accessibilityLabel="Close" />
      <Animated.View
        style={[
          styles.panel,
          { backgroundColor: colors.surface, maxHeight: screenH * 0.88, transform: [{ translateY }] },
        ]}
      >
        <View {...pan.panHandlers}>
          <View style={[styles.grabber, { backgroundColor: colors.hairline }]} />
          <View style={styles.header}>
            <Text style={type.title}>{title}</Text>
            <IconButton icon="x" label="Close" onPress={close} />
          </View>
        </View>
        {body}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(20,22,28,0.45)" },
  panel: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
    ...shadow.floating,
  },
  content: { gap: spacing.lg, paddingBottom: spacing.xxxl, paddingTop: spacing.lg },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: radius.full,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
