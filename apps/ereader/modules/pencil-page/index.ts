import { requireNativeView } from "expo";
import type * as React from "react";
import type { StyleProp, ViewStyle } from "react-native";

/** What the native side reports after ink changes: the PKDrawing binary for
 * lossless editing, and the same strokes as normalised vectors in the web
 * canvas's format so other platforms can display the page. */
export interface PencilChange {
  pk: string;
  v: string;
}

export interface PencilPageProps {
  /** Base64 PKDrawing to load. Wins over `vectors` when both are set. */
  drawing?: string | null;
  /** Legacy web-canvas strokes (JSON array) to raise into PKStrokes. */
  vectors?: string | null;
  onChange?: (e: { nativeEvent: PencilChange }) => void;
  style?: StyleProp<ViewStyle>;
}

export const PencilPageView: React.ComponentType<PencilPageProps> =
  requireNativeView("PencilPage");
