//! Selfnote desktop shell.
//!
//! Thin Tauri wrapper that loads the shared `@selfnote/web` bundle. All app logic,
//! sync, and offline persistence come from the same code the browser runs — the
//! desktop build just gives it a native window and a `selfnote://` deep-link scheme.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .run(tauri::generate_context!())
        .expect("error while running Selfnote desktop");
}
