import { useEffect } from "react";
import { BackHandler } from "react-native";

/**
 * Handle the Android hardware/gesture back press. Return true to consume the
 * event (an overlay was closed, a screen popped), false to let it fall through
 * to handlers registered earlier — RN runs them LIFO, so a screen mounted on
 * top gets first refusal — and ultimately to the OS (which exits the app).
 * No-op on iOS.
 */
export function useAndroidBack(handler: () => boolean) {
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", handler);
    return () => sub.remove();
  }, [handler]);
}
