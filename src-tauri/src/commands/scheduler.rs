//! Scheduler Tauri Commands (Simplified)
//!
//! Simplified commands for scheduled task management using unified repository.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::models::scheduler::{CreateTaskParams, ScheduledTask, TriggerType};
use crate::services::unified_scheduler_repository::{
    TaskUpdateParams, UnifiedSchedulerRepository,
};
use crate::utils::LockStatus;

// ============================================================================
// Helper
// ============================================================================

fn get_config_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))
}

fn get_repository(app: &AppHandle, workspace_path: Option<String>) -> Result<UnifiedSchedulerRepository> {
    let config_dir = get_config_dir(app)?;
    let workspace_path = workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);
    Ok(UnifiedSchedulerRepository::new(config_dir, workspace_path))
}

// ============================================================================
// Task CRUD Commands
// ============================================================================

/// 列出定时任务
#[tauri::command]
pub async fn scheduler_list_tasks(
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<Vec<ScheduledTask>> {
    let repository = get_repository(&app, workspace_path)?;
    repository.list_tasks()
}

/// 获取单个任务
#[tauri::command]
pub async fn scheduler_get_task(
    id: String,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<Option<ScheduledTask>> {
    let repository = get_repository(&app, workspace_path)?;
    repository.get_task(&id)
}

/// 创建任务
#[tauri::command]
pub async fn scheduler_create_task(
    params: CreateTaskParams,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<ScheduledTask> {
    let repository = get_repository(&app, workspace_path)?;
    repository.create_task(params)
}

/// 更新任务
#[tauri::command]
pub async fn scheduler_update_task(
    task: ScheduledTask,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<ScheduledTask> {
    let repository = get_repository(&app, workspace_path)?;
    repository.update_task(&task.id, TaskUpdateParams {
        name: Some(task.name),
        enabled: Some(task.enabled),
        trigger_type: Some(task.trigger_type),
        trigger_value: Some(task.trigger_value),
        engine_id: Some(task.engine_id),
        prompt: Some(task.prompt),
        work_dir: task.work_dir,
        description: task.description,
    })
}

/// 删除任务
#[tauri::command]
pub async fn scheduler_delete_task(
    id: String,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<ScheduledTask> {
    let repository = get_repository(&app, workspace_path)?;
    repository.delete_task(&id)
}

/// 切换任务启用状态
#[tauri::command]
pub async fn scheduler_toggle_task(
    id: String,
    enabled: bool,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<ScheduledTask> {
    let repository = get_repository(&app, workspace_path)?;
    repository.toggle_task(&id, enabled)
}

// ============================================================================
// Utility Commands
// ============================================================================

/// 验证触发表达式
#[tauri::command]
pub fn scheduler_validate_trigger(
    trigger_type: TriggerType,
    trigger_value: String,
) -> Result<Option<i64>> {
    let now = chrono::Utc::now().timestamp();
    Ok(trigger_type.calculate_next_run(&trigger_value, now))
}

/// 解析间隔表达式
#[tauri::command]
pub fn scheduler_parse_interval(value: String) -> Option<i64> {
    crate::models::scheduler::parse_interval(&value)
}

/// 获取工作区分布统计
#[tauri::command]
pub async fn scheduler_get_workspace_breakdown(
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<std::collections::BTreeMap<String, usize>> {
    let repository = get_repository(&app, workspace_path)?;
    repository.get_workspace_breakdown()
}

// ============================================================================
// Lock Commands
// ============================================================================

/// 获取调度器锁状态
#[tauri::command]
pub fn scheduler_get_lock_status() -> Result<LockStatus> {
    Ok(crate::utils::get_lock_status())
}

/// 尝试获取调度器锁
/// 返回是否成功获取
#[tauri::command]
pub fn scheduler_acquire_lock() -> Result<bool> {
    crate::utils::acquire_and_hold_lock()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取锁失败: {}", e)))
}

/// 释放调度器锁
#[tauri::command]
pub fn scheduler_release_lock() -> Result<()> {
    crate::utils::release_held_lock()
        .map_err(|e| crate::error::AppError::ProcessError(format!("释放锁失败: {}", e)))
}
