use std::{str::FromStr, sync::Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_store::StoreExt;

use crate::shortcut_policy::{
    register_startup_with, switch_with_rollback, StartupRegistration, SwitchFailure,
    DEFAULT_GLOBAL_SHORTCUT,
};

const STORE_PATH: &str = "preferences.json";
const STORE_KEY: &str = "globalShortcut";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutStatus {
    active_shortcut: Option<String>,
    using_fallback: bool,
    issue: Option<&'static str>,
}

impl GlobalShortcutStatus {
    fn configured(active_shortcut: String) -> Self {
        Self {
            active_shortcut: Some(active_shortcut),
            using_fallback: false,
            issue: None,
        }
    }

    fn fallback() -> Self {
        Self {
            active_shortcut: Some(DEFAULT_GLOBAL_SHORTCUT.into()),
            using_fallback: true,
            issue: Some("configuredShortcutUnavailable"),
        }
    }

    fn unavailable() -> Self {
        Self {
            active_shortcut: None,
            using_fallback: false,
            issue: Some("shortcutUnavailable"),
        }
    }
}

pub struct ShortcutRuntimeState(Mutex<GlobalShortcutStatus>);

impl ShortcutRuntimeState {
    pub fn new(status: GlobalShortcutStatus) -> Self {
        Self(Mutex::new(status))
    }

    fn snapshot(&self) -> Result<GlobalShortcutStatus, String> {
        self.0
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "无法读取全局快捷键状态".to_string())
    }

    fn replace(&self, status: GlobalShortcutStatus) -> Result<(), String> {
        *self
            .0
            .lock()
            .map_err(|_| "无法更新全局快捷键状态".to_string())? = status;
        Ok(())
    }
}

pub fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("全局快捷键格式无效".into());
    }
    let shortcut = Shortcut::from_str(trimmed).map_err(|_| "全局快捷键格式无效".to_string())?;
    if !shortcut
        .mods
        .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER)
    {
        return Err("全局快捷键必须包含至少一个修饰键".into());
    }
    Ok(shortcut)
}

fn stored_shortcut(app: &AppHandle) -> Option<String> {
    app.store(STORE_PATH)
        .ok()?
        .get(STORE_KEY)?
        .as_str()
        .map(ToOwned::to_owned)
}

pub fn configured_shortcut(app: &AppHandle) -> String {
    std::env::var("FANSHUYE_GLOBAL_SHORTCUT")
        .ok()
        .filter(|value| parse_shortcut(value).is_ok())
        .or_else(|| stored_shortcut(app).filter(|value| parse_shortcut(value).is_ok()))
        .unwrap_or_else(|| DEFAULT_GLOBAL_SHORTCUT.to_string())
}

pub fn register_configured_shortcut(app: &AppHandle) -> GlobalShortcutStatus {
    let configured = configured_shortcut(app);
    match register_startup_with(&configured, |value| replace_registered_shortcut(app, value)) {
        StartupRegistration::Configured(active) => GlobalShortcutStatus::configured(active),
        StartupRegistration::DefaultFallback => GlobalShortcutStatus::fallback(),
        StartupRegistration::Unavailable => GlobalShortcutStatus::unavailable(),
    }
}

fn replace_registered_shortcut(app: &AppHandle, value: &str) -> Result<(), String> {
    let shortcut = parse_shortcut(value)?;
    app.global_shortcut()
        .unregister_all()
        .map_err(|_| "无法更新全局快捷键".to_string())?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|_| "全局快捷键已被其他应用占用".to_string())
}

fn status_after_failed_switch(
    failure: &SwitchFailure,
    issue: &'static str,
) -> GlobalShortcutStatus {
    match failure.active_after_failure.as_deref() {
        Some(active) => GlobalShortcutStatus {
            active_shortcut: Some(active.into()),
            using_fallback: active == DEFAULT_GLOBAL_SHORTCUT,
            issue: Some(issue),
        },
        None => GlobalShortcutStatus {
            active_shortcut: None,
            using_fallback: false,
            issue: Some(issue),
        },
    }
}

fn persist_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|_| "无法保存全局快捷键".to_string())?;
    store.set(STORE_KEY, shortcut);
    store.save().map_err(|_| "无法保存全局快捷键".to_string())
}

fn restore_persisted_shortcut(app: &AppHandle, previous: Option<&str>) {
    let Ok(store) = app.store(STORE_PATH) else {
        return;
    };
    if let Some(previous) = previous {
        store.set(STORE_KEY, previous);
    } else {
        store.delete(STORE_KEY);
    }
    let _ = store.save();
}

#[tauri::command]
pub fn set_global_shortcut(
    app: AppHandle,
    state: State<'_, ShortcutRuntimeState>,
    shortcut: String,
) -> Result<(), String> {
    if std::env::var_os("FANSHUYE_GLOBAL_SHORTCUT").is_some() {
        return Err("全局快捷键由环境配置管理".into());
    }
    let normalized = parse_shortcut(&shortcut)?.to_string();
    let previous_status = state.snapshot()?;
    let previous_persisted = stored_shortcut(&app);
    if let Err(failure) = switch_with_rollback(
        &normalized,
        previous_status.active_shortcut.as_deref(),
        |value| replace_registered_shortcut(&app, value),
    ) {
        state.replace(status_after_failed_switch(
            &failure,
            "requestedShortcutUnavailable",
        ))?;
        return Err(failure.message);
    }

    if let Err(error) = persist_shortcut(&app, &normalized) {
        restore_persisted_shortcut(&app, previous_persisted.as_deref());
        let restored = previous_status
            .active_shortcut
            .as_deref()
            .and_then(|previous| {
                replace_registered_shortcut(&app, previous)
                    .ok()
                    .map(|_| previous.to_string())
            })
            .or_else(|| {
                replace_registered_shortcut(&app, DEFAULT_GLOBAL_SHORTCUT)
                    .ok()
                    .map(|_| DEFAULT_GLOBAL_SHORTCUT.to_string())
            });
        let rollback = SwitchFailure {
            message: error.clone(),
            active_after_failure: restored,
        };
        state.replace(status_after_failed_switch(
            &rollback,
            "shortcutPersistenceFailed",
        ))?;
        return Err(error);
    }

    state.replace(GlobalShortcutStatus::configured(normalized))
}

#[tauri::command]
pub fn get_global_shortcut_status(
    state: State<'_, ShortcutRuntimeState>,
) -> Result<GlobalShortcutStatus, String> {
    state.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_requires_a_modifier_and_has_a_bounded_length() {
        assert!(parse_shortcut(DEFAULT_GLOBAL_SHORTCUT).is_ok());
        assert!(parse_shortcut("Alt+KeyF").is_ok());
        assert!(parse_shortcut("Space").is_err());
        assert!(parse_shortcut("").is_err());
        assert!(parse_shortcut(&format!("Control+{}", "X".repeat(70))).is_err());
    }
}
