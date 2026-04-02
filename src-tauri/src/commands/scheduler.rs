//! Scheduler Tauri Commands
//!
//! Commands for scheduled task management using unified repository.
//! Supports both simple mode and protocol mode (document-driven workflow).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::models::scheduler::{CreateTaskParams, ScheduledTask, TaskCategory, TaskMode, TriggerType};
use crate::services::scheduler::protocol_task::ProtocolTaskService;
use crate::services::scheduler::TaskUpdateParams;
use crate::services::unified_scheduler_repository::UnifiedSchedulerRepository;
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
    let repository = get_repository(&app, workspace_path.clone())?;

    // 如果是协议模式，创建任务文档结构
    let mut task = repository.create_task(params.clone())?;

    if params.mode == TaskMode::Protocol {
        let work_dir = params.work_dir.clone().unwrap_or_else(|| ".".to_string());
        let mission = task.mission.clone().unwrap_or_else(|| task.name.clone());

        // 创建协议任务文档结构
        let task_path = ProtocolTaskService::create_task_structure(
            &work_dir,
            &task.id,
            &mission,
            None, // TODO: 支持模板内容
        ).map_err(|e| crate::error::AppError::IoError(e))?;

        // 更新任务的 task_path
        task = repository.update_task(&task.id, TaskUpdateParams {
            task_path: Some(task_path),
            ..Default::default()
        })?;
    }

    Ok(task)
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
        // === 任务模式 ===
        mode: Some(task.mode),
        category: Some(task.category),
        // === 协议模式属性 ===
        mission: task.mission,
        template_id: task.template_id,
        template_params: task.template_params,
        // === 执行控制 ===
        max_runs: task.max_runs,
        current_runs: Some(task.current_runs),
        max_retries: task.max_retries,
        retry_count: Some(task.retry_count),
        retry_interval: task.retry_interval,
        timeout_minutes: task.timeout_minutes,
        // === 其他 ===
        group: task.group,
        notify_on_complete: Some(task.notify_on_complete),
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
    let repository = get_repository(&app, workspace_path.clone())?;

    // 获取任务信息以检查是否是协议模式
    let task = repository.get_task(&id)?;

    // 如果是协议模式，删除任务文档结构
    if let Some(ref t) = task {
        if t.mode == TaskMode::Protocol {
            if let (Some(work_dir), Some(task_path)) = (&t.work_dir, &t.task_path) {
                let _ = ProtocolTaskService::delete_task_structure(work_dir, task_path);
            }
        }
    }

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

