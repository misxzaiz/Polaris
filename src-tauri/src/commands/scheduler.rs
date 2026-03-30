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
        ..Default::default()
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

// ============================================================================
// Scheduler Lifecycle Commands
// ============================================================================

/// 调度器运行状态
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
    /// 调度器是否正在运行
    pub is_running: bool,
    /// 当前实例是否持有锁
    pub is_holder: bool,
    /// 是否有其他实例持有锁
    pub is_locked_by_other: bool,
    /// 当前进程 PID
    pub pid: u32,
    /// 状态消息
    pub message: Option<String>,
}

/// 获取调度器完整状态（锁 + 运行状态）
#[tauri::command]
pub fn scheduler_get_status() -> Result<SchedulerStatus> {
    let lock_status = crate::utils::get_lock_status();
    let pid = std::process::id();

    Ok(SchedulerStatus {
        is_running: lock_status.is_holder,
        is_holder: lock_status.is_holder,
        is_locked_by_other: lock_status.is_locked_by_other,
        pid,
        message: if lock_status.is_holder {
            Some("调度器正在运行".to_string())
        } else if lock_status.is_locked_by_other {
            Some("其他实例正在运行调度器".to_string())
        } else {
            Some("调度器未运行".to_string())
        },
    })
}

/// 启动调度器
/// 1. 尝试获取锁
/// 2. 如果成功，启动后台守护进程
/// 返回启动结果
#[tauri::command]
pub async fn scheduler_start(app: AppHandle) -> Result<SchedulerStatus> {
    let pid = std::process::id();

    // 检查是否已经在运行
    if crate::utils::is_holding_lock() {
        return Ok(SchedulerStatus {
            is_running: true,
            is_holder: true,
            is_locked_by_other: false,
            pid,
            message: Some("调度器已在运行".to_string()),
        });
    }

    // 尝试获取锁
    match crate::utils::acquire_and_hold_lock() {
        Ok(true) => {
            tracing::info!("[Scheduler] 调度器启动成功，已获取锁");

            // 启动后台守护进程
            let config_dir = app.path()
                .app_config_dir()
                .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

            let mut daemon = crate::services::scheduler_daemon::SchedulerDaemon::new(
                config_dir,
                None, // workspace_path
            );

            daemon.start(app.clone())?;

            // 存储守护进程引用
            {
                let state = app.state::<crate::AppState>();
                let mut scheduler_daemon = state.scheduler_daemon.lock().await;
                *scheduler_daemon = Some(daemon);
            }

            Ok(SchedulerStatus {
                is_running: true,
                is_holder: true,
                is_locked_by_other: false,
                pid,
                message: Some("调度器启动成功".to_string()),
            })
        }
        Ok(false) => {
            tracing::info!("[Scheduler] 无法启动调度器，其他实例持有锁");
            Ok(SchedulerStatus {
                is_running: false,
                is_holder: false,
                is_locked_by_other: true,
                pid,
                message: Some("无法启动：其他实例正在运行调度器".to_string()),
            })
        }
        Err(e) => {
            tracing::error!("[Scheduler] 启动失败: {}", e);
            Err(crate::error::AppError::ProcessError(format!("启动调度器失败: {}", e)))
        }
    }
}

/// 停止调度器
/// 1. 停止后台守护进程
/// 2. 释放锁
#[tauri::command]
pub async fn scheduler_stop(app: AppHandle) -> Result<SchedulerStatus> {
    let pid = std::process::id();

    // 检查是否正在运行
    if !crate::utils::is_holding_lock() {
        return Ok(SchedulerStatus {
            is_running: false,
            is_holder: false,
            is_locked_by_other: crate::utils::get_lock_status().is_locked_by_other,
            pid,
            message: Some("调度器未在运行".to_string()),
        });
    }

    // 停止后台守护进程
    {
        let state = app.state::<crate::AppState>();
        let mut scheduler_daemon = state.scheduler_daemon.lock().await;
        if let Some(mut daemon) = scheduler_daemon.take() {
            daemon.stop()?;
            tracing::info!("[Scheduler] 守护进程已停止");
        }
    }

    // 释放锁
    match crate::utils::release_held_lock() {
        Ok(()) => {
            tracing::info!("[Scheduler] 调度器已停止，锁已释放");
            Ok(SchedulerStatus {
                is_running: false,
                is_holder: false,
                is_locked_by_other: false,
                pid,
                message: Some("调度器已停止".to_string()),
            })
        }
        Err(e) => {
            tracing::error!("[Scheduler] 停止失败: {}", e);
            Err(crate::error::AppError::ProcessError(format!("停止调度器失败: {}", e)))
        }
    }
}

/// 手动触发任务执行
/// 更新任务状态为 running，返回任务信息供前端执行
#[tauri::command]
pub async fn scheduler_run_task(
    id: String,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<ScheduledTask> {
    let repository = get_repository(&app, workspace_path)?;

    // 更新任务状态为 running
    let task = repository.update_task_status(&id, crate::models::scheduler::TaskStatus::Running)?;

    Ok(task)
}

/// 更新任务执行结果
#[tauri::command]
pub async fn scheduler_update_run_status(
    id: String,
    status: String, // "success" | "failed"
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<ScheduledTask> {
    let repository = get_repository(&app, workspace_path)?;

    let task_status = match status.as_str() {
        "success" => crate::models::scheduler::TaskStatus::Success,
        "failed" => crate::models::scheduler::TaskStatus::Failed,
        _ => crate::models::scheduler::TaskStatus::Failed,
    };

    let task = repository.update_task_status(&id, task_status)?;

    Ok(task)
}
