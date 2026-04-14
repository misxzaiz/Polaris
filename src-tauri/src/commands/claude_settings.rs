//! Claude Settings 文件读写命令

use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::error::{AppError, Result};

/// Claude settings.json 结构
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_plugins: Option<HashMap<String, bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_known_marketplaces: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_mode: Option<AutoModeCustomRules>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

/// 自定义自动模式规则
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoModeCustomRules {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub soft_deny: Vec<String>,
}

fn get_settings_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("settings.json")
}

#[tauri::command]
pub async fn read_claude_settings() -> Result<ClaudeSettings> {
    let path = get_settings_path();
    if !path.exists() {
        return Ok(ClaudeSettings::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AppError::ProcessError(format!("读取 settings.json 失败: {}", e)))?;
    let settings: ClaudeSettings = serde_json::from_str(&content)
        .map_err(|e| AppError::ProcessError(format!("解析 settings.json 失败: {}", e)))?;
    Ok(settings)
}

#[tauri::command]
pub async fn write_claude_settings(settings: ClaudeSettings) -> Result<()> {
    let path = get_settings_path();
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::ProcessError(format!("创建目录失败: {}", e)))?;
        }
    }
    if path.exists() {
        let backup_path = path.with_extension("json.bak");
        let _ = std::fs::copy(&path, &backup_path);
    }
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| AppError::ProcessError(format!("序列化失败: {}", e)))?;
    std::fs::write(&path, content)
        .map_err(|e| AppError::ProcessError(format!("写入文件失败: {}", e)))?;
    Ok(())
}

#[tauri::command]
pub async fn get_claude_settings_path() -> Result<String> {
    Ok(get_settings_path().to_string_lossy().to_string())
}
