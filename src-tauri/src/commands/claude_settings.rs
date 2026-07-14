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
    /// 权限规则（Claude Code 标准 permissions 字段：allow/deny/ask）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<ClaudePermissions>,
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

/// Claude Code 权限规则（settings.json 的 permissions 字段）。
/// 评估顺序 deny > ask > allow；通过 flatten 保留未知子字段（如 defaultMode），避免写回时丢失。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePermissions {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ask: Vec<String>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

fn get_settings_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("settings.json")
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
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

#[cfg_attr(feature = "tauri-app", tauri::command)]
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

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn get_claude_settings_path() -> Result<String> {
    Ok(get_settings_path().to_string_lossy().to_string())
}

/// 向 settings.json 的 permissions 列表追加规则（去重保序）。
/// kind: "allow" | "deny" | "ask"。返回更新后的完整 settings 供前端同步。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn add_claude_permission_rules(rules: Vec<String>, kind: String) -> Result<ClaudeSettings> {
    let mut settings = read_claude_settings().await?;
    let mut perms = settings.permissions.take().unwrap_or_default();
    {
        let list = match kind.as_str() {
            "allow" => &mut perms.allow,
            "deny" => &mut perms.deny,
            "ask" => &mut perms.ask,
            other => return Err(AppError::ProcessError(format!("未知权限列表类型: {}", other))),
        };
        for rule in rules {
            let rule = rule.trim().to_string();
            if !rule.is_empty() && !list.contains(&rule) {
                list.push(rule);
            }
        }
    }
    settings.permissions = Some(perms);
    write_claude_settings(settings.clone()).await?;
    Ok(settings)
}
