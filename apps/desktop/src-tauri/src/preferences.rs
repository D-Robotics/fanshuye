use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopPreferences {
    privacy_mode: bool,
    reduced_motion: bool,
    do_not_disturb: bool,
    autostart: bool,
    preferred_monitor: Option<String>,
    selected_workspace_id: Option<String>,
    edge: String,
}

impl DesktopPreferences {
    pub(crate) fn preferred_monitor(&self) -> Option<&str> {
        self.preferred_monitor.as_deref()
    }

    pub(crate) fn edge(&self) -> &str {
        &self.edge
    }
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            privacy_mode: false,
            reduced_motion: false,
            do_not_disturb: false,
            autostart: false,
            preferred_monitor: None,
            selected_workspace_id: None,
            edge: "right".into(),
        }
    }
}

#[tauri::command]
pub fn load_desktop_preferences(app: AppHandle) -> Result<DesktopPreferences, String> {
    let mut preferences = try_read_desktop_preferences(&app)?;
    preferences.autostart = app
        .autolaunch()
        .is_enabled()
        .map_err(|_| "无法读取开机启动状态".to_string())?;
    Ok(preferences)
}

pub struct PreferenceMutationState(Mutex<()>);

impl PreferenceMutationState {
    pub fn new() -> Self {
        Self(Mutex::new(()))
    }
}

fn try_read_desktop_preferences(app: &AppHandle) -> Result<DesktopPreferences, String> {
    let store = app
        .store("preferences.json")
        .map_err(|_| "无法读取桌面偏好".to_string())?;
    let Some(value) = store.get("desktopPreferences") else {
        return Ok(DesktopPreferences::default());
    };
    let preferences: DesktopPreferences = serde_json::from_value(value)
        .map_err(|_| "桌面偏好已损坏，请先修复或移除偏好文件".to_string())?;
    validate_preferences(&preferences)?;
    Ok(preferences)
}

pub(crate) fn read_desktop_preferences(app: &AppHandle) -> DesktopPreferences {
    try_read_desktop_preferences(app).unwrap_or_default()
}

fn validate_preferences(preferences: &DesktopPreferences) -> Result<(), String> {
    if !matches!(preferences.edge.as_str(), "left" | "right") {
        return Err("悬浮窗边缘设置无效".into());
    }
    if preferences.preferred_monitor.as_ref().is_some_and(|name| {
        name.trim().is_empty() || name.len() > 160 || name.chars().any(char::is_control)
    }) {
        return Err("首选显示器设置无效".into());
    }
    if preferences
        .selected_workspace_id
        .as_ref()
        .is_some_and(|value| !valid_uuid_shape(value))
    {
        return Err("团队空间设置无效".into());
    }
    Ok(())
}

fn persist_preferences(app: &AppHandle, preferences: &DesktopPreferences) -> Result<(), String> {
    validate_preferences(preferences)?;
    let store = app
        .store("preferences.json")
        .map_err(|_| "无法保存桌面偏好".to_string())?;
    let value = serde_json::to_value(preferences).map_err(|_| "桌面偏好格式无效".to_string())?;
    store.set("desktopPreferences", value);
    store.save().map_err(|_| "无法保存桌面偏好".to_string())?;
    let _ = app.emit("desktop-preferences-changed", preferences.clone());
    Ok(())
}

fn apply_preference_patch(
    preferences: &mut DesktopPreferences,
    key: &str,
    value: serde_json::Value,
) -> Result<bool, String> {
    let geometry_changed = matches!(key, "preferredMonitor" | "edge");
    match key {
        "privacyMode" => {
            preferences.privacy_mode = value
                .as_bool()
                .ok_or_else(|| "隐私模式设置无效".to_string())?;
        }
        "reducedMotion" => {
            preferences.reduced_motion = value
                .as_bool()
                .ok_or_else(|| "减少动画设置无效".to_string())?;
        }
        "doNotDisturb" => {
            preferences.do_not_disturb =
                value.as_bool().ok_or_else(|| "勿扰设置无效".to_string())?;
        }
        "preferredMonitor" => {
            preferences.preferred_monitor = if value.is_null() {
                None
            } else {
                Some(
                    value
                        .as_str()
                        .ok_or_else(|| "首选显示器设置无效".to_string())?
                        .into(),
                )
            };
        }
        "selectedWorkspaceId" => {
            preferences.selected_workspace_id = if value.is_null() {
                None
            } else {
                Some(
                    value
                        .as_str()
                        .ok_or_else(|| "团队空间设置无效".to_string())?
                        .into(),
                )
            };
        }
        "edge" => {
            preferences.edge = value
                .as_str()
                .ok_or_else(|| "悬浮窗边缘设置无效".to_string())?
                .into();
        }
        "autostart" => return Err("开机启动必须使用系统设置命令".into()),
        _ => return Err("未知桌面偏好".into()),
    }
    Ok(geometry_changed)
}

#[tauri::command]
pub fn patch_desktop_preference(
    app: AppHandle,
    state: State<'_, PreferenceMutationState>,
    key: String,
    value: serde_json::Value,
) -> Result<DesktopPreferences, String> {
    let _guard = state
        .0
        .lock()
        .map_err(|_| "桌面偏好更新暂时不可用".to_string())?;
    let mut preferences = try_read_desktop_preferences(&app)?;
    preferences.autostart = app
        .autolaunch()
        .is_enabled()
        .map_err(|_| "无法读取开机启动状态".to_string())?;
    let geometry_changed = apply_preference_patch(&mut preferences, &key, value)?;
    persist_preferences(&app, &preferences)?;
    if geometry_changed {
        // Persistence is authoritative. A transient geometry API failure is
        // retried on the next monitor/DPI event or application start.
        let _ = crate::windows::recover_overlay(&app);
    }
    Ok(preferences)
}

