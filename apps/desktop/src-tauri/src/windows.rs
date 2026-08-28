use serde::{Deserialize, Serialize};
use tauri::{
    window::{Color, Monitor},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window,
    WindowEvent,
};
use tauri_plugin_store::StoreExt;

use crate::{
    preferences,
    window_geometry::{
        choose_monitor_index, horizontal_anchor, is_safely_visible, place_overlay, vertical_anchor,
        Edge, MonitorCandidate, OverlayMode, OverlayPresentation, PhysicalRect, PhysicalWindow,
    },
};

const STORE_PATH: &str = "preferences.json";
const STORE_KEY: &str = "overlayWindowState";
pub const OVERLAY_STATE_EVENT: &str = "desktop-overlay-state-changed";
pub const WINDOW_VISIBILITY_EVENT: &str = "desktop-window-visibility-changed";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStatePayload {
    pub mode: String,
    pub visible: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowVisibilityPayload {
    pub label: String,
    pub visible: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableMonitor {
    pub key: String,
    pub label: String,
    pub primary: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct SavedOverlayState {
    monitor_name: Option<String>,
    horizontal_anchor: Option<f64>,
    vertical_anchor: f64,
    mode: String,
    presentation: String,
}

impl Default for SavedOverlayState {
    fn default() -> Self {
        Self {
            monitor_name: None,
            horizontal_anchor: None,
            vertical_anchor: 0.2,
            mode: OverlayMode::Collapsed.as_str().into(),
            presentation: OverlayPresentation::Floating.as_str().into(),
        }
    }
}

fn load_overlay_state(app: &AppHandle) -> SavedOverlayState {
    let Ok(store) = app.store(STORE_PATH) else {
        return SavedOverlayState::default();
    };
    store
        .get(STORE_KEY)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn save_overlay_state(app: &AppHandle, state: &SavedOverlayState) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|_| "无法保存悬浮窗位置".to_string())?;
    store.set(
        STORE_KEY,
        serde_json::to_value(state).map_err(|_| "悬浮窗位置格式无效".to_string())?,
    );
    store.save().map_err(|_| "无法保存悬浮窗位置".to_string())
}

fn monitor_key(monitor: &Monitor) -> String {
    monitor.name().cloned().unwrap_or_else(|| {
        format!(
            "display@{},{}:{}x{}",
            monitor.position().x,
            monitor.position().y,
            monitor.size().width,
            monitor.size().height
        )
    })
}

fn monitor_label(monitor: &Monitor, index: usize) -> String {
    let name = monitor
        .name()
        .filter(|name| !name.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| format!("显示器 {}", index + 1));
    let scale_percent = (monitor.scale_factor() * 100.0).round() as u32;
    format!(
        "{} · {}×{} · {}%",
        name,
        monitor.size().width,
        monitor.size().height,
        scale_percent
    )
}

fn monitor_work_area(monitor: &Monitor) -> PhysicalRect {
    PhysicalRect {
        x: monitor.work_area().position.x,
        y: monitor.work_area().position.y,
        width: monitor.work_area().size.width,
        height: monitor.work_area().size.height,
    }
}

fn select_monitor(
    window: &WebviewWindow,
    preferred: Option<&str>,
    saved: Option<&str>,
) -> Result<Option<Monitor>, String> {
    let monitors = window
        .available_monitors()
        .map_err(|_| "无法读取显示器信息".to_string())?;
    if monitors.is_empty() {
        return Ok(None);
    }
    let primary_key = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_key(&monitor));
    let current_key = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_key(&monitor));
    let candidates = monitors
        .iter()
        .map(|monitor| {
            let key = monitor_key(monitor);
            MonitorCandidate {
                primary: primary_key.as_deref() == Some(key.as_str()),
                key,
            }
        })
        .collect::<Vec<_>>();
    let selected = choose_monitor_index(&candidates, preferred, saved, current_key.as_deref());
    Ok(selected.map(|index| monitors[index].clone()))
}

fn force_side_panel() -> bool {
    std::env::var("FANSHUYE_SIDE_PANEL")
        .ok()
        .is_some_and(|value| !matches!(value.trim(), "" | "0" | "false" | "FALSE"))
}

