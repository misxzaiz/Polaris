/*! 调度器守护进程
 *
 * 后台服务，负责：
 * 1. 轮询检查任务时间表
 * 2. 检测到期任务并通过 ExecutorRegistry 直接执行
 * 3. 更新任务的下次执行时间
 *
 * 不再依赖前端事件处理 — 到期任务直接通过 ExecutorRegistry 执行。
 */

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::time::sleep;

use crate::error::Result;
use crate::models::scheduler::{ScheduledTask, TaskStatus};
use crate::services::executor::{ExecutorContext, ExecutorParams, ExecutorRegistry};
use crate::services::scheduler::TaskUpdateParams;
use crate::services::unified_scheduler_repository::UnifiedSchedulerRepository;
use crate::AppState;

/// 守护进程检查间隔（秒）
const CHECK_INTERVAL_SECS: u64 = 10;

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

    /// 启动守护进程
    pub fn start(&mut self, app_state: Arc<AppState>) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            tracing::warn!("[SchedulerDaemon] 守护进程已在运行");
            return Ok(());
        }

        let running = self.running.clone();
        running.store(true, Ordering::SeqCst);

        let config_dir = self.config_dir.clone();
        let workspace_path = self.workspace_path.clone();

        let executor_registry = app_state.executor_registry.clone();
        let executor_ctx = ExecutorContext::from_app_state(&app_state);

        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        self.stop_signal = Some(stop_tx);

        tracing::info!("[SchedulerDaemon] 启动守护进程，检查间隔: {}秒", CHECK_INTERVAL_SECS);

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
                if let Err(e) = check_and_execute_due_tasks(&executor_registry, ctx, &config_dir, &workspace_path).await {
                    tracing::error!("[SchedulerDaemon] 检查任务失败: {}", e);
                }

                sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
            }

            tracing::info!("[SchedulerDaemon] 守护进程已停止");
        });

        Ok(())
    }

    /// 启动守护进程（Web-only 模式，使用 ExecutorContext 替代 AppState）
    pub fn start_with_ctx(&mut self, executor_registry: ExecutorRegistry, executor_ctx: ExecutorContext) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            tracing::warn!("[SchedulerDaemon] 守护进程已在运行");
            return Ok(());
        }

        let running = self.running.clone();
        running.store(true, Ordering::SeqCst);

        let config_dir = self.config_dir.clone();
        let workspace_path = self.workspace_path.clone();

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
                if let Err(e) = check_and_execute_due_tasks(&executor_registry, ctx, &config_dir, &workspace_path).await {
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

/// 检查到期任务并通过 ExecutorRegistry 直接执行
async fn check_and_execute_due_tasks(
    executor_registry: &ExecutorRegistry,
    executor_ctx: ExecutorContext,
    config_dir: &Path,
    workspace_path: &Option<PathBuf>,
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

                // 构建执行参数
                let params = build_executor_params(&task);

                // 记录触发时间（用于 last_run_at，而非完成时间）
                let trigger_at = chrono::Utc::now().timestamp();

                // 通过 ExecutorRegistry 直接执行（不依赖前端）
                let ctx = executor_ctx.clone();
                let result = executor_registry.execute(params, ctx).await;

                if result.success {
                    tracing::info!(
                        "[SchedulerDaemon] 任务执行成功: {} (session: {:?})",
                        task.name, result.session_id
                    );
                } else {
                    tracing::error!(
                        "[SchedulerDaemon] 任务执行失败: {} (error: {:?})",
                        task.name, result.error
                    );
                }

                // 更新任务状态（使用触发时间戳）
                update_task_status(&repository, &task, result.success, trigger_at)?;
            }
        }
    }

    Ok(())
}

/// 从 ScheduledTask 构建 ExecutorParams
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
        // 确保 executor_type 从任务字段穿透（即使 executor_params 中未设置）
        eparams.executor_type = executor_type;
        return eparams;
    }

    // 旧版兼容：从 prompt/engineId 构建，但保留 executor_type
    let mut params = ExecutorParams::from_legacy(&task.prompt, &task.engine_id, task.work_dir.as_deref());
    params.executor_type = executor_type;
    params
}

/// 更新任务执行状态
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

    // 使用 TaskUpdateParams 传触发时间戳，避免存储层覆盖为 now
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