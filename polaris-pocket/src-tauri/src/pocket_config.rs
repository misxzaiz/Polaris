/// Pocket 配置命令模块
/// 持久化 Pocket 本地配置到设备存储

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const CONFIG_DIR: &str = "polaris-pocket";
const CONFIG_FILE: &str = "pocket-config.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PocketConfig {
    #[serde(default)]
    pub api_base: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub server_token: String,
    #[serde(default)]
    pub agnes_api_base: String,
    #[serde(default)]
    pub agnes_api_key: String,
}

use tauri::AppHandle;

fn config_path(handle: &AppHandle) -> PathBuf {
    let dir = handle.path().config_dir().unwrap_or_else(|_| PathBuf::from("."));
    dir.join(CONFIG_DIR).join(CONFIG_FILE)
}

#[tauri::command]
pub fn pocket_get_config(app: tauri::AppHandle) -> PocketConfig {
    let path = config_path(&app);
    if !path.exists() {
        return PocketConfig::default();
    }
    match fs::read_to_string(&path) {
        Ok(c) if !c.trim().is_empty() => serde_json::from_str(&c).unwrap_or_default(),
        _ => PocketConfig::default(),
    }
}

#[tauri::command]
pub fn pocket_save_config(
    app: tauri::AppHandle,
    api_base: String,
    api_key: String,
    model: String,
    server_url: String,
    server_token: String,
    agnes_api_base: String,
    agnes_api_key: String,
) -> Result<(), String> {
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let config = PocketConfig {
        api_base,
        api_key,
        model,
        server_url,
        server_token,
        agnes_api_base,
        agnes_api_key,
    };
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}