fn configure_floating(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_decorations(false)
        .and_then(|_| window.set_resizable(false))
        .and_then(|_| window.set_always_on_top(true))
        .and_then(|_| window.set_skip_taskbar(true))
        .and_then(|_| window.set_background_color(Some(Color(0, 0, 0, 0))))
        .map_err(|_| "透明悬浮窗不可用".to_string())
}

fn configure_side_panel(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_background_color(Some(Color(248, 250, 244, 255)))
        // The placement math targets the monitor work area using outer bounds.
        // Decorations would make the native frame exceed those exact bounds.
        .and_then(|_| window.set_decorations(false))
        .and_then(|_| window.set_resizable(false))
        .and_then(|_| window.set_always_on_top(false))
        .and_then(|_| window.set_skip_taskbar(true))
        .map_err(|_| "无法启用固定侧边面板".to_string())
}

fn configure_presentation(
    window: &WebviewWindow,
    requested: OverlayPresentation,
) -> Result<OverlayPresentation, String> {
    if requested == OverlayPresentation::Floating && !force_side_panel() {
        if configure_floating(window).is_ok() {
            return Ok(OverlayPresentation::Floating);
        }
    }
    configure_side_panel(window)?;
    Ok(OverlayPresentation::SidePanel)
}

fn apply_overlay_runtime(
    window: &WebviewWindow,
    mode: OverlayMode,
    requested_presentation: OverlayPresentation,
    state: &mut SavedOverlayState,
) -> Result<OverlayPresentation, String> {
    let presentation = configure_presentation(window, requested_presentation)?;
    window
        // Preview must accept an intentional click so it can transition to
        // pinned, but merely hovering it must not move editor focus.
        .set_focusable(mode != OverlayMode::Collapsed)
        .map_err(|_| "无法更新悬浮窗焦点策略".to_string())?;

    let app = window.app_handle();
    let preferences = preferences::read_desktop_preferences(app);
    let edge = Edge::parse(preferences.edge())?;
    let monitor = select_monitor(
        window,
        preferences.preferred_monitor(),
        state.monitor_name.as_deref(),
    )?;

    if let Some(monitor) = monitor {
        let placement = place_overlay(
            mode,
            presentation,
            monitor_work_area(&monitor),
            monitor.scale_factor(),
            edge,
            state.vertical_anchor,
            state.horizontal_anchor,
        );
        window
            .set_size(PhysicalSize::new(placement.width, placement.height))
            .map_err(|_| "无法调整悬浮窗口大小".to_string())?;
        window
            .set_position(PhysicalPosition::new(placement.x, placement.y))
            .map_err(|_| "无法恢复悬浮窗口位置".to_string())?;
        state.monitor_name = Some(monitor_key(&monitor));
    } else {
        let logical = mode.logical_size();
        window
            .set_size(tauri::LogicalSize::new(logical.width, logical.height))
            .map_err(|_| "无法调整悬浮窗口大小".to_string())?;
    }

    if mode.accepts_keyboard_focus() {
        window
            .set_focus()
            .map_err(|_| "无法聚焦固定任务树".to_string())?;
    }
    Ok(presentation)
}

fn rollback_overlay_transition(window: &WebviewWindow, previous_state: &SavedOverlayState) {
    let previous_mode = OverlayMode::parse(&previous_state.mode).unwrap_or(OverlayMode::Collapsed);
    let previous_presentation = OverlayPresentation::parse(&previous_state.presentation);
    let mut runtime_state = previous_state.clone();
    let _ = apply_overlay_runtime(
        window,
        previous_mode,
        previous_presentation,
        &mut runtime_state,
    );
    // store.set restores the in-process value even when the disk flush fails.
    // Rollback is single-level and never re-enters the transition function.
    let _ = save_overlay_state(window.app_handle(), previous_state);
    let _ = publish_overlay_state_for_saved(window, previous_state);
}

