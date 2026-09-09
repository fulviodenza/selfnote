//! Selfnote desktop shell.
//!
//! Thin Tauri wrapper that loads the shared `@selfnote/web` bundle. All app logic,
//! sync, and offline persistence come from the same code the browser runs — the
//! desktop build just gives it a native window and a `selfnote://` deep-link scheme.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // macOS: Tauri's default menu binds Cmd+W to "Close Window", which
            // would swallow the shortcut before the webview sees it — but in
            // Selfnote Cmd+W closes the active PAGE TAB (handled in the web
            // bundle). Rebuild the standard menu without that one accelerator;
            // Quit (Cmd+Q) and the Edit clipboard items stay native.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                let handle = app.handle();
                let app_menu = SubmenuBuilder::new(handle, "Selfnote")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let edit = SubmenuBuilder::new(handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window = SubmenuBuilder::new(handle, "Window")
                    .minimize()
                    .maximize()
                    .separator()
                    .fullscreen()
                    .build()?;
                let menu = MenuBuilder::new(handle)
                    .items(&[&app_menu, &edit, &window])
                    .build()?;
                app.set_menu(menu)?;
            }
            let _ = app; // silence unused on non-macOS targets
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Selfnote desktop");
}
