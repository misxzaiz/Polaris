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
use crate::models::scheduler::{ScheduledTask, TaskStatus};
use crate::services::executor::{ExecutorContext, ExecutorParams, ExecutorRegistry};
use crate::services::scheduler::TaskUpdateParams;
use crate::services::unified_scheduler_repository::UnifiedSchedulerRepository;
use crate::AppState;

/// 守护进程检查间隔（秒）
const CHECK_INTERVAL_SECS: u64 = 10;

/// 未设置 timeout_minutes 时，Running 卡死的自愈阈值（秒，默认 30 分钟）
const STALE_RUNNING_SECS: i64 = 30 * 60;

/// 守护循环的「桌面事件出口」参数类型。
///
/// Web-only 构建没有 Tauri AppHandle，用一个空类型占位以复用同一段循环代码，
/// 避免两份几乎相同的轮询循环（历史上两份循环已经分叉出过 bug）。
#[cfg(feature = "tauri-app")]
type DaemonAppHandle = Option<AppHandle>;
#[cfg(not(feature = "tauri-app"))]
type DaemonAppHandle = Option<()>;

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
    /// 守护任务句柄。用于区分「已正常停止」与「任务 panic 退出」——
    /// 后者会把 `running` 永久留在 true，形成持有锁的僵尸状态。
    handle: Option<tokio::task::JoinHandle<()>>,
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
            handle: None,
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
        let event_broadcast = Arc::new(event_broadcast);
        self.handle = Some(tokio::spawn(run_daemon_loop(
            running,
            stop_rx,
            executor_registry,
            executor_ctx,
            config_dir,
            workspace_path,
            Some(app_handle),
            Some(event_broadcast),
        )));

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

        let event_broadcast = Arc::new(event_broadcast);
        self.handle = Some(tokio::spawn(run_daemon_loop(
            running,
            stop_rx,
            executor_registry,
            executor_ctx,
            config_dir,
            workspace_path,
            None,
            Some(event_broadcast),
        )));

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

    /// 守护任务是否已终止（正常停止或异常退出）。
    ///
    /// `running` 标志由循环体负责重置，但循环本身尚未被 Join 时两者会短暂不一致；
    /// 状态查询可用此判断是否需要重新拉起守护进程。
    pub fn task_terminated(&self) -> bool {
        match self.handle.as_ref() {
            Some(handle) => handle.is_finished(),
            None => false,
        }
    }
}

/// 守护进程主循环（桌面 / Web 共用）。
///
/// 退出语义：正常退出时 `running` 已为 false；若在 `running` 仍为 true 时异常
/// 结束（如 `check_and_execute_due_tasks` panic 导致 task 被 drop、`stop_rx` 被
/// 丢弃），则重置为 false 并告警。否则 `running` 永久卡在 true，配合外部持有的
/// 文件锁会形成「锁定但无人轮询」的僵尸状态，任务将永远不再触发。
async fn run_daemon_loop(
    running: Arc<AtomicBool>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
    executor_registry: ExecutorRegistry,
    executor_ctx: ExecutorContext,
    config_dir: PathBuf,
    workspace_path: Option<PathBuf>,
    app_handle: DaemonAppHandle,
    event_broadcast: Option<Arc<crate::web::EventBroadcaster>>,
) {
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
        let bcast = event_broadcast.as_deref();
        #[cfg(feature = "tauri-app")]
        let app_handle_ref = app_handle.as_ref();
        #[cfg(not(feature = "tauri-app"))]
        let app_handle_ref = app_handle.as_ref();

        if let Err(e) = check_and_execute_due_tasks(
            &executor_registry,
            ctx,
            &config_dir,
            &workspace_path,
            app_handle_ref,
            bcast,
        )
        .await
        {
            tracing::error!("[SchedulerDaemon] 检查任务失败: {}", e);
        }

        sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
    }

    if running.swap(false, Ordering::SeqCst) {
        tracing::warn!("[SchedulerDaemon] 守护循环在 running=true 状态下退出（异常路径），已重置运行标志");
    }
    tracing::info!("[SchedulerDaemon] 守护进程已停止");
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

        // 正在执行中的任务跳过(防止重复触发)。
        // AfterCompletion 触发后设 last_run_status=Running,等前端 session_end 回调
        // updateRunStatus(Success/Failed) 后才解除。存储层 update_task 对
        // next_run_at=None 会重算(now+interval),故不能靠 next_run_at=None 防重复。
        //
        // 自愈兜底:session_end 丢失(断网/应用重启/AI 崩溃)时 Running 会永久残留,
        // 任务永久不再触发。超过 timeout_minutes(默认 30 分钟)未回收则重置为
        // Failed 并允许重新触发。next_run_at 由存储层在非 Running 时自动重算。
        if task.last_run_status == Some(TaskStatus::Running) {
            if let Some(last_run_at) = task.last_run_at {
                let stale_secs = task.timeout_minutes.map(|m| (m as i64) * 60).unwrap_or(STALE_RUNNING_SECS);
                if now.saturating_sub(last_run_at) > stale_secs {
                    tracing::warn!(
                        "[SchedulerDaemon] 自愈: 任务 '{}' (ID: {}) 卡死 Running {}s(阈值 {}s),重置为 Failed",
                        task.name, task.id,
                        now - last_run_at, stale_secs
                    );
                    if let Err(e) = repository.update_task(&task.id, TaskUpdateParams {
                        last_run_status: Some(TaskStatus::Failed),
                        ..Default::default()
                    }) {
                        tracing::error!("[SchedulerDaemon] 自愈重置失败: {} (ID: {})", e, task.id);
                    }
                    continue;
                }
            }
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
/// 设 last_run_status=Running 防止 daemon 重复触发(存储层对 next_run_at=None
/// 会重算为 now+interval,不能靠 None 防重复,故用 Running 标志)。
/// next_run_at 交给存储层重算(Interval→now+interval;AfterCompletion 在
/// 前端 updateRunStatus 完成时重算)。终态由前端 updateRunStatus 驱动。
fn update_next_run_time(
    repository: &UnifiedSchedulerRepository,
    task: &ScheduledTask,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp();

    repository.update_task(&task.id, TaskUpdateParams {
        last_run_at: Some(now),
        last_run_status: Some(TaskStatus::Running),
        // next_run_at 不设(传 None),存储层重算:
        // AfterCompletion → now+interval(但被 Running 标志跳过,等完成后再算);
        // Interval → now+interval
        ..Default::default()
    })?;

    tracing::info!(
        "[SchedulerDaemon] 更新任务状态为 Running(发事件后): {} (ID: {})",
        task.name, task.id
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