fn apply_overlay_mode_with_presentation(
    window: &WebviewWindow,
    mode: OverlayMode,
    requested_presentation: OverlayPresentation,
) -> Result<(), String> {
    if window.label() != "overlay" {
        return Err("该命令只允许悬浮窗口调用".into());
    }

    let app = window.app_handle();
    let previous_state = load_overlay_state(app);
    let mut next_state = previous_state.clone();
    let presentation =
        match apply_overlay_runtime(window, mode, requested_presentation, &mut next_state) {
            Ok(presentation) => presentation,
            Err(error) => {
                rollback_overlay_transition(window, &previous_state);
                return Err(error);
            }
        };
    next_state.mode = mode.as_str().into();
    next_state.presentation = presentation.as_str().into();
    if let Err(error) = save_overlay_state(app, &next_state) {
        rollback_overlay_transition(window, &previous_state);
        return Err(error);
    }
    publish_overlay_state(window).map(|_| ())
}

fn current_overlay_state(window: &WebviewWindow) -> Result<OverlayStatePayload, String> {
    let saved = load_overlay_state(window.app_handle());
    overlay_state_for_saved(window, &saved)
}

fn overlay_state_for_saved(
    window: &WebviewWindow,
    saved: &SavedOverlayState,
) -> Result<OverlayStatePayload, String> {
    let mode = OverlayMode::parse(&saved.mode).unwrap_or(OverlayMode::Collapsed);
    let visible = window
        .is_visible()
        .map_err(|_| "无法读取悬浮窗口显示状态".to_string())?;
    Ok(OverlayStatePayload {
        mode: mode.as_str().into(),
        visible,
    })
}

fn publish_window_visibility(app: &AppHandle, label: &str, visible: bool) -> Result<(), String> {
    app.emit(
        WINDOW_VISIBILITY_EVENT,
        WindowVisibilityPayload {
            label: label.into(),
            visible,
        },
    )
    .map_err(|_| "无法发布窗口显示状态".to_string())
}

fn publish_overlay_state(window: &WebviewWindow) -> Result<OverlayStatePayload, String> {
    let payload = current_overlay_state(window)?;
    publish_overlay_state_payload(window, payload)
}

fn publish_overlay_state_for_saved(
    window: &WebviewWindow,
    saved: &SavedOverlayState,
) -> Result<OverlayStatePayload, String> {
    let payload = overlay_state_for_saved(window, saved)?;
    publish_overlay_state_payload(window, payload)
}

fn publish_overlay_state_payload(
    window: &WebviewWindow,
    payload: OverlayStatePayload,
) -> Result<OverlayStatePayload, String> {
    let state_result = window
        .app_handle()
        .emit(OVERLAY_STATE_EVENT, payload.clone())
        .map_err(|_| "无法发布悬浮窗口状态".to_string());
    let visibility_result =
        publish_window_visibility(window.app_handle(), window.label(), payload.visible);
    state_result.and(visibility_result).map(|_| payload)
}

pub fn apply_overlay_mode(window: &WebviewWindow, mode: &str) -> Result<(), String> {
    let mode = OverlayMode::parse(mode)?;
    let state = load_overlay_state(window.app_handle());
    apply_overlay_mode_with_presentation(
        window,
        mode,
        OverlayPresentation::parse(&state.presentation),
    )
}

pub fn initialize_overlay(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗口不可用".to_string())?;
    let requested = if force_side_panel() {
        OverlayPresentation::SidePanel
    } else {
        OverlayPresentation::Floating
    };
    apply_overlay_mode_with_presentation(&window, OverlayMode::Collapsed, requested)?;
    window.show().map_err(|_| "无法显示悬浮窗口".to_string())?;
    publish_overlay_state(&window).map(|_| ())
}

#[tauri::command]
pub fn set_overlay_mode(window: WebviewWindow, mode: String) -> Result<(), String> {
    apply_overlay_mode(&window, &mode)
}

#[tauri::command]
pub fn get_overlay_state(app: AppHandle) -> Result<OverlayStatePayload, String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗口不可用".to_string())?;
    current_overlay_state(&window)
}

#[tauri::command]
pub fn get_current_window_visibility(
    window: WebviewWindow,
) -> Result<WindowVisibilityPayload, String> {
    let visible = window
        .is_visible()
        .map_err(|_| "无法读取窗口显示状态".to_string())?;
    Ok(WindowVisibilityPayload {
        label: window.label().into(),
        visible,
    })
}

