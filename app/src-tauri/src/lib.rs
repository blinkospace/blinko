#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use desktop::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_blinko::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
                // Called when a second instance tries to start
                println!("Second instance detected with args: {:?} and cwd: {:?}", args, cwd);

                // Show and focus the existing window
                if let Some(window) = app.get_webview_window("main") {
                    // Show window if it's hidden
                    if let Err(e) = window.show() {
                        eprintln!("Failed to show window: {}", e);
                    }

                    // Unminimize if minimized
                    if let Err(e) = window.unminimize() {
                        eprintln!("Failed to unminimize window: {}", e);
                    }

                    // Bring to front and focus
                    if let Err(e) = window.set_focus() {
                        eprintln!("Failed to focus window: {}", e);
                    }

                    println!("Focused existing Blinko window");
                }
            }))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(create_global_shortcut_handler())
                    .build()
            );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder
            .invoke_handler(tauri::generate_handler![
                toggle_editor_window,
                register_hotkey,
                unregister_hotkey,
                get_registered_shortcuts,
                toggle_quicknote_window,
                resize_quicknote_window,
                toggle_quickai_window,
                resize_quickai_window,
                navigate_main_to_ai_with_prompt,
                toggle_quicktool_window,
                hide_quicktool_window,
                setup_text_selection_monitoring,
                copy_to_clipboard,
                test_text_selection,
                check_accessibility_permissions,
                show_quicktool,
                set_desktop_theme,
                set_desktop_colors
            ])
            .setup(|app| {
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                {
                    use tauri_plugin_autostart::MacosLauncher;

                    let _ = app.handle().plugin(tauri_plugin_autostart::init(
                        MacosLauncher::LaunchAgent,
                        Some(vec!["--autostart"]),
                    ));
                }

                setup_app(app)?;
                Ok(())
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        builder
            .invoke_handler(tauri::generate_handler![])
            .setup(|_app| {
                Ok(())
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}