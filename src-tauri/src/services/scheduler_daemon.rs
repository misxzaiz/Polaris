/*! 调度器守护进程
 *
 * 后台服务，负责：
 * 1. 轮询检查任务时间表
 * 2. 检测到期任务:
 *    - chat 类型:发 TaskDueEvent 到前端(桌面 Tauri emit / Web WS broadcast),
 *      由前端 handleTaskDue 构建 prompt(协议/模板/简单三态)+ 调 start_chat 执行 +
 *      管理 Running→Success 状态回收(含 AfterCompletion 的 next_run_at 重算)
 *    - command/http/plugin 类型:直接调 ExecutorRegistry::execute,daemon 管理终态
 * 3. 更新任务的下次执行时间
 *
 * 设计理由:AI 会话执行天然是前端驱动(复杂事件流、session_end 回报、协议文档构建),
 * daemon 直接执行会丢失这些环节导致协议退化为普通 prompt 和 AfterCompletion 状态机断裂。
 * 非 chat 执行器无此问题,继续后端直接执行。
 */

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::sleep;

use crate::error::Result;
use crate::models::scheduler::{ScheduledTask, TriggerType};
use crate::services::executor::{ExecutorContext, ExecutorParams, ExecutorRegistry};
use crate::services::scheduler::TaskUpdateParams;
use crate::services::unified_scheduler_repository::UnifiedSchedulerRepository;
use crate::AppState;

/// 守护进程检查间隔（秒）
const CHECK_INTERVAL_SECS: u64 = 10;

/// 任务到期事件（发给前端，由 handleTaskDue 消费）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDueEvent {
    /// 任务 ID
    pub task_id: String,
    /// 任务名称
    pub task_name: String,
    /// 引擎 ID
    pub engine_id: String,
    /// 工作目录
    pub work_dir: Option<String>,
    /// 提示词（简单模式使用）
    pub prompt: String,
    /// 模板 ID
    pub template_id: Option<String>,
    /// 任务模式（"simple" | "protocol"）
    pub mode: String,
    /// 协议任务路径（协议模式使用）
    pub task_path: Option<String>,
    /// 任务目标（协议模式使用）
    pub mission: Option<String>,
}

/// 调度器守护进程
pub struct SchedulerDaemon {
    /// 是否正在运行
    running: Arc<AtomicBool>,
    /// 停止信号
    stop_signal: Option<tokio::sync::oneshot::Sender<()>>,
    /// 工作区路径
    workspace_path: Option<PathBuf>,
    /// 配置目录
    config_dir: PathBuf,
}

