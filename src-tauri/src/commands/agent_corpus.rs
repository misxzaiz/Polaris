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
