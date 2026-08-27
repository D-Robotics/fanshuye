const SERVICE_NAME: &str = "com.fanshuye.desktop.refresh";

fn validate_account_id(account_id: &str) -> Result<(), String> {
    if account_id.is_empty() || account_id.len() > 128 {
        return Err("账号标识格式无效".into());
    }
    if !account_id.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '@' | '.')
    }) {
        return Err("账号标识格式无效".into());
    }
    Ok(())
}

fn entry(account_id: &str) -> Result<keyring::Entry, String> {
    validate_account_id(account_id)?;
    keyring::Entry::new(SERVICE_NAME, account_id).map_err(|_| "无法访问系统凭据存储".into())
}

#[tauri::command]
pub fn store_refresh_credential(account_id: String, credential: String) -> Result<(), String> {
    if credential.is_empty() || credential.len() > 8_192 {
        return Err("凭据格式无效".into());
    }
    entry(&account_id)?
        .set_password(&credential)
        .map_err(|_| "无法保存系统凭据".into())
}

#[tauri::command]
pub fn read_refresh_credential(account_id: String) -> Result<String, String> {
    entry(&account_id)?
        .get_password()
        .map_err(|_| "系统凭据不可用".into())
}

#[tauri::command]
pub fn delete_refresh_credential(account_id: String) -> Result<(), String> {
    entry(&account_id)?
        .delete_credential()
        .map_err(|_| "无法删除系统凭据".into())
}
