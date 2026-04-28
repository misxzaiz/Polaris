//! Knowledge commands for Tauri IPC
//!
//! Provides frontend CRUD operations for the knowledge base.
//! Follows the same pattern as commands/todo.rs.

use std::path::PathBuf;

#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::models::knowledge::*;
use crate::services::unified_knowledge_repository::UnifiedKnowledgeRepository;

#[cfg(feature = "tauri-app")]
// Helper: create repository from params
fn make_repo(workspace_path: Option<&String>, app: &AppHandle) -> Result<UnifiedKnowledgeRepository> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let ws = workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    Ok(UnifiedKnowledgeRepository::new(config_dir, ws))
}

fn parse_complexity(value: &str) -> Result<Complexity> {
    match value {
        "low" => Ok(Complexity::Low),
        "medium" => Ok(Complexity::Medium),
        "high" => Ok(Complexity::High),
        _ => Err(crate::error::AppError::ValidationError(format!(
            "无效复杂度: {}",
            value
        ))),
    }
}

fn parse_change_frequency(value: &str) -> Result<ChangeFrequency> {
    match value {
        "low" => Ok(ChangeFrequency::Low),
        "medium" => Ok(ChangeFrequency::Medium),
        "high" => Ok(ChangeFrequency::High),
        _ => Err(crate::error::AppError::ValidationError(format!(
            "无效变更频率: {}",
            value
        ))),
    }
}

fn parse_confidence(value: &str) -> Result<Confidence> {
    match value {
        "green" => Ok(Confidence::Green),
        "yellow" => Ok(Confidence::Yellow),
        "orange" => Ok(Confidence::Orange),
        "red" => Ok(Confidence::Red),
        "black" => Ok(Confidence::Black),
        _ => Err(crate::error::AppError::ValidationError(format!(
            "无效置信度: {}",
            value
        ))),
    }
}

fn parse_severity(value: &str) -> Result<Severity> {
    match value {
        "low" => Ok(Severity::Low),
        "medium" => Ok(Severity::Medium),
        "high" => Ok(Severity::High),
        _ => Err(crate::error::AppError::ValidationError(format!(
            "无效严重度: {}",
            value
        ))),
    }
}

// ============================================================================
// Init
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_init(
    params: KnowledgeInitParams,
    app: AppHandle,
) -> Result<KnowledgeIndex> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.init_knowledge()
}

// ============================================================================
// List modules
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_list_modules(
    params: KnowledgeListModulesParams,
    app: AppHandle,
) -> Result<Vec<KnowledgeModule>> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    let mut modules = repo.list_modules()?;

    // Optional domain filter
    if let Some(domain) = params.domain {
        modules.retain(|m| m.domain.as_deref() == Some(domain.as_str()));
    }

    // Optional search query
    if let Some(query) = params.query {
        let q = query.to_lowercase();
        modules.retain(|m| {
            m.id.to_lowercase().contains(&q) || m.name.to_lowercase().contains(&q)
        });
    }

    Ok(modules)
}

// ============================================================================
// Get module detail
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_get_module(
    params: KnowledgeGetModuleParams,
    app: AppHandle,
) -> Result<ModuleDetail> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.get_module(&params.id)
}

// ============================================================================
// Create module
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_create_module(
    params: KnowledgeCreateModuleParams,
    app: AppHandle,
) -> Result<KnowledgeModule> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;

    let complexity = params
        .complexity
        .as_deref()
        .and_then(|c| parse_complexity(c).ok());
    let change_frequency = params
        .change_frequency
        .as_deref()
        .and_then(|c| parse_change_frequency(c).ok());

    repo.create_module(
        params.id,
        params.name,
        params.domain,
        params.scope,
        params.dependencies,
        complexity,
        change_frequency,
    )
}

// ============================================================================
// Update module
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_update_module(
    params: KnowledgeUpdateModuleParams,
    app: AppHandle,
) -> Result<KnowledgeModule> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;

    let complexity = params
        .complexity
        .as_deref()
        .and_then(|c| parse_complexity(c).ok());
    let change_frequency = params
        .change_frequency
        .as_deref()
        .and_then(|c| parse_change_frequency(c).ok());

    repo.update_module(
        &params.id,
        params.name,
        params.domain,
        params.scope,
        params.dependencies,
        complexity,
        change_frequency,
    )
}

// ============================================================================
// Delete module
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_delete_module(
    params: KnowledgeDeleteModuleParams,
    app: AppHandle,
) -> Result<()> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.delete_module(&params.id)
}

// ============================================================================
// Update module document
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_update_module_document(
    params: KnowledgeUpdateDocumentParams,
    app: AppHandle,
) -> Result<()> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.update_module_document(&params.module_id, params.content)
}

// ============================================================================
// Assertion CRUD
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_create_assertion(
    params: KnowledgeCreateAssertionParams,
    app: AppHandle,
) -> Result<KnowledgeAssertion> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.create_assertion(&params.module_id, params.assertion)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_update_assertion(
    params: KnowledgeUpdateAssertionParams,
    app: AppHandle,
) -> Result<KnowledgeAssertion> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;

    let confidence = params
        .confidence
        .as_deref()
        .and_then(|c| parse_confidence(c).ok());

    repo.update_assertion(
        &params.module_id,
        &params.assertion_id,
        params.claim,
        params.anchor,
        params.expect,
        confidence,
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_delete_assertion(
    params: KnowledgeDeleteAssertionParams,
    app: AppHandle,
) -> Result<()> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.delete_assertion(&params.module_id, &params.assertion_id)
}

// ============================================================================
// Trap CRUD
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_create_trap(
    params: KnowledgeCreateTrapParams,
    app: AppHandle,
) -> Result<KnowledgeTrap> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.create_trap(&params.module_id, params.trap)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_update_trap(
    params: KnowledgeUpdateTrapParams,
    app: AppHandle,
) -> Result<KnowledgeTrap> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;

    let severity = params
        .severity
        .as_deref()
        .and_then(|s| parse_severity(s).ok());

    repo.update_trap(&params.module_id, &params.trap_id, params.description, severity)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_delete_trap(
    params: KnowledgeDeleteTrapParams,
    app: AppHandle,
) -> Result<()> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.delete_trap(&params.module_id, &params.trap_id)
}

// ============================================================================
// List domains
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn knowledge_list_domains(
    params: KnowledgeListDomainsParams,
    app: AppHandle,
) -> Result<Vec<DomainDefinition>> {
    let repo = make_repo(params.workspace_path.as_ref(), &app)?;
    repo.list_domains()
}
