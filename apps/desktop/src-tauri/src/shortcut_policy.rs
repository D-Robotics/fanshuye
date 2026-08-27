pub const DEFAULT_GLOBAL_SHORTCUT: &str = "Control+Shift+Space";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartupRegistration {
    Configured(String),
    DefaultFallback,
    Unavailable,
}

pub fn register_startup_with<F>(configured: &str, mut replace: F) -> StartupRegistration
where
    F: FnMut(&str) -> Result<(), String>,
{
    if replace(configured).is_ok() {
        return StartupRegistration::Configured(configured.into());
    }
    if configured != DEFAULT_GLOBAL_SHORTCUT && replace(DEFAULT_GLOBAL_SHORTCUT).is_ok() {
        return StartupRegistration::DefaultFallback;
    }
    StartupRegistration::Unavailable
}

#[derive(Debug, Eq, PartialEq)]
pub struct SwitchFailure {
    pub message: String,
    pub active_after_failure: Option<String>,
}

pub fn switch_with_rollback<F>(
    requested: &str,
    previous: Option<&str>,
    mut replace: F,
) -> Result<(), SwitchFailure>
where
    F: FnMut(&str) -> Result<(), String>,
{
    let error = match replace(requested) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };

    if let Some(previous) = previous {
        if replace(previous).is_ok() {
            return Err(SwitchFailure {
                message: error,
                active_after_failure: Some(previous.into()),
            });
        }
    }
    if requested != DEFAULT_GLOBAL_SHORTCUT
        && previous != Some(DEFAULT_GLOBAL_SHORTCUT)
        && replace(DEFAULT_GLOBAL_SHORTCUT).is_ok()
    {
        return Err(SwitchFailure {
            message: error,
            active_after_failure: Some(DEFAULT_GLOBAL_SHORTCUT.into()),
        });
    }
    Err(SwitchFailure {
        message: error,
        active_after_failure: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_conflict_falls_back_without_failing_startup() {
        let mut attempts = Vec::new();
        let outcome = register_startup_with("Alt+KeyF", |value| {
            attempts.push(value.to_string());
            (value == DEFAULT_GLOBAL_SHORTCUT)
                .then_some(())
                .ok_or_else(|| "occupied".to_string())
        });
        assert_eq!(attempts, ["Alt+KeyF", DEFAULT_GLOBAL_SHORTCUT]);
        assert_eq!(outcome, StartupRegistration::DefaultFallback);
    }

    #[test]
    fn startup_continues_when_configured_and_default_are_both_occupied() {
        let outcome = register_startup_with("Alt+KeyF", |_value| Err("occupied".into()));
        assert_eq!(outcome, StartupRegistration::Unavailable);
    }

    #[test]
    fn dynamic_conflict_restores_the_previous_shortcut_and_returns_original_error() {
        let mut attempts = Vec::new();
        let failure = switch_with_rollback("Alt+KeyG", Some("Alt+KeyF"), |value| {
            attempts.push(value.to_string());
            if value == "Alt+KeyG" {
                Err("occupied".into())
            } else {
                Ok(())
            }
        })
        .expect_err("requested shortcut must conflict");
        assert_eq!(attempts, ["Alt+KeyG", "Alt+KeyF"]);
        assert_eq!(failure.message, "occupied");
        assert_eq!(failure.active_after_failure.as_deref(), Some("Alt+KeyF"));
    }

    #[test]
    fn dynamic_conflict_uses_default_only_when_previous_cannot_be_restored() {
        let mut attempts = Vec::new();
        let failure = switch_with_rollback("Alt+KeyG", Some("Alt+KeyF"), |value| {
            attempts.push(value.to_string());
            if value == DEFAULT_GLOBAL_SHORTCUT {
                Ok(())
            } else {
                Err("occupied".into())
            }
        })
        .expect_err("requested shortcut must conflict");
        assert_eq!(attempts, ["Alt+KeyG", "Alt+KeyF", DEFAULT_GLOBAL_SHORTCUT]);
        assert_eq!(
            failure.active_after_failure.as_deref(),
            Some(DEFAULT_GLOBAL_SHORTCUT)
        );
    }
}
