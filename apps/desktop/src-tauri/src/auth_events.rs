use serde::Serialize;
use tauri::{Emitter, Manager, WebviewWindow};

pub const AUTH_STATE_EVENT: &str = "desktop-auth-state-changed";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AuthState {
    Authenticated,
    Cleared,
}

impl AuthState {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "authenticated" => Ok(Self::Authenticated),
            "cleared" => Ok(Self::Cleared),
            _ => Err("身份状态格式无效".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Authenticated => "authenticated",
            Self::Cleared => "cleared",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatePayload {
    state: String,
    source_label: String,
}

#[tauri::command]
pub fn publish_auth_state(window: WebviewWindow, state: String) -> Result<(), String> {
    let state = AuthState::parse(&state)?;
    let payload = AuthStatePayload {
        state: state.as_str().into(),
        source_label: window.label().into(),
    };

    window
        .app_handle()
        .emit(AUTH_STATE_EVENT, payload)
        .map_err(|_| "无法同步身份状态".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_two_non_sensitive_auth_states() {
        assert_eq!(
            AuthState::parse("authenticated"),
            Ok(AuthState::Authenticated)
        );
        assert_eq!(AuthState::parse("cleared"), Ok(AuthState::Cleared));
        assert!(AuthState::parse("authenticating").is_err());
        assert!(AuthState::parse("authenticated ").is_err());
        assert!(AuthState::parse("").is_err());
    }

    #[test]
    fn payload_contains_no_account_or_credential_fields() {
        let value = serde_json::to_value(AuthStatePayload {
            state: AuthState::Authenticated.as_str().into(),
            source_label: "main".into(),
        })
        .expect("serializable auth state");

        assert_eq!(
            value,
            serde_json::json!({
                "state": "authenticated",
                "sourceLabel": "main"
            })
        );
    }
}