impl SchedulerDaemon {
    /// 创建新的守护进程实例
    pub fn new(config_dir: PathBuf, workspace_path: Option<PathBuf>) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            stop_signal: None,
            workspace_path,
            config_dir,
        }
    }

    /// 启动守护进程（桌面模式，通过 Tauri events 通知前端）
    #[cfg(feature = "tauri-app")]
    pub fn start(&mut self, app: AppHandle) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            tracing::warn!("[SchedulerDaemon] 守护进程已在运行");
            return Ok(());
        }

        let state = app.state::<AppState>();
        let executor_registry = state.executor_registry.clone();
        let executor_ctx = ExecutorContext::from_ref(state.inner());
        let event_broadcast = state.event_broadcast.clone();

        let running = self.running.clone();
        running.store(true, Ordering::SeqCst);

        let config_dir = self.config_dir.clone();
        let workspace_path = self.workspace_path.clone();

        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        self.stop_signal = Some(stop_tx);

        tracing::info!("[SchedulerDaemon] 启动守护进程(桌面)，检查间隔: {}秒", CHECK_INTERVAL_SECS);

        let app_handle = app.clone();
        tokio::spawn(async move {
            let mut stop_rx = stop_rx;

            loop {
                if !running.load(Ordering::SeqCst) {
                    tracing::info!("[SchedulerDaemon] 收到停止信号，退出循环");
                    break;
                }

                if stop_rx.try_recv().is_ok() {
                    tracing::info!("[SchedulerDaemon] 收到停止请求，退出循环");
                    running.store(false, Ordering::SeqCst);
                    break;
                }

                let ctx = executor_ctx.clone();
                let bcast = event_broadcast.clone();
                if let Err(e) = check_and_execute_due_tasks(
                    &executor_registry,
                    ctx,
                    &config_dir,
                    &workspace_path,
                    Some(&app_handle),
                    Some(&bcast),
                ).await {
                    tracing::error!("[SchedulerDaemon] 检查任务失败: {}", e);
                }

                sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
            }

            tracing::info!("[SchedulerDaemon] 守护进程已停止");
        });

        Ok(())
    }

    /// 启动守护进程（Web 模式，使用 WebSocket broadcast 替代 Tauri events）
    pub fn start_with_ctx(
        &mut self,
        executor_registry: ExecutorRegistry,
        executor_ctx: ExecutorContext,
    ) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            tracing::warn!("[SchedulerDaemon] 守护进程已在运行");
            return Ok(());
        }

        let running = self.running.clone();
        running.store(true, Ordering::SeqCst);

        let config_dir = self.config_dir.clone();
        let workspace_path = self.workspace_path.clone();
        let event_broadcast = executor_ctx.event_broadcast.clone();

        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        self.stop_signal = Some(stop_tx);

        tracing::info!("[SchedulerDaemon] 启动守护进程 (web mode)，检查间隔: {}秒", CHECK_INTERVAL_SECS);

        tokio::spawn(async move {
            let mut stop_rx = stop_rx;

            loop {
                if !running.load(Ordering::SeqCst) {
                    tracing::info!("[SchedulerDaemon] 收到停止信号，退出循环");
                    break;
                }

                if stop_rx.try_recv().is_ok() {
                    tracing::info!("[SchedulerDaemon] 收到停止请求，退出循环");
                    running.store(false, Ordering::SeqCst);
                    break;
                }

                let ctx = executor_ctx.clone();
                let bcast = event_broadcast.clone();
                if let Err(e) = check_and_execute_due_tasks(
                    &executor_registry,
                    ctx,
                    &config_dir,
                    &workspace_path,
                    None,
                    Some(&bcast),
                ).await {
                    tracing::error!("[SchedulerDaemon] 检查任务失败: {}", e);
                }

                sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
            }

            tracing::info!("[SchedulerDaemon] 守护进程已停止");
        });

        Ok(())
    }

    /// 停止守护进程
    pub fn stop(&mut self) -> Result<()> {
        if !self.running.load(Ordering::SeqCst) {
            tracing::info!("[SchedulerDaemon] 守护进程未在运行");
            return Ok(());
        }

        tracing::info!("[SchedulerDaemon] 正在停止守护进程...");

        if let Some(stop_tx) = self.stop_signal.take() {
            let _ = stop_tx.send(());
        }

        self.running.store(false, Ordering::SeqCst);

        Ok(())
    }

    /// 检查守护进程是否正在运行
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// 检查到期任务并执行/通知
///
/// 按 executor_type 分流:
/// - chat: 发 TaskDueEvent 到前端(桌面 Tauri emit / Web WS broadcast),
///   前端 handleTaskDue 负责构建 prompt + 调 start_chat + 状态回收。
///   daemon 仅调 update_next_run_time(非终态:AfterCompletion→next_run_at=None 锁,
///   Interval→now+interval)。
/// - command/http/plugin: 直接调 ExecutorRegistry::execute,daemon 管理终态。
async fn check_and_execute_due_tasks(
    executor_registry: &ExecutorRegistry,
    executor_ctx: ExecutorContext,
    config_dir: &Path,
    workspace_path: &Option<PathBuf>,
    #[cfg(feature = "tauri-app")] app_handle: Option<&AppHandle>,
    #[cfg(not(feature = "tauri-app"))] _app_handle: Option<&()>,
    event_broadcast: Option<&crate::web::EventBroadcaster>,
) -> Result<()> {
    let repository = UnifiedSchedulerRepository::new(config_dir.to_path_buf(), workspace_path.clone());
    let tasks = repository.list_tasks()?;
    let now = chrono::Utc::now().timestamp();

    for task in tasks {
        if !task.enabled {
            continue;
        }

        if let Some(next_run_at) = task.next_run_at {
            if next_run_at <= now {
                tracing::info!(
                    "[SchedulerDaemon] 任务到期: {} (ID: {})",
                    task.name, task.id
                );

                let executor_type = if task.executor_type.is_empty() {
                    "chat".to_string()
                } else {
                    task.executor_type.clone()
                };

                if executor_type == "chat" {
                    // ── chat 类型:发 TaskDueEvent 到前端,由前端执行 ──
                    let event = TaskDueEvent {
                        task_id: task.id.clone(),
                        task_name: task.name.clone(),
                        engine_id: task.engine_id.clone(),
                        work_dir: task.work_dir.clone(),
                        prompt: task.prompt.clone(),
                        template_id: task.template_id.clone(),
                        mode: task.mode.to_string(),
                        task_path: task.task_path.clone(),
                        mission: task.mission.clone(),
                    };

                    let mut sent = false;

                    // 桌面:Tauri emit
                    #[cfg(feature = "tauri-app")]
                    if let Some(handle) = app_handle {
                        match handle.emit("scheduler-task-due", &event) {
                            Ok(()) => {
                                sent = true;
                                tracing::info!(
                                    "[SchedulerDaemon] 已发送 TaskDue 事件(桌面): {} (ID: {})",
                                    task.name, task.id
                                );
                            }
                            Err(e) => {
                                tracing::error!(
                                    "[SchedulerDaemon] Tauri emit 失败: {} (ID: {})",
                                    e, task.id
                                );
                            }
                        }
                    }

                    // Web:WS broadcast
                    if !sent {
                        if let Some(broadcaster) = event_broadcast {
                            let ws_msg = serde_json::json!({
                                "event": "scheduler-task-due",
                                "payload": event,
                            });
                            match broadcaster.send(ws_msg.to_string()) {
                                Ok(_) => {
                                    sent = true;
                                    tracing::info!(
                                        "[SchedulerDaemon] 已发送 TaskDue 事件(Web): {} (ID: {})",
                                        task.name, task.id
                                    );
                                }
                                Err(e) => {
                                    tracing::error!(
                                        "[SchedulerDaemon] WS broadcast 失败: {} (ID: {})",
                                        e, task.id
                                    );
                                }
                            }
                        }
                    }

                    if sent {
                        // 仅更新 next_run_at(非终态)。AfterCompletion→None 锁防重复触发;
                        // Interval→now+interval。终态(Success/Failed)由前端 updateRunStatus 驱动。
                        update_next_run_time(&repository, &task)?;
                    } else {
                        tracing::error!(
                            "[SchedulerDaemon] TaskDue 事件发送失败,不更新状态,下轮重试: {} (ID: {})",
                            task.name, task.id
                        );
                    }
                } else {
                    // ── 非 chat 类型:直接执行,daemon 管理终态 ──
                    let params = build_executor_params(&task);
                    let trigger_at = chrono::Utc::now().timestamp();
                    let ctx = executor_ctx.clone();
                    let result = executor_registry.execute(params, ctx).await;

                    if result.success {
                        tracing::info!(
                            "[SchedulerDaemon] 任务执行成功: {} ({})",
                            task.name,
                            result.session_id.map(|s| format!("session: {}", s)).unwrap_or_default()
                        );
                    } else {
                        tracing::error!(
                            "[SchedulerDaemon] 任务执行失败: {} (error: {:?})",
                            task.name, result.error
                        );
                    }

                    update_task_status(&repository, &task, result.success, trigger_at)?;
                }
            }
        }
    }

    Ok(())
}

