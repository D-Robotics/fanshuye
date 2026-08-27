mod auth_events;
mod cache;
mod credentials;
mod preferences;
mod security;
mod shortcut_policy;
mod shortcuts;
mod window_geometry;
mod windows;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_window_state::StateFlags;

fn persisted_window_state_flags() -> StateFlags {
    StateFlags::SIZE
        | StateFlags::POSITION
        | StateFlags::MAXIMIZED
        | StateFlags::DECORATIONS
        | StateFlags::FULLSCREEN
}

fn fallback_tray_icon() -> Image<'static> {
    const SIDE: u32 = 32;
    let mut rgba = vec![0_u8; (SIDE * SIDE * 4) as usize];
    for y in 0..SIDE {
        for x in 0..SIDE {
            let dx = x as f64 - 16.0;
            let dy = y as f64 - 13.5;
            let leaf = (dx / 9.5).powi(2) + (dy / 12.0).powi(2) <= 1.0;
            let stem = (15..=17).contains(&x) && (24..=30).contains(&y);
            let vein = leaf && (dx - dy * 0.12).abs() < 1.0;
            let color = if vein {
                Some([210, 238, 172, 255])
            } else if leaf {
                Some([65, 135, 71, 255])
            } else if stem {
                Some([117, 86, 50, 255])
            } else {
                None
            };
            if let Some(pixel) = color {
                let offset = ((y * SIDE + x) * 4) as usize;
                rgba[offset..offset + 4].copy_from_slice(&pixel);
            }
        }
    }
    Image::new_owned(rgba, SIDE, SIDE)
}

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_tree = MenuItem::with_id(app, "show-tree", "显示/隐藏任务树", true, None::<&str>)?;
    let show_main = MenuItem::with_id(app, "show-main", "打开完整面板", true, None::<&str>)?;
    let privacy = MenuItem::with_id(app, "toggle-privacy", "切换隐私模式", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出番薯叶", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_tree, &show_main, &privacy, &quit])?;

    let mut builder = TrayIconBuilder::with_id("fanshuye")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("番薯叶 · 开发组任务态势")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show-tree" => {
                let _ = windows::toggle_overlay(app);
            }
            "show-main" => {
                let _ = windows::show_main(app);
            }
            "toggle-privacy" => {
                let _ = app.emit("toggle-privacy", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = windows::toggle_overlay(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        builder = builder.icon(fallback_tray_icon());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tray_icon_is_visible_and_has_a_transparent_boundary() {
        let icon = fallback_tray_icon();
        assert_eq!((icon.width(), icon.height()), (32, 32));
        assert_eq!(icon.rgba().len(), 32 * 32 * 4);
        assert_eq!(icon.rgba()[3], 0);
        assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] == 255));
    }

    #[test]
    fn tauri_config_has_two_windows_and_a_fixed_strict_connect_policy() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let windows = config["app"]["windows"]
            .as_array()
            .expect("window configuration");
        let labels = windows
            .iter()
            .map(|window| window["label"].as_str().expect("window label"))
            .collect::<Vec<_>>();
        assert_eq!(labels, ["main", "overlay"]);
        let overlay = windows
            .iter()
            .find(|window| window["label"] == "overlay")
            .expect("overlay window");
        assert_eq!(overlay["transparent"], true);
        assert_eq!(overlay["decorations"], false);
        assert_eq!(overlay["alwaysOnTop"], true);
        assert_eq!(overlay["focus"], false);

        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("content security policy");
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(csp.contains("script-src 'self'"));
        assert!(!csp.contains("'unsafe-eval'"));
        assert!(!csp.contains("connect-src *"));
        assert!(!csp.contains("localhost"));
        assert!(!csp.contains("127.0.0.1"));
        assert!(csp.contains("https://api.fanshuye.app"));

        let dev_csp = config["app"]["security"]["devCsp"]
            .as_str()
            .expect("development content security policy");
        assert!(dev_csp.contains("http://127.0.0.1:4310"));
        assert!(dev_csp.contains("ws://127.0.0.1:4310"));
    }

    #[test]
    fn desktop_capability_exposes_only_core_and_confirmed_cache_sql() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json"))
                .expect("valid capability");
        assert_eq!(
            capability["windows"],
            serde_json::json!(["main", "overlay"])
        );
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "sql:allow-load",
                "sql:allow-select",
                "sql:allow-execute"
            ])
        );
    }

    #[test]
    fn persisted_window_state_never_restores_visibility_or_startup_focus() {
        let flags = persisted_window_state_flags();
        assert!(!flags.contains(StateFlags::VISIBLE));
        assert!(flags.contains(StateFlags::SIZE));
        assert!(flags.contains(StateFlags::POSITION));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| {
                let _ = windows::show_main(app);
            },
        ))
        .plugin(security::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(persisted_window_state_flags())
                .with_denylist(&["overlay"])
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = windows::toggle_overlay(app);
                    }
                })
                .build(),
        )
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:fanshuye-cache.db", cache::migrations())
                .build(),
        )
        .manage(preferences::PreferenceMutationState::new())
        .setup(|app| {
            // Shortcut conflicts are recorded as a non-sensitive runtime status and
            // must never prevent the independently accessible tray from starting.
            let shortcut_status = shortcuts::register_configured_shortcut(app.handle());
            app.manage(shortcuts::ShortcutRuntimeState::new(shortcut_status));
            create_tray(app)?;
            windows::initialize_overlay(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(windows::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            auth_events::publish_auth_state,
            credentials::store_refresh_credential,
            credentials::read_refresh_credential,
            credentials::delete_refresh_credential,
            preferences::load_desktop_preferences,
            preferences::patch_desktop_preference,
            preferences::set_autostart_enabled,
            preferences::show_summary_notification,
            shortcuts::set_global_shortcut,
            shortcuts::get_global_shortcut_status,
            windows::set_overlay_mode,
            windows::get_overlay_state,
            windows::get_current_window_visibility,
            windows::list_available_monitors,
            windows::show_main_window,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Fanshuye desktop application");
}
