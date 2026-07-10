use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

const MOBILE_SERVER_CONFIG_FILE: &str = "mobile-server-config.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileServerConfig {
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub token: String,
}

fn config_path() -> PathBuf {
    data_root().config_dir().join(MOBILE_SERVER_CONFIG_FILE)
}

fn read_config_inner() -> Result<MobileServerConfig> {
    let path = config_path();
    if !path.exists() {
        return Ok(MobileServerConfig::default());
    }

    let content = fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(MobileServerConfig::default());
    }

    serde_json::from_str(&content).map_err(|e| {
        AppError::ConfigError(format!(
            "mobile-server-config.json 解析失败: {} ({})",
            e,
            path.display()
        ))
    })
}

fn write_config_inner(config: &MobileServerConfig) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(config)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn get_server_config() -> Result<MobileServerConfig> {
    read_config_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn set_server_config(server_url: String, token: String) -> Result<()> {
    write_config_inner(&MobileServerConfig { server_url, token })
}
