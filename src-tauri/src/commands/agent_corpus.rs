//! 专家/专家团 Tauri 命令
//!
//! 内置 corpus 已移除(2026-07):专家只来自项目级 `.polaris/agents/`,由 AI 经
//! MCP `save_agent` 自助维护;专家团存于 `<DataRoot>/agents/rosters-user.json`。
//!
//! 暴露给前端:
//! - `custom_agent_list/save/delete` —— 项目级自定义专家 CRUD
//! - `simple_ai_list_agents` —— SimpleAI 引擎可用 agent(项目级)
//! - `agent_corpus_rosters` —— 用户专家团列表(仅用户自建)
//! - `user_roster_save/delete` —— 用户专家团 CRUD

use std::path::PathBuf;

use crate::error::Result;
use crate::services::data_root::data_root;

/// 专家团与专家数据根目录:`<DataRoot>/agents/`
pub fn agents_dir() -> PathBuf {
    data_root().root().join("agents")
}

/// SimpleAI agent 列表条目(项目级)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleAiAgentItem {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub emoji: Option<String>,
    pub division: Option<String>,
}

/// 用户自建 roster 存储:<DataRoot>/agents/rosters-user.json
pub fn user_rosters_path() -> PathBuf {
    agents_dir().join("rosters-user.json")
}

fn load_user_rosters() -> Vec<serde_json::Value> {
    std::fs::read_to_string(user_rosters_path())
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| v.get("rosters").and_then(|r| r.as_array().cloned()))
        .unwrap_or_default()
}

fn save_user_rosters(rosters: &[serde_json::Value]) -> Result<()> {
    let payload = serde_json::json!({ "rosters": rosters });
    std::fs::create_dir_all(agents_dir())?;
    std::fs::write(user_rosters_path(), serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}

/// rosters 透传:仅用户自建(标 custom:true)。内置 rosters.json 已移除。
pub fn corpus_rosters_inner() -> Result<serde_json::Value> {
    let rosters: Vec<serde_json::Value> = load_user_rosters()
        .into_iter()
        .map(|mut r| {
            r["custom"] = serde_json::Value::Bool(true);
            r
        })
        .collect();
    Ok(serde_json::json!({ "rosters": rosters }))
}

/// 保存用户自建 roster(同 slug 覆盖);members 即 always 组
pub fn user_roster_save_inner(
    slug: &str,
    title: &str,
    summary: &str,
    members: Vec<String>,
) -> Result<()> {
    validate_custom_slug(slug)?;
    if title.trim().is_empty() || members.is_empty() {
        return Err(crate::error::AppError::ValidationError(
            "名称与成员不能为空".into(),
        ));
    }
    let roster = serde_json::json!({
        "slug": slug,
        "title": title.trim(),
        "mode": "Custom",
        "duration": "-",
        "summary": summary.trim(),
        "groups": [{ "group": "Core Team", "activation": "always", "members": members }],
    });
    let mut rosters = load_user_rosters();
    rosters.retain(|r| r.get("slug").and_then(|s| s.as_str()) != Some(slug));
    rosters.push(roster);
    save_user_rosters(&rosters)
}

pub fn user_roster_delete_inner(slug: &str) -> Result<()> {
    validate_custom_slug(slug)?;
    let mut rosters = load_user_rosters();
    rosters.retain(|r| r.get("slug").and_then(|s| s.as_str()) != Some(slug));
    save_user_rosters(&rosters)
}

// ============================================================================
// 自定义专家(项目级 .polaris/agents)
// ============================================================================

fn custom_agents_dir(work_dir: &str) -> PathBuf {
    std::path::Path::new(work_dir).join(".polaris").join("agents")
}

fn validate_custom_slug(slug: &str) -> Result<()> {
    let ok = !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err(crate::error::AppError::ValidationError(
            "slug 只允许小写字母/数字/连字符,长度 ≤64".into(),
        ));
    }
    Ok(())
}