/// 按分类列出任务
#[tauri::command]
pub async fn scheduler_list_tasks_by_category(
    category: TaskCategory,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<Vec<ScheduledTask>> {
    let repository = get_repository(&app, workspace_path)?;
    repository.list_tasks_by_category(category)
}

/// 按模式列出任务
#[tauri::command]
pub async fn scheduler_list_tasks_by_mode(
    mode: TaskMode,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<Vec<ScheduledTask>> {
    let repository = get_repository(&app, workspace_path)?;
    repository.list_tasks_by_mode(mode)
}

/// 按分组列出任务
#[tauri::command]
pub async fn scheduler_list_tasks_by_group(
    group: String,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<Vec<ScheduledTask>> {
    let repository = get_repository(&app, workspace_path)?;
    repository.list_tasks_by_group(&group)
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

// ============================================================================
// Template Commands
// ============================================================================

use crate::models::scheduler::{CreateTemplateParams, PromptTemplate};

/// 列出所有模板
#[tauri::command]
pub async fn scheduler_list_templates(
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<Vec<PromptTemplate>> {
    let repository = get_repository(&app, workspace_path)?;
    repository.list_templates()
}

/// 获取单个模板
#[tauri::command]
pub async fn scheduler_get_template(
    id: String,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<Option<PromptTemplate>> {
    let repository = get_repository(&app, workspace_path)?;
    repository.get_template(&id)
}

/// 创建模板
#[tauri::command]
pub async fn scheduler_create_template(
    params: CreateTemplateParams,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<PromptTemplate> {
    let repository = get_repository(&app, workspace_path)?;
    repository.create_template(params)
}

/// 更新模板
#[tauri::command]
pub async fn scheduler_update_template(
    template: PromptTemplate,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<PromptTemplate> {
    let repository = get_repository(&app, workspace_path)?;
    repository.update_template(template)
}

/// 删除模板
#[tauri::command]
pub async fn scheduler_delete_template(
    id: String,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<()> {
    let repository = get_repository(&app, workspace_path)?;
    repository.delete_template(&id)
}

/// 切换模板启用状态
#[tauri::command]
pub async fn scheduler_toggle_template(
    id: String,
    enabled: bool,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<PromptTemplate> {
    let repository = get_repository(&app, workspace_path)?;
    repository.toggle_template(&id, enabled)
}

/// 构建提示词（应用模板）
#[tauri::command]
pub async fn scheduler_build_prompt(
    template_id: String,
    task_name: String,
    user_prompt: String,
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<String> {
    let repository = get_repository(&app, workspace_path)?;
    repository.build_prompt_with_template(&template_id, &task_name, &user_prompt)
}

// ============================================================================
// Protocol Task Commands
// ============================================================================

/// 协议文档内容
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolDocuments {
    pub protocol: String,
    pub supplement: String,
    pub memory_index: String,
    pub memory_tasks: String,
}

/// 读取协议任务文档
#[tauri::command]
pub async fn scheduler_read_protocol_documents(
    task_path: String,
    work_dir: String,
) -> Result<ProtocolDocuments> {
    let protocol = ProtocolTaskService::read_protocol(&work_dir, &task_path)
        .map_err(|e| crate::error::AppError::IoError(e))?;
    let supplement = ProtocolTaskService::read_supplement(&work_dir, &task_path)
        .map_err(|e| crate::error::AppError::IoError(e))?;
    let memory_index = ProtocolTaskService::read_memory_index(&work_dir, &task_path)
        .map_err(|e| crate::error::AppError::IoError(e))?;
    let memory_tasks = ProtocolTaskService::read_memory_tasks(&work_dir, &task_path)
        .map_err(|e| crate::error::AppError::IoError(e))?;

    Ok(ProtocolDocuments {
        protocol,
        supplement,
        memory_index,
        memory_tasks,
    })
}

/// 更新协议文档
#[tauri::command]
pub async fn scheduler_update_protocol(
    task_path: String,
    work_dir: String,
    content: String,
) -> Result<()> {
    ProtocolTaskService::update_protocol(&work_dir, &task_path, &content)
        .map_err(|e| crate::error::AppError::IoError(e))
}

/// 更新用户补充
#[tauri::command]
pub async fn scheduler_update_supplement(
    task_path: String,
    work_dir: String,
    content: String,
) -> Result<()> {
    ProtocolTaskService::update_supplement(&work_dir, &task_path, &content)
        .map_err(|e| crate::error::AppError::IoError(e))
}

/// 更新记忆索引
#[tauri::command]
pub async fn scheduler_update_memory_index(
    task_path: String,
    work_dir: String,
    content: String,
) -> Result<()> {
    ProtocolTaskService::update_memory_index(&work_dir, &task_path, &content)
        .map_err(|e| crate::error::AppError::IoError(e))
}

/// 更新记忆任务
#[tauri::command]
pub async fn scheduler_update_memory_tasks(
    task_path: String,
    work_dir: String,
    content: String,
) -> Result<()> {
    ProtocolTaskService::update_memory_tasks(&work_dir, &task_path, &content)
        .map_err(|e| crate::error::AppError::IoError(e))
}

/// 清空用户补充（处理完成后）
#[tauri::command]
pub async fn scheduler_clear_supplement(
    task_path: String,
    work_dir: String,
) -> Result<()> {
    ProtocolTaskService::clear_supplement(&work_dir, &task_path)
        .map_err(|e| crate::error::AppError::IoError(e))
}

/// 备份用户补充内容
#[tauri::command]
pub async fn scheduler_backup_supplement(
    task_path: String,
    work_dir: String,
    content: String,
) -> Result<String> {
    ProtocolTaskService::backup_supplement(&work_dir, &task_path, &content)
        .map_err(|e| crate::error::AppError::IoError(e))
}

/// 备份协议文档
#[tauri::command]
pub async fn scheduler_backup_document(
    task_path: String,
    work_dir: String,
    doc_name: String,
    content: String,
    summary: Option<String>,
) -> Result<String> {
    ProtocolTaskService::backup_document(&work_dir, &task_path, &doc_name, &content, summary.as_deref())
        .map_err(|e| crate::error::AppError::IoError(e))
}

/// 检查用户补充是否有内容
#[tauri::command]
pub fn scheduler_has_supplement_content(content: String) -> bool {
    ProtocolTaskService::has_supplement_content(&content)
}

/// 检查文档是否需要备份
#[tauri::command]
pub fn scheduler_needs_backup(content: String) -> bool {
    ProtocolTaskService::needs_backup(&content)
}

/// 提取用户补充内容
#[tauri::command]
pub fn scheduler_extract_user_content(content: String) -> String {
    ProtocolTaskService::extract_user_content(&content)
}