fn valid_uuid_shape(value: &str) -> bool {
    value.len() == 36
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            })
}

#[tauri::command]
pub fn set_autostart_enabled(
    app: AppHandle,
    state: State<'_, PreferenceMutationState>,
    enabled: bool,
) -> Result<DesktopPreferences, String> {
    let _guard = state
        .0
        .lock()
        .map_err(|_| "开机启动更新暂时不可用".to_string())?;
    let mut stored_preferences = try_read_desktop_preferences(&app)?;
    let manager = app.autolaunch();
    let previous = manager
        .is_enabled()
        .map_err(|_| "无法读取开机启动状态".to_string())?;
    if previous != enabled {
        if enabled {
            manager
                .enable()
                .map_err(|_| "无法启用开机启动".to_string())?;
        } else {
            manager
                .disable()
                .map_err(|_| "无法关闭开机启动".to_string())?;
        }
    }

    stored_preferences.autostart = previous;
    let restore_previous_state = || {
        let system_restored = if previous == enabled {
            true
        } else if previous {
            manager.enable().is_ok()
        } else {
            manager.disable().is_ok()
        };
        let preferences_restored = persist_preferences(&app, &stored_preferences).is_ok();
        system_restored && preferences_restored
    };

    let actual = match manager.is_enabled() {
        Ok(actual) => actual,
        Err(_) => {
            return Err(if restore_previous_state() {
                "无法确认开机启动状态，已恢复原设置".into()
            } else {
                "无法确认开机启动状态，且恢复原设置失败；请检查 Windows 启动项".into()
            });
        }
    };
    if actual != enabled {
        return Err(if restore_previous_state() {
            "Windows 未接受开机启动设置，已恢复原设置".into()
        } else {
            "Windows 未接受开机启动设置，且恢复原设置失败；请检查 Windows 启动项".into()
        });
    }

    let mut preferences = stored_preferences.clone();
    preferences.autostart = actual;
    match persist_preferences(&app, &preferences) {
        Ok(()) => Ok(preferences),
        Err(error) => Err(if restore_previous_state() {
            format!("{error}；已恢复原设置")
        } else {
            format!("{error}；恢复原设置失败，请检查 Windows 启动项")
        }),
    }
}

#[tauri::command]
pub fn show_summary_notification(
    app: AppHandle,
    title: String,
    body: String,
    task_count: u32,
) -> Result<(), String> {
    let preferences = try_read_desktop_preferences(&app)?;
    let (title, body) = summary_notification_content(&preferences, &title, &body, task_count)?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|_| "无法显示系统通知".into())
}

fn summary_notification_content(
    preferences: &DesktopPreferences,
    title: &str,
    body: &str,
    task_count: u32,
) -> Result<(String, String), String> {
    if task_count == 0 || task_count > 1_000_000 {
        return Err("通知内容格式无效".into());
    }
    if preferences.privacy_mode {
        return Ok((
            "番薯叶任务提醒".into(),
            format!("{task_count} 项团队任务需要关注"),
        ));
    }
    if title.trim().is_empty() || title.chars().count() > 96 || body.chars().count() > 320 {
        return Err("通知内容格式无效".into());
    }
    Ok((title.into(), body.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_mode_replaces_every_caller_supplied_notification_field() {
        let preferences = DesktopPreferences {
            privacy_mode: true,
            ..DesktopPreferences::default()
        };
        let secret = "绝密任务标题";

        let content = summary_notification_content(&preferences, secret, secret, 7)
            .expect("privacy-safe notification");

        assert_eq!(
            content,
            ("番薯叶任务提醒".into(), "7 项团队任务需要关注".into())
        );
        assert!(!content.0.contains(secret));
        assert!(!content.1.contains(secret));
    }

    #[test]
    fn ordinary_notifications_preserve_valid_content_and_reject_invalid_counts() {
        let preferences = DesktopPreferences::default();
        assert_eq!(
            summary_notification_content(&preferences, "任务提醒", "任务正文", 1),
            Ok(("任务提醒".into(), "任务正文".into()))
        );
        assert!(summary_notification_content(&preferences, "任务提醒", "任务正文", 0).is_err());
    }

    #[test]
    fn per_field_patch_preserves_concurrent_preferences_and_validates_values() {
        let mut preferences = DesktopPreferences {
            privacy_mode: true,
            selected_workspace_id: Some("11111111-1111-4111-8111-111111111111".into()),
            ..DesktopPreferences::default()
        };

        assert_eq!(
            apply_preference_patch(&mut preferences, "edge", serde_json::json!("left")),
            Ok(true)
        );
        assert!(preferences.privacy_mode);
        assert_eq!(preferences.edge, "left");
        assert!(preferences.selected_workspace_id.is_some());
        assert!(
            apply_preference_patch(&mut preferences, "privacyMode", serde_json::json!("yes"))
                .is_err()
        );
        assert!(
            apply_preference_patch(&mut preferences, "autostart", serde_json::json!(true)).is_err()
        );
    }

    #[test]
    fn selected_workspace_requires_a_uuid_shape() {
        assert!(valid_uuid_shape("11111111-1111-4111-8111-111111111111"));
        assert!(!valid_uuid_shape("default"));
        assert!(!valid_uuid_shape("11111111-1111-4111-8111-11111111111z"));
    }

    #[test]
    fn malformed_field_does_not_deserialize_as_default_preferences() {
        let malformed = serde_json::json!({
            "privacyMode": true,
            "reducedMotion": "not-a-boolean",
            "edge": "right"
        });

        assert!(serde_json::from_value::<DesktopPreferences>(malformed).is_err());
    }
}
