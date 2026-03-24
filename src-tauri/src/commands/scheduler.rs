#![allow(non_snake_case)]
// 定时任务 Tauri Commands
// 注意：Tauri 命令参数使用 camelCase 命名以匹配前端 JavaScript 约定

use crate::error::Result;
use crate::models::scheduler::{CreateTaskParams, ScheduledTask, TaskLog, TriggerType, RunTaskResult, PaginatedLogs, LogRetentionConfig};
use crate::services::scheduler::LogStats;
use crate::state::AppState;
use crate::utils::{LockStatus, SchedulerLock};
use crate::services::scheduler::ProtocolTaskService;
use tauri::Window;

/// 获取所有任务
#[tauri::command]
pub async fn scheduler_get_tasks(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ScheduledTask>> {
    let store = state.scheduler_task_store.lock().await;
    Ok(store.get_all().to_vec())
}

/// 获取单个任务
#[tauri::command]
pub async fn scheduler_get_task(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<ScheduledTask>> {
    let store = state.scheduler_task_store.lock().await;
    Ok(store.get(&id).cloned())
}

/// 创建任务
#[tauri::command]
pub async fn scheduler_create_task(
    params: CreateTaskParams,
    state: tauri::State<'_, AppState>,
) -> Result<ScheduledTask> {
    let mut store = state.scheduler_task_store.lock().await;
    store.create(params)
}

/// 更新任务
#[tauri::command]
pub async fn scheduler_update_task(
    task: ScheduledTask,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let mut store = state.scheduler_task_store.lock().await;
    store.update(task)
}

/// 删除任务
#[tauri::command]
pub async fn scheduler_delete_task(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let mut store = state.scheduler_task_store.lock().await;
    store.delete(&id)
}

/// 切换任务启用状态
#[tauri::command]
pub async fn scheduler_toggle_task(
    id: String,
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let mut store = state.scheduler_task_store.lock().await;
    store.toggle(&id, enabled)
}

/// 立即执行任务
#[tauri::command]
pub async fn scheduler_run_task(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<RunTaskResult> {
    let disp = state.scheduler_dispatcher.lock().await;
    disp.run_now(&id).await
}

/// 立即执行任务（订阅模式 - 发送事件到前端窗口）
///
/// 与 scheduler_run_task 不同，此命令会将 AI 执行过程的事件
/// 实时发送到前端窗口，用户可以在 AI 对话窗口中看到执行过程。
#[tauri::command]
pub async fn scheduler_run_task_with_window(
    id: String,
    context_id: Option<String>,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<RunTaskResult> {
    let disp = state.scheduler_dispatcher.lock().await;
    disp.run_now_with_window(&id, window, context_id).await
}

/// 获取任务日志
#[tauri::command]
pub async fn scheduler_get_task_logs(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TaskLog>> {
    let store = state.scheduler_log_store.lock().await;
    Ok(store.get_task_logs(&task_id).into_iter().cloned().collect())
}

/// 获取所有日志
#[tauri::command]
pub async fn scheduler_get_all_logs(
    limit: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TaskLog>> {
    let store = state.scheduler_log_store.lock().await;
    Ok(store.get_all_logs(limit).into_iter().cloned().collect())
}

/// 清理过期日志
#[tauri::command]
pub async fn scheduler_cleanup_logs(
    state: tauri::State<'_, AppState>,
) -> Result<usize> {
    let mut store = state.scheduler_log_store.lock().await;
    store.cleanup_expired_logs()
}

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

/// 获取调度器锁状态
#[tauri::command]
pub async fn scheduler_get_lock_status(
    state: tauri::State<'_, AppState>,
) -> Result<LockStatus> {
    let is_holder = state.scheduler_lock.lock().await.is_some();
    let is_locked_by_other = if !is_holder {
        // 如果当前实例没有锁，检查是否有其他实例持有
        SchedulerLock::is_locked()
    } else {
        false
    };

    Ok(LockStatus {
        is_holder,
        is_locked_by_other,
        pid: std::process::id(),
    })
}

/// 启动调度器（尝试获取锁并启动）
#[tauri::command]
pub async fn scheduler_start(
    state: tauri::State<'_, AppState>,
) -> Result<String> {
    // 检查是否已经持有锁
    {
        let lock = state.scheduler_lock.lock().await;
        if lock.is_some() {
            return Ok("当前实例已在运行调度器".to_string());
        }
    }

    // 尝试获取锁
    match SchedulerLock::try_acquire()? {
        Some(new_lock) => {
            // 保存锁
            *state.scheduler_lock.lock().await = Some(new_lock);

            // 启动调度器（不传递 app_handle，因为前端无法获取）
            state.scheduler_dispatcher.lock().await.start(None);

            tracing::info!("[Scheduler] 成功启动调度器");
            Ok("成功启动调度器".to_string())
        }
        None => {
            tracing::warn!("[Scheduler] 无法获取调度器锁，其他实例可能仍在运行");
            Err(crate::error::AppError::ValidationError(
                "其他实例正在运行调度器，请先关闭该实例或在其设置中停止调度".to_string()
            ))
        }
    }
}

/// 停止调度器（释放锁）
#[tauri::command]
pub async fn scheduler_stop(
    state: tauri::State<'_, AppState>,
) -> Result<String> {
    let mut lock = state.scheduler_lock.lock().await;

    if lock.is_none() {
        return Ok("当前实例未运行调度器".to_string());
    }

    // 先停止调度循环
    state.scheduler_dispatcher.lock().await.stop();

    // 释放锁（drop 会自动释放）
    *lock = None;

    tracing::info!("[Scheduler] 已停止调度器");
    Ok("已停止调度器".to_string())
}

/// 分页获取日志
#[tauri::command]
pub async fn scheduler_get_logs_paginated(
    task_id: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<PaginatedLogs> {
    let store = state.scheduler_log_store.lock().await;
    Ok(store.get_logs_paginated(task_id.as_deref(), page.unwrap_or(1), page_size.unwrap_or(20)))
}

/// 删除单条日志
#[tauri::command]
pub async fn scheduler_delete_log(
    log_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool> {
    let mut store = state.scheduler_log_store.lock().await;
    store.delete_log(&log_id)
}

/// 批量删除日志
#[tauri::command]
pub async fn scheduler_delete_logs(
    log_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<usize> {
    let mut store = state.scheduler_log_store.lock().await;
    store.delete_logs(&log_ids)
}

/// 清理任务的所有日志
#[tauri::command]
pub async fn scheduler_clear_task_logs(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<usize> {
    let mut store = state.scheduler_log_store.lock().await;
    store.clear_task_logs(&task_id)
}

// ============================================================================
// 协议任务文档操作
// ============================================================================

/// 协议文档类型
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolFileType {
    /// 协议文档
    Task,
    /// 用户补充
    Supplement,
    /// 记忆索引
    MemoryIndex,
    /// 记忆任务
    MemoryTasks,
    /// 执行轮次记录
    MemoryRuns,
}

/// 读取协议任务文档
#[tauri::command]
pub fn scheduler_read_protocol_file(
    work_dir: String,
    task_path: String,
    file_type: ProtocolFileType,
) -> Result<String> {
    let content = match file_type {
        ProtocolFileType::Task => ProtocolTaskService::read_task_md(&work_dir, &task_path),
        ProtocolFileType::Supplement => ProtocolTaskService::read_supplement_md(&work_dir, &task_path),
        ProtocolFileType::MemoryIndex => ProtocolTaskService::read_memory_index(&work_dir, &task_path),
        ProtocolFileType::MemoryTasks => ProtocolTaskService::read_memory_tasks(&work_dir, &task_path),
        ProtocolFileType::MemoryRuns => ProtocolTaskService::read_memory_runs(&work_dir, &task_path),
    };

    content.map_err(crate::error::AppError::IoError)
}

/// 写入协议任务文档
#[tauri::command]
pub fn scheduler_write_protocol_file(
    work_dir: String,
    task_path: String,
    file_type: ProtocolFileType,
    content: String,
) -> Result<()> {
    let result = match file_type {
        ProtocolFileType::Task => ProtocolTaskService::update_task_md(&work_dir, &task_path, &content),
        ProtocolFileType::Supplement => {
            // 用户补充直接覆盖文件
            std::fs::write(
                std::path::PathBuf::from(&work_dir).join(&task_path).join("user-supplement.md"),
                &content
            )
        }
        ProtocolFileType::MemoryIndex => ProtocolTaskService::update_memory_index(&work_dir, &task_path, &content),
        ProtocolFileType::MemoryTasks => ProtocolTaskService::update_memory_tasks(&work_dir, &task_path, &content),
        ProtocolFileType::MemoryRuns => ProtocolTaskService::update_memory_runs(&work_dir, &task_path, &content),
    };

    result.map_err(crate::error::AppError::IoError)
}

/// 获取协议任务文档路径
#[tauri::command]
pub fn scheduler_get_protocol_file_path(
    work_dir: String,
    task_path: String,
    file_type: ProtocolFileType,
) -> Result<String> {
    let file_name = match file_type {
        ProtocolFileType::Task => "task.md",
        ProtocolFileType::Supplement => "user-supplement.md",
        ProtocolFileType::MemoryIndex => "memory/index.md",
        ProtocolFileType::MemoryTasks => "memory/tasks.md",
        ProtocolFileType::MemoryRuns => "memory/runs.md",
    };

    let full_path = std::path::PathBuf::from(&work_dir).join(&task_path).join(file_name);
    Ok(full_path.to_string_lossy().to_string())
}

/// 订阅任务（设置任务的 subscribedContextId）
/// 
/// 订阅后，定时执行时任务会自动发送事件到前端窗口
#[tauri::command]
pub async fn scheduler_subscribe_task(
    id: String,
    context_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let mut store = state.scheduler_task_store.lock().await;
    store.set_subscription(&id, Some(&context_id))
}

/// 取消订阅任务
#[tauri::command]
pub async fn scheduler_unsubscribe_task(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let mut store = state.scheduler_task_store.lock().await;
    store.set_subscription(&id, None)
}

// ============================================================================
// 任务导出导入
// ============================================================================

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;

/// 任务导出项（用于 JSON 序列化）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExportItem {
    pub name: String,
    pub enabled: bool,
    pub trigger_type: String,
    pub trigger_value: String,
    pub engine_id: String,
    pub prompt: String,
    pub work_dir: Option<String>,
    pub group: Option<String>,
    pub max_runs: Option<u32>,
    pub reuse_session: Option<bool>,
    pub continue_immediately: Option<bool>,
    pub max_continuous_runs: Option<u32>,
    pub run_in_terminal: bool,
    pub template_id: Option<String>,
    pub template_param_values: Option<std::collections::HashMap<String, String>>,
    pub max_retries: Option<u32>,
    pub retry_interval: Option<String>,
    pub notify_on_complete: bool,
}

/// 任务导出数据结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExportData {
    pub version: String,
    pub exported_at: String,
    pub tasks: Vec<TaskExportItem>,
}

/// 导出任务到 JSON 文件
#[tauri::command]
pub async fn scheduler_export_tasks(
    tasks: Vec<TaskExportItem>,
    app: tauri::AppHandle,
) -> Result<bool> {
    // 打开保存对话框
    let file_path = app.dialog()
        .file()
        .set_file_name(format!("tasks_export_{}.json", chrono::Utc::now().format("%Y-%m-%d")))
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let export_data = TaskExportData {
                version: "1.0".to_string(),
                exported_at: chrono::Utc::now().to_rfc3339(),
                tasks,
            };

            let content = serde_json::to_string_pretty(&export_data)
                .map_err(crate::error::AppError::from)?;

            let path_str = path.to_string();
            std::fs::write(&path_str, content)
                .map_err(crate::error::AppError::IoError)?;

            tracing::info!("[Scheduler] 任务已导出到: {:?}", path);
            Ok(true)
        }
        None => Ok(false), // 用户取消
    }
}

/// 从 JSON 文件导入任务
#[tauri::command]
pub async fn scheduler_import_tasks(
    app: tauri::AppHandle,
) -> Result<Vec<TaskExportItem>> {
    // 打开文件选择对话框
    let file_path = app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();

    match file_path {
        Some(path) => {
            let path_str = path.to_string();
            let content = std::fs::read_to_string(&path_str)
                .map_err(crate::error::AppError::IoError)?;

            let data: TaskExportData = serde_json::from_str(&content)
                .map_err(crate::error::AppError::from)?;

            tracing::info!("[Scheduler] 从 {:?} 导入了 {} 个任务", path, data.tasks.len());
            Ok(data.tasks)
        }
        None => Ok(vec![]), // 用户取消
    }
}

// ============================================================================
// 日志配置管理
// ============================================================================

/// 获取日志统计信息
#[tauri::command]
pub async fn scheduler_get_log_stats(
    state: tauri::State<'_, AppState>,
) -> Result<LogStats> {
    let store = state.scheduler_log_store.lock().await;
    Ok(store.get_log_stats())
}

/// 获取日志保留配置
#[tauri::command]
pub async fn scheduler_get_log_retention_config(
    state: tauri::State<'_, AppState>,
) -> Result<LogRetentionConfig> {
    let store = state.scheduler_log_store.lock().await;
    Ok(store.get_retention_config().clone())
}

/// 更新日志保留配置
#[tauri::command]
pub async fn scheduler_update_log_retention_config(
    config: LogRetentionConfig,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let mut store = state.scheduler_log_store.lock().await;
    store.update_retention_config(config)
}
