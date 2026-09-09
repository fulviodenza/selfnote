/**
 * Desktop (Tauri) shell integration. The same web bundle runs in browsers and
 * in the Tauri webview; these helpers no-op outside the desktop shell.
 *
 * `withGlobalTauri` is enabled in tauri.conf.json, so the v2 API is reachable
 * as `window.__TAURI__` without adding @tauri-apps/api as a web dependency.
 */

interface TauriWindowApi {
  getCurrentWindow?: () => { close: () => Promise<void> };
}

interface TauriGlobal {
  window?: TauriWindowApi;
}

/** True when running inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

/**
 * Close the desktop window (Selfnote has a single window, so this quits).
 * Returns false in a plain browser, where pages cannot close themselves.
 */
export function closeDesktopWindow(): boolean {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  const win = tauri?.window?.getCurrentWindow?.();
  if (!win) return false;
  void win.close();
  return true;
}