/// 从 ScheduledTask 构建 ExecutorParams（仅非 chat 类型使用）
fn build_executor_params(task: &ScheduledTask) -> ExecutorParams {
    let executor_type = if task.executor_type.is_empty() {
        "chat".to_string()
    } else {
        task.executor_type.clone()
    };

    // 如果有显式的 executor_params，使用它
    if let Some(ref params) = task.executor_params {
        let mut eparams: ExecutorParams = serde_json::from_value(params.clone())
            .unwrap_or_else(|_| {
                ExecutorParams::from_legacy(&task.prompt, &task.engine_id, task.work_dir.as_deref())
            });
        // 确保 executor_type 从任务字段穿透
        eparams.executor_type = executor_type;
        return eparams;
    }

    // 旧版兼容
    let mut params = ExecutorParams::from_legacy(&task.prompt, &task.engine_id, task.work_dir.as_deref());
    params.executor_type = executor_type;
    params
}

/// 更新任务的下次执行时间（非终态，仅用于 chat 类型发事件后）
///
/// AfterCompletion → next_run_at = None（Running 锁，防执行期间重复触发，
/// 等前端 updateRunStatus 在任务完成时重算）
/// 其他类型 → next_run_at = now + interval
fn update_next_run_time(
    repository: &UnifiedSchedulerRepository,
    task: &ScheduledTask,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp();

    let next_run_at = if task.trigger_type == TriggerType::AfterCompletion {
        None
    } else {
        task.trigger_type.calculate_next_run(&task.trigger_value, now)
    };

    repository.update_task(&task.id, TaskUpdateParams {
        next_run_at,
        last_run_at: Some(now),
        ..Default::default()
    })?;

    tracing::info!(
        "[SchedulerDaemon] 更新任务下次执行时间: {} -> {:?}",
        task.name,
        next_run_at
    );

    Ok(())
}

/// 更新任务执行状态（仅非 chat 类型使用，chat 类型由前端 updateRunStatus 驱动）
fn update_task_status(
    repository: &UnifiedSchedulerRepository,
    task: &ScheduledTask,
    success: bool,
    trigger_at: i64,
) -> Result<()> {
    use crate::models::scheduler::TaskStatus;

    let status = if success {
        TaskStatus::Success
    } else {
        TaskStatus::Failed
    };

    repository.update_task(&task.id, TaskUpdateParams {
        last_run_at: Some(trigger_at),
        last_run_status: Some(status),
        ..Default::default()
    })?;

    tracing::info!(
        "[SchedulerDaemon] 更新任务状态: {} -> {:?} (trigger_at={})",
        task.name,
        status,
        trigger_at
    );

    Ok(())
}

impl Drop for SchedulerDaemon {
    fn drop(&mut self) {
        if self.running.load(Ordering::SeqCst) {
            tracing::warn!("[SchedulerDaemon] 守护进程在运行中被销毁，尝试停止");
            let _ = self.stop();
        }
    }
}
