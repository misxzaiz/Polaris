/*! 调度器守护进程
 *
 * 后台服务，负责：
 * 1. 轮询检查任务时间表
 * 2. 检测到期任务并发送事件通知前端
 * 3. 更新任务的下次执行时间
 *
 * 注意：实际的任务执行由前端通过 handleRun 完成，
 * 因为 AI 引擎执行需要复杂的事件处理。
 */

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use crate::error::Result;
use crate::models::scheduler::ScheduledTask;
use crate::services::scheduler::TaskUpdateParams;
use crate::services::unified_scheduler_repository::UnifiedSchedulerRepository;

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

/// 任务到期事件
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
    /// 提示词
    pub prompt: String,
    /// 模板 ID
    pub template_id: Option<String>,
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
    pub fn start(&mut self, app_handle: AppHandle) -> Result<()> {
        // 检查是否已经在运行
        if self.running.load(Ordering::SeqCst) {
            tracing::warn!("[SchedulerDaemon] 守护进程已在运行");
            return Ok(());
        }

        let running = self.running.clone();
        running.store(true, Ordering::SeqCst);

        let config_dir = self.config_dir.clone();
        let workspace_path = self.workspace_path.clone();

        // 创建停止信号通道
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        self.stop_signal = Some(stop_tx);

        tracing::info!("[SchedulerDaemon] 启动守护进程，检查间隔: {}秒", CHECK_INTERVAL_SECS);

        // 启动后台任务
        tokio::spawn(async move {
            let mut stop_rx = stop_rx;

            loop {
                // 检查是否应该停止
                if !running.load(Ordering::SeqCst) {
                    tracing::info!("[SchedulerDaemon] 收到停止信号，退出循环");
                    break;
                }

                // 检查是否有停止请求
                if stop_rx.try_recv().is_ok() {
                    tracing::info!("[SchedulerDaemon] 收到停止请求，退出循环");
                    running.store(false, Ordering::SeqCst);
                    break;
                }

                // 执行检查
                if let Err(e) = check_and_notify_due_tasks(&app_handle, &config_dir, &workspace_path).await {
                    tracing::error!("[SchedulerDaemon] 检查任务失败: {}", e);
                }

                // 等待下一次检查
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

        // 发送停止信号
        if let Some(stop_tx) = self.stop_signal.take() {
            let _ = stop_tx.send(());
        }

        // 设置运行状态为 false
        self.running.store(false, Ordering::SeqCst);

        Ok(())
    }

    /// 检查守护进程是否正在运行
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// 检查到期任务并发送通知
async fn check_and_notify_due_tasks(
    app_handle: &AppHandle,
    config_dir: &PathBuf,
    workspace_path: &Option<PathBuf>,
) -> Result<()> {
    let repository = UnifiedSchedulerRepository::new(config_dir.clone(), workspace_path.clone());

    // 获取所有启用的任务
    let tasks = repository.list_tasks()?;

    let now = chrono::Utc::now().timestamp();

    // 检查每个任务
    for task in tasks {
        if !task.enabled {
            continue;
        }

        // 检查是否到期
        if let Some(next_run_at) = task.next_run_at {
            if next_run_at <= now {
                tracing::info!(
                    "[SchedulerDaemon] 任务到期: {} (ID: {})",
                    task.name,
                    task.id
                );

                // 发送任务到期事件到前端
                let event = TaskDueEvent {
                    task_id: task.id.clone(),
                    task_name: task.name.clone(),
                    engine_id: task.engine_id.clone(),
                    work_dir: task.work_dir.clone(),
                    prompt: task.prompt.clone(),
                    template_id: task.template_id.clone(),
                };

                // 发送全局事件
                match app_handle.emit("scheduler-task-due", &event) {
                    Ok(()) => {
                        tracing::info!("[SchedulerDaemon] 已发送任务到期事件: {}", task.name);
                    }
                    Err(e) => {
                        tracing::error!("[SchedulerDaemon] 发送事件失败: {}", e);
                    }
                }

                // 更新下次执行时间（避免重复触发）
                update_next_run_time(&repository, &task)?;
            }
        }
    }

    Ok(())
}

/// 更新任务的下次执行时间
fn update_next_run_time(
    repository: &UnifiedSchedulerRepository,
    task: &ScheduledTask,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp();

    // 计算下次执行时间
    let next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, now);

    // 更新任务
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

impl Drop for SchedulerDaemon {
    fn drop(&mut self) {
        if self.running.load(Ordering::SeqCst) {
            tracing::warn!("[SchedulerDaemon] 守护进程在运行中被销毁，尝试停止");
            let _ = self.stop();
        }
    }
}
