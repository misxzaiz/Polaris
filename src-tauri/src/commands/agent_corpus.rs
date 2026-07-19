//! Agency Agents corpus 相关 Tauri 命令(P0-5)
//!
//! 暴露给前端:
//! - `agent_corpus_status` —— 内置/已安装版本与计数
//! - `agent_corpus_install` —— 安装(幂等)到 `<DataRoot>/agents/`
//! - `agent_corpus_uninstall` —— 卸载(仅清理本模块管理的文件)
//! - `agent_corpus_catalog` —— 读取内置 catalog(266+ agent 元数据,供 Gallery/选择器)
//!
//! 资源目录解析:打包态用 tauri `resource_dir()`(bundle.resources 含
//! `resources/agents`),开发态回退 `CARGO_MANIFEST_DIR/resources/agents`。

use std::path::PathBuf;

use crate::error::Result;
use crate::services::agent_corpus::{self, CatalogEntry, CorpusStatus};
use crate::services::data_root::data_root;

/// 解析内置 corpus 资源目录(共享实现,resource_dir 由调用层传入)
pub fn resolve_resources_agents_dir(resource_dir: Option<PathBuf>) -> PathBuf {
    if let Some(res) = resource_dir {
        // bundle.resources 的 "resources/agents" 在 resource_dir 下保持相对路径
        let bundled = res.join("resources").join("agents");
        if bundled.join("corpus-manifest.json").exists() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("agents")
}

/// 安装目标目录:`<DataRoot>/agents/`
pub fn corpus_install_dir() -> PathBuf {
    data_root().root().join("agents")
}

pub fn corpus_status_inner(resource_dir: Option<PathBuf>) -> CorpusStatus {
    agent_corpus::corpus_status(&resolve_resources_agents_dir(resource_dir), &corpus_install_dir())
}

pub fn corpus_install_inner(resource_dir: Option<PathBuf>) -> Result<CorpusStatus> {
    let res = resolve_resources_agents_dir(resource_dir);
    let status = agent_corpus::install_corpus(&res, &corpus_install_dir())?;
    // L2 语义路由索引落为全局 skill(P1-7);失败不阻塞 corpus 安装
    if let Err(e) = agent_corpus::install_index_skill(&res, &data_root().root().join("skills")) {
        eprintln!("[agent_corpus] index skill 安装失败: {e}");
    }
    Ok(status)
}

pub fn corpus_uninstall_inner() -> Result<()> {
    agent_corpus::uninstall_corpus(&corpus_install_dir())?;
    agent_corpus::uninstall_index_skill(&data_root().root().join("skills"))
}

pub fn corpus_catalog_inner(resource_dir: Option<PathBuf>) -> Result<Vec<CatalogEntry>> {
    agent_corpus::load_catalog(&resolve_resources_agents_dir(resource_dir))
}

pub fn corpus_divisions_inner(resource_dir: Option<PathBuf>) -> Result<serde_json::Value> {
    agent_corpus::load_divisions(&resolve_resources_agents_dir(resource_dir))
}

/// SimpleAI agent 列表条目(P1-6,discover_agents 两级查找结果)
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
    corpus_install_dir().join("rosters-user.json")
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
    std::fs::create_dir_all(corpus_install_dir())?;
    std::fs::write(user_rosters_path(), serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}

/// rosters 透传:内置 rosters.json + 用户自建(标 custom:true)合并(专家团 UI 消费)
pub fn corpus_rosters_inner(resource_dir: Option<PathBuf>) -> Result<serde_json::Value> {
    let path = resolve_resources_agents_dir(resource_dir).join("rosters.json");
    let content = std::fs::read_to_string(&path).map_err(|e| {
        crate::error::AppError::ConfigError(format!("读取 rosters 失败: {e} ({})", path.display()))
    })?;
    let mut value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| crate::error::AppError::ConfigError(format!("rosters.json 解析失败: {e}")))?;
    if let Some(arr) = value.get_mut("rosters").and_then(|r| r.as_array_mut()) {
        for mut user in load_user_rosters() {
            user["custom"] = serde_json::Value::Bool(true);
            arr.push(user);
        }
    }
    Ok(value)
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
// 自定义专家(项目级 .polaris/agents,P3 体验优化)
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
        })
        .collect()
}

/// 读取已安装 corpus 中某专家定义原文(「另存为自定义」预填用)
pub fn corpus_read_inner(slug: &str) -> Result<String> {
    validate_custom_slug(slug)?;
    let path = corpus_install_dir().join("corpus").join(format!("{slug}.md"));
    std::fs::read_to_string(&path).map_err(|e| {
        crate::error::AppError::ConfigError(format!("读取专家定义失败: {e} ({})", path.display()))
    })
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
fn app_resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().resource_dir().ok()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn agent_corpus_status(app: tauri::AppHandle) -> CorpusStatus {
    corpus_status_inner(app_resource_dir(&app))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn agent_corpus_install(app: tauri::AppHandle) -> Result<CorpusStatus> {
    corpus_install_inner(app_resource_dir(&app))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn agent_corpus_uninstall() -> Result<()> {
    corpus_uninstall_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn agent_corpus_catalog(app: tauri::AppHandle) -> Result<Vec<CatalogEntry>> {
    corpus_catalog_inner(app_resource_dir(&app))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn agent_corpus_divisions(app: tauri::AppHandle) -> Result<serde_json::Value> {
    corpus_divisions_inner(app_resource_dir(&app))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn simple_ai_list_agents(work_dir: String) -> Vec<SimpleAiAgentItem> {
    simple_ai_list_agents_inner(&work_dir)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn agent_corpus_rosters(app: tauri::AppHandle) -> Result<serde_json::Value> {
    corpus_rosters_inner(app_resource_dir(&app))
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
) -> Result<String> {
    custom_agent_save_inner(&work_dir, &slug, &name, &description, &emoji, &system_prompt)
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn custom_agent_delete(work_dir: String, slug: String) -> Result<()> {
    custom_agent_delete_inner(&work_dir, &slug)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn agent_corpus_read(slug: String) -> Result<String> {
    corpus_read_inner(&slug)
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