#[tauri::command]
pub fn start_overlay_drag(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "overlay" {
        return Err("该命令只允许悬浮窗口调用".into());
    }
    window
        .start_dragging()
        .map_err(|_| "无法拖动悬浮窗口".to_string())
}

#[tauri::command]
pub fn list_available_monitors(app: AppHandle) -> Result<Vec<AvailableMonitor>, String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗口不可用".to_string())?;
    let primary_key = window
        .primary_monitor()
        .map_err(|_| "无法读取主显示器信息".to_string())?
        .map(|monitor| monitor_key(&monitor));
    let monitors = window
        .available_monitors()
        .map_err(|_| "无法读取显示器信息".to_string())?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let key = monitor_key(monitor);
            AvailableMonitor {
                primary: primary_key.as_deref() == Some(key.as_str()),
                label: monitor_label(monitor, index),
                key,
            }
        })
        .collect())
}

pub fn show_main(app: &AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay
            .hide()
            .map_err(|_| "无法在打开主面板前隐藏悬浮任务树".to_string())?;
        publish_overlay_state(&overlay)?;
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不可用".to_string())?;
    window.show().map_err(|_| "无法显示主窗口".to_string())?;
    publish_window_visibility(app, "main", true)?;
    window.set_focus().map_err(|_| "无法聚焦主窗口".to_string())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    show_main(&app)
}

#[tauri::command]
pub fn hide_current_window(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|_| "无法收起当前窗口".to_string())?;
    if window.label() == "overlay" {
        publish_overlay_state(&window).map(|_| ())
    } else {
        publish_window_visibility(window.app_handle(), window.label(), false)?;
        show_overlay_entry(window.app_handle())
    }
}

fn show_overlay_entry(app: &AppHandle) -> Result<(), String> {
    let overlay = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗口不可用".to_string())?;
    apply_overlay_mode(&overlay, OverlayMode::Collapsed.as_str())?;
    overlay
        .show()
        .map_err(|_| "无法恢复悬浮任务入口".to_string())?;
    publish_overlay_state(&overlay).map(|_| ())
}

