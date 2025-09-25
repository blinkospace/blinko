use tauri::{AppHandle, Manager};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use crate::desktop::hotkey::WindowConfig;

const WINDOW_STATE_FILE: &str = "window_state.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppWindowState {
    main_window: Option<WindowConfig>,
    quicknote_window: Option<WindowConfig>,
}

impl Default for AppWindowState {
    fn default() -> Self {
        Self {
            main_window: Some(WindowConfig::default()),
            quicknote_window: None,
        }
    }
}

// Get window state file path
fn get_window_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    
    // Ensure directory exists
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }
    
    Ok(app_data_dir.join(WINDOW_STATE_FILE))
}

// Load window state from file
pub fn load_window_state(app: &AppHandle) -> AppWindowState {
    match get_window_state_path(app) {
        Ok(path) => {
            if path.exists() {
                match fs::read_to_string(&path) {
                    Ok(content) => {
                        match serde_json::from_str::<AppWindowState>(&content) {
                            Ok(state) => {
                                return state;
                            }
                            Err(e) => {
                                eprintln!("Failed to parse window state: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to read window state file: {}", e);
                    }
                }
            } else {
                println!("Window state file does not exist, using defaults");
            }
        }
        Err(e) => {
            eprintln!("Failed to get window state path: {}", e);
        }
    }
    
    AppWindowState::default()
}

// Save window state to file
pub fn save_window_state(app: &AppHandle, state: &AppWindowState) {
    match get_window_state_path(app) {
        Ok(path) => {
            match serde_json::to_string_pretty(state) {
                Ok(content) => {
                    if let Err(e) = fs::write(&path, content) {
                        eprintln!("Failed to write window state to file: {}", e);
                    } else {
                        println!("Saved window state to: {}", path.display());
                    }
                }
                Err(e) => {
                    eprintln!("Failed to serialize window state: {}", e);
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to get window state path: {}", e);
        }
    }
}

// Apply window state to main window
pub fn restore_main_window_state(app: &AppHandle) {
    let window_state = load_window_state(app);

    if let Some(window) = app.get_webview_window("main") {
        if let Some(config) = window_state.main_window {
            // Only restore if not maximized, otherwise maximize will set the size
            if !config.maximized {
                // Use PhysicalSize to ensure exact pixel restoration
                let size = tauri::Size::Physical(tauri::PhysicalSize::new(config.width as u32, config.height as u32));
                if let Err(e) = window.set_size(size) {
                    eprintln!("Failed to restore window size: {}", e);
                } else {
                    println!("Restored window size: {}x{}", config.width, config.height);
                }

                // Center the window after setting size
                if let Err(e) = window.center() {
                    eprintln!("Failed to center window: {}", e);
                } else {
                    println!("Window centered successfully");
                }
            }

            // Restore maximized state
            if config.maximized {
                if let Err(e) = window.maximize() {
                    eprintln!("Failed to maximize window: {}", e);
                } else {
                    println!("Window maximized successfully");
                }
            }
        }

        // Show the window after restoring its state to prevent flickering
        if let Err(e) = window.show() {
            eprintln!("Failed to show window: {}", e);
        } else {
            println!("Window shown successfully after restoring state");
        }
    }
}

// Minimum window dimensions 
const MIN_WINDOW_WIDTH: f64 = 600.0;
const MIN_WINDOW_HEIGHT: f64 = 300.0;

// Save current main window state
pub fn save_main_window_state(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let mut window_state = load_window_state(app);

        // Get current window state - only size and maximized state
        if let (Ok(size), Ok(is_maximized), Ok(is_minimized)) = (
            window.inner_size(),
            window.is_maximized(),
            window.is_minimized()
        ) {
            let width = size.width as f64;
            let height = size.height as f64;

            // Don't save state if window is minimized or dimensions are too small
            if is_minimized || width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT {
                println!("Skipping window state save - minimized: {}, size: {}x{} (min: {}x{})",
                         is_minimized, width, height, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);
                return;
            }

            let config = WindowConfig {
                width,
                height,
                x: None,  // Don't save position, always center
                y: None,  // Don't save position, always center
                maximized: is_maximized,
            };

            window_state.main_window = Some(config.clone());
            save_window_state(app, &window_state);

            println!("Saved main window state: {}x{}, maximized: {}",
                     config.width, config.height, config.maximized);
        }
    }
}

// Setup window state monitoring - ONLY for main window
pub fn setup_window_state_monitoring(app: &AppHandle) {
    // Only monitor the main window for state saving
    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.clone();

        window.on_window_event(move |event| {
            match event {
                tauri::WindowEvent::Resized(_) => {
                    // Save state on resize (but only if not minimized and above minimum size)
                    save_main_window_state(&app_handle);
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    // Save state before closing (but only if not minimized and above minimum size)
                    save_main_window_state(&app_handle);
                }
                _ => {}
            }
        });

        println!("Window state monitoring setup ONLY for main window");
    } else {
        eprintln!("Failed to setup window state monitoring: main window not found");
    }
}