/// 保存(新建/覆盖)项目级自定义专家,返回落盘路径
pub fn custom_agent_save_inner(
    work_dir: &str,
    slug: &str,
    name: &str,
    description: &str,
    emoji: &str,
    system_prompt: &str,
    tools: &[String],
) -> Result<PathBuf> {
    validate_custom_slug(slug)?;
    if name.trim().is_empty() || system_prompt.trim().is_empty() {
        return Err(crate::error::AppError::ValidationError(
            "name 与系统提示词不能为空".into(),
        ));
    }
    let esc = |s: &str| s.replace('\n', " ").replace('"', "'");
    let mut fm = format!(
        "---\nname: \"{}\"\ndescription: \"{}\"\n",
        esc(name.trim()),
        esc(description.trim())
    );
    if !emoji.trim().is_empty() {
        fm.push_str(&format!("emoji: {}\n", emoji.trim()));
    }
    if !tools.is_empty() {
        fm.push_str(&format!("tools: \"{}\"\n", tools.join(", ")));
    }
    fm.push_str("---\n\n");
    let dir = custom_agents_dir(work_dir);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{slug}.md"));
    std::fs::write(&path, format!("{fm}{}\n", system_prompt.trim()))?;
    Ok(path)
}

/// 删除项目级自定义专家
pub fn custom_agent_delete_inner(work_dir: &str, slug: &str) -> Result<()> {
    validate_custom_slug(slug)?;
    let path = custom_agents_dir(work_dir).join(format!("{slug}.md"));
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// 自定义专家条目(含 system_prompt 供编辑回填)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentItem {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub emoji: Option<String>,
    pub system_prompt: String,
    pub file_path: String,
    #[serde(default)]
    pub tools: Vec<String>,
}

pub fn custom_agent_list_inner(work_dir: &str) -> Vec<CustomAgentItem> {
    let dir = custom_agents_dir(work_dir);
    crate::ai::engine::simple_ai::list_project_agents(work_dir)
        .into_iter()
        .map(|a| CustomAgentItem {
            file_path: dir.join(format!("{}.md", a.slug)).to_string_lossy().to_string(),
            slug: a.slug,
            name: a.name,
            description: a.description,
            emoji: a.emoji,
            system_prompt: a.system_prompt,
            tools: a.tools,
        })
        .collect()
}

pub fn simple_ai_list_agents_inner(work_dir: &str) -> Vec<SimpleAiAgentItem> {
    crate::ai::engine::simple_ai::list_agents(work_dir)
        .into_iter()
        .map(|a| SimpleAiAgentItem {
            slug: a.slug,
            name: a.name,
            description: a.description,
            emoji: a.emoji,
            division: a.division,
        })
        .collect()
}

// ============================================================================
// Tauri 命令包装
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn simple_ai_list_agents(work_dir: String) -> Vec<SimpleAiAgentItem> {
    simple_ai_list_agents_inner(&work_dir)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn agent_corpus_rosters() -> Result<serde_json::Value> {
    corpus_rosters_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn custom_agent_list(work_dir: String) -> Vec<CustomAgentItem> {
    custom_agent_list_inner(&work_dir)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn custom_agent_save(
    work_dir: String,
    slug: String,
    name: String,
    description: String,
    emoji: String,
    system_prompt: String,
    tools: Vec<String>,
) -> Result<String> {
    custom_agent_save_inner(&work_dir, &slug, &name, &description, &emoji, &system_prompt, &tools)
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn custom_agent_delete(work_dir: String, slug: String) -> Result<()> {
    custom_agent_delete_inner(&work_dir, &slug)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn user_roster_save(
    slug: String,
    title: String,
    summary: String,
    members: Vec<String>,
) -> Result<()> {
    user_roster_save_inner(&slug, &title, &summary, members)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn user_roster_delete(slug: String) -> Result<()> {
    user_roster_delete_inner(&slug)
}