#[tauri::command]
pub fn quit_application(app: AppHandle) {
    app.exit(0);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OverlayToggleAction {
    Hide,
    ShowPreview,
}

fn overlay_toggle_action(visible: bool, mode: OverlayMode) -> OverlayToggleAction {
    // A visible collapsed bud is the persistent entry, not an already-open
    // task tree. Tray/shortcut activation expands it; an open tree toggles off.
    if visible && mode != OverlayMode::Collapsed {
        OverlayToggleAction::Hide
    } else {
        OverlayToggleAction::ShowPreview
    }
}

pub fn toggle_overlay(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗口不可用".to_string())?;
    let state = current_overlay_state(&window)?;
    let mode = OverlayMode::parse(&state.mode).unwrap_or(OverlayMode::Collapsed);
    match overlay_toggle_action(state.visible, mode) {
        OverlayToggleAction::Hide => {
            window.hide().map_err(|_| "无法隐藏悬浮窗口".to_string())?;
            publish_overlay_state(&window).map(|_| ())
        }
        OverlayToggleAction::ShowPreview => {
            apply_overlay_mode(&window, OverlayMode::Preview.as_str())?;
            if !state.visible {
                window.show().map_err(|_| "无法显示悬浮窗口".to_string())?;
            }
            publish_overlay_state(&window).map(|_| ())
        }
    }
}

pub fn recover_overlay(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗口不可用".to_string())?;
    let state = load_overlay_state(app);
    let mode = OverlayMode::parse(&state.mode).unwrap_or(OverlayMode::Collapsed);
    apply_overlay_mode_with_presentation(
        &window,
        mode,
        OverlayPresentation::parse(&state.presentation),
    )
}

fn capture_overlay_placement(window: &WebviewWindow) -> Result<(), String> {
    let Some(monitor) = window
        .current_monitor()
        .map_err(|_| "无法读取显示器信息".to_string())?
    else {
        return Ok(());
    };
    let mut state = load_overlay_state(window.app_handle());
    let presentation = OverlayPresentation::parse(&state.presentation);
    let mode = OverlayMode::parse(&state.mode).unwrap_or(OverlayMode::Collapsed);
    let position = window
        .outer_position()
        .map_err(|_| "无法读取悬浮窗位置".to_string())?;
    let size = window
        .outer_size()
        .map_err(|_| "无法读取悬浮窗大小".to_string())?;
    if presentation == OverlayPresentation::Floating && mode == OverlayMode::Collapsed {
        state.horizontal_anchor = Some(horizontal_anchor(
            position.x,
            size.width,
            monitor_work_area(&monitor),
            monitor.scale_factor(),
        ));
        state.vertical_anchor = vertical_anchor(
            position.y,
            size.height,
            monitor_work_area(&monitor),
            monitor.scale_factor(),
        );
    }
    state.monitor_name = Some(monitor_key(&monitor));
    save_overlay_state(window.app_handle(), &state)
}

fn overlay_is_visible_on_a_monitor(window: &WebviewWindow) -> Result<bool, String> {
    let position = window
        .outer_position()
        .map_err(|_| "无法读取悬浮窗位置".to_string())?;
    let size = window
        .outer_size()
        .map_err(|_| "无法读取悬浮窗大小".to_string())?;
    let work_areas = window
        .available_monitors()
        .map_err(|_| "无法读取显示器信息".to_string())?
        .iter()
        .map(monitor_work_area)
        .collect::<Vec<_>>();
    Ok(is_safely_visible(
        PhysicalWindow {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        &work_areas,
    ))
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if window.hide().is_ok() {
            if window.label() == "overlay" {
                if let Some(overlay) = window.app_handle().get_webview_window("overlay") {
                    let _ = publish_overlay_state(&overlay);
                }
            } else {
                let _ = publish_window_visibility(window.app_handle(), window.label(), false);
                let _ = show_overlay_entry(window.app_handle());
            }
        }
        return;
    }
    if window.label() != "overlay" {
        return;
    }
    let Some(overlay) = window.app_handle().get_webview_window("overlay") else {
        return;
    };
    match event {
        WindowEvent::Moved(_) => {
            if overlay_is_visible_on_a_monitor(&overlay).unwrap_or(false) {
                let _ = capture_overlay_placement(&overlay);
            } else {
                let _ = recover_overlay(window.app_handle());
            }
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let _ = recover_overlay(window.app_handle());
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_state_payload_has_one_stable_camel_case_shape() {
        let value = serde_json::to_value(OverlayStatePayload {
            mode: "preview".into(),
            visible: true,
        })
        .expect("serializable overlay state");
        assert_eq!(
            value,
            serde_json::json!({ "mode": "preview", "visible": true })
        );
        assert_eq!(
            serde_json::to_value(WindowVisibilityPayload {
                label: "overlay".into(),
                visible: false,
            })
            .expect("serializable visibility state"),
            serde_json::json!({ "label": "overlay", "visible": false })
        );
    }

    #[test]
    fn old_saved_state_without_horizontal_anchor_remains_compatible() {
        let state: SavedOverlayState = serde_json::from_value(serde_json::json!({
            "monitorName": "primary",
            "verticalAnchor": 0.4,
            "mode": "collapsed",
            "presentation": "floating"
        }))
        .expect("legacy state remains readable");
        assert_eq!(state.horizontal_anchor, None);
        assert_eq!(state.vertical_anchor, 0.4);
    }

    #[test]
    fn tray_and_shortcut_expand_the_bud_then_toggle_visibility() {
        assert_eq!(
            overlay_toggle_action(true, OverlayMode::Collapsed),
            OverlayToggleAction::ShowPreview
        );
        assert_eq!(
            overlay_toggle_action(false, OverlayMode::Pinned),
            OverlayToggleAction::ShowPreview
        );
        assert_eq!(
            overlay_toggle_action(true, OverlayMode::Preview),
            OverlayToggleAction::Hide
        );
        assert_eq!(
            overlay_toggle_action(true, OverlayMode::Pinned),
            OverlayToggleAction::Hide
        );
    }
}
