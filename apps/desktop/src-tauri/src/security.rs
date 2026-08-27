use tauri::{plugin::TauriPlugin, Runtime, Url};

pub fn navigation_is_allowed(url: &Url, development: bool) -> bool {
    match url.scheme() {
        "tauri" | "asset" => {
            url.host_str().is_none_or(|host| host == "localhost") && url.port().is_none()
        }
        "http" | "https" if url.host_str() == Some("tauri.localhost") => url.port().is_none(),
        "http" if development => {
            matches!(url.host_str(), Some("localhost" | "127.0.0.1")) && url.port() == Some(1420)
        }
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-policy")
        .on_navigation(|_webview, url| navigation_is_allowed(url, cfg!(debug_assertions)))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(value: &str, development: bool) -> bool {
        navigation_is_allowed(&Url::parse(value).expect("valid test URL"), development)
    }

    #[test]
    fn production_navigation_is_local_application_only() {
        assert!(allowed("tauri://localhost/index.html?window=main", false));
        assert!(allowed("http://tauri.localhost/index.html", false));
        assert!(allowed("about:blank", false));
        assert!(!allowed("https://api.fanshuye.app/tasks", false));
        assert!(!allowed("https://example.com/phishing", false));
        assert!(!allowed("javascript:alert(1)", false));
        assert!(!allowed("data:text/html,unsafe", false));
        assert!(!allowed("http://tauri.localhost:4310/", false));
    }

    #[test]
    fn development_navigation_allows_only_the_fixed_vite_origin() {
        assert!(allowed("http://localhost:1420/?window=overlay", true));
        assert!(allowed("http://127.0.0.1:1420/", true));
        assert!(!allowed("http://localhost:4310/", true));
        assert!(!allowed("http://localhost:1421/", true));
        assert!(!allowed("https://localhost:1420/", true));
    }
}
