/*! 调度执行器
 *
 * 负责检查待执行任务并调用 AI 引擎执行
 */

use crate::error::Result;
use crate::models::scheduler::{ScheduledTask, TaskStatus, RunTaskResult};
use crate::ai::{EngineRegistry, EngineId, SessionOptions};
use crate::models::AIEvent;
use super::store::{TaskStoreService, LogStoreService, UpdateCompleteParams};
use super::ProtocolTaskService;
use super::continuation::ContinuationDecider;
use super::session_strategy::SessionStrategyResolver;
use super::prompt_builder::{PromptBuilder, PromptType};
use super::execution_result::{ExecutionResultAnalyzer, ExecutionOutcome};
use super::UnifiedStorageService;

use std::sync::Arc;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex as AsyncMutex;
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Window, Emitter};

/// 调度执行器
#[derive(Clone)]
pub struct SchedulerDispatcher {
    /// 任务存储服务（旧版 JSON 存储）
    task_store: Arc<AsyncMutex<TaskStoreService>>,
    /// 日志存储服务（旧版 JSON 存储）
    log_store: Arc<AsyncMutex<LogStoreService>>,
    /// 统一存储服务（新版 SQLite 存储，优先使用）
    unified_storage: Option<Arc<AsyncMutex<UnifiedStorageService>>>,
    /// AI 引擎注册表
    engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    /// 正在执行的任务
    running_tasks: Arc<AsyncMutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    /// 调度循环取消令牌
    cancel_token: Arc<AsyncMutex<Option<CancellationToken>>>,
    /// Tauri AppHandle 用于发送事件
    app_handle: Option<AppHandle>,
}

impl SchedulerDispatcher {
    /// 创建新的调度执行器
    pub fn new(
        task_store: Arc<AsyncMutex<TaskStoreService>>,
        log_store: Arc<AsyncMutex<LogStoreService>>,
        engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    ) -> Self {
        Self {
            task_store,
            log_store,
            unified_storage: None,
            engine_registry,
            running_tasks: Arc::new(AsyncMutex::new(HashMap::new())),
            cancel_token: Arc::new(AsyncMutex::new(None)),
            app_handle: None,
        }
    }

    /// 设置统一存储服务
    pub fn with_unified_storage(mut self, storage: Arc<AsyncMutex<UnifiedStorageService>>) -> Self {
        self.unified_storage = Some(storage);
        self
    }

    /// 设置 AppHandle
    pub fn with_app_handle(mut self, handle: AppHandle) -> Self {
        self.app_handle = Some(handle);
        self
    }

    /// 检查 unified_storage 是否可用
    fn has_unified_storage(&self) -> bool {
        self.unified_storage.is_some()
    }

    /// 启动调度循环
    pub fn start(&mut self, app_handle: Option<AppHandle>) {
        // 保存 app_handle
        self.app_handle = app_handle;

        // 检查是否已经在运行
        if let Ok(token) = self.cancel_token.try_lock() {
            if token.is_some() {
                tracing::warn!("[Scheduler] 调度器已在运行中");
                return;
            }
        }

        let cancel_token = CancellationToken::new();
        let token_clone = cancel_token.clone();

        // 保存取消令牌
        if let Ok(mut token) = self.cancel_token.try_lock() {
            *token = Some(cancel_token);
        }

        let dispatcher = self.clone();
        tauri::async_runtime::spawn(async move {
            // 启动时检查是否需要自动清理日志
            {
                let mut log_store = dispatcher.log_store.lock().await;
                if log_store.should_auto_cleanup() {
                    tracing::info!("[Scheduler] 启动时执行自动日志清理");
                    match log_store.cleanup_expired_logs() {
                        Ok(count) => {
                            if count > 0 {
                                tracing::info!("[Scheduler] 自动清理了 {} 条过期日志", count);
                            }
                        }
                        Err(e) => {
                            tracing::error!("[Scheduler] 自动日志清理失败: {:?}", e);
                        }
                    }
                }
            }

            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
            // 每小时检查一次自动清理
            let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(3600));
            cleanup_interval.tick().await; // 跳过第一次立即触发

            loop {
                tokio::select! {
                    _ = token_clone.cancelled() => {
                        tracing::info!("[Scheduler] 调度器已停止");
                        break;
                    }
                    _ = interval.tick() => {
                        // 检查并执行待执行任务
                        if let Err(e) = dispatcher.check_and_execute().await {
                            tracing::error!("[Scheduler] 调度检查失败: {:?}", e);
                        }
                    }
                    _ = cleanup_interval.tick() => {
                        // 每小时检查是否需要自动清理日志
                        let mut log_store = dispatcher.log_store.lock().await;
                        if log_store.should_auto_cleanup() {
                            tracing::info!("[Scheduler] 定时检查：执行自动日志清理");
                            match log_store.cleanup_expired_logs() {
                                Ok(count) => {
                                    if count > 0 {
                                        tracing::info!("[Scheduler] 自动清理了 {} 条过期日志", count);
                                    }
                                }
                                Err(e) => {
                                    tracing::error!("[Scheduler] 自动日志清理失败: {:?}", e);
                                }
                            }
                        }
                    }
                }
            }
        });

        tracing::info!("[Scheduler] 调度器已启动");
    }

    /// 停止调度循环
    pub fn stop(&self) {
        if let Ok(mut token) = self.cancel_token.try_lock() {
            if let Some(token) = token.take() {
                token.cancel();
                tracing::info!("[Scheduler] 调度器停止信号已发送");
            }
        }
    }

    /// 检查调度器是否在运行
    pub fn is_running(&self) -> bool {
        if let Ok(token) = self.cancel_token.try_lock() {
            token.is_some()
        } else {
            true // 如果无法获取锁，假设正在运行
        }
    }

    /// 检查并执行待执行任务
    async fn check_and_execute(&self) -> Result<()> {
        let pending_tasks: Vec<ScheduledTask> = if self.has_unified_storage() {
            // 优先使用统一存储服务
            let storage = self.unified_storage.as_ref().unwrap();
            let storage = storage.lock().await;
            storage.get_pending_tasks()?
        } else {
            // 回退到旧版 JSON 存储
            let store = self.task_store.lock().await;
            store.get_pending_tasks()
                .into_iter()
                .cloned()
                .collect()
        };

        for task in pending_tasks {
            // 检查是否已经在执行
            let is_running = {
                let running = self.running_tasks.lock().await;
                running.contains_key(&task.id)
            };

            if is_running {
                continue;
            }

            // 检查任务是否有订阅
            if let Some(ref context_id) = task.subscribed_context_id {
                // 有订阅：发送事件通知前端，让前端调用 runTaskWithSubscription
                if let Some(ref app_handle) = self.app_handle {
                    let task_id = task.id.clone();
                    let task_name = task.name.clone();
                    let ctx_id = context_id.clone();

                    tracing::info!("[Scheduler] 任务 {} 有订阅，发送 scheduler-task-due 事件", task_name);

                    if let Err(e) = app_handle.emit("scheduler-event", serde_json::json!({
                        "contextId": ctx_id,
                        "payload": {
                            "type": "task_due",
                            "taskId": task_id,
                            "taskName": task_name,
                        }
                    })) {
                        tracing::error!("[Scheduler] 发送 scheduler-task-due 事件失败: {:?}", e);
                    }
                } else {
                    // 没有 app_handle，回退到直接执行
                    tracing::warn!("[Scheduler] 无 AppHandle，直接执行订阅任务");
                    if let Err(e) = self.execute_task(task).await {
                        tracing::error!("[Scheduler] 执行任务失败: {:?}", e);
                    }
                }
            } else {
                // 无订阅：直接执行任务（后台执行，不发送事件到前端）
                if let Err(e) = self.execute_task(task).await {
                    tracing::error!("[Scheduler] 执行任务失败: {:?}", e);
                }
            }
        }

        Ok(())
    }

    /// 执行单个任务，返回日志 ID
    async fn execute_task(&self, task: ScheduledTask) -> Result<String> {
        self.execute_task_with_continuation_count(task, 1).await
    }

    async fn execute_task_with_continuation_count(&self, task: ScheduledTask, continuous_runs: u32) -> Result<String> {
        let task_id = task.id.clone();
        let task_id_for_map = task.id.clone();
        let task_name = task.name.clone();
        let engine_id = task.engine_id.clone();
        let work_dir = task.work_dir.clone();
        let reuse_session = task.reuse_session;
        // 使用 SessionStrategyResolver 决定会话策略
        let existing_session_id = match SessionStrategyResolver::decide(&task) {
            super::session_strategy::SessionDecision::Continue { session_id } => Some(session_id),
            super::session_strategy::SessionDecision::StartNew => None,
        };
        // 克隆 app_handle 用于通知
        let app_handle_for_notify = self.app_handle.clone();
        let notify_on_complete = task.notify_on_complete;
        // 获取超时配置（分钟转秒）
        let timeout_secs = task.timeout_minutes.map(|m| m as u64 * 60);

        // 根据模式构建提示词（传递连续执行轮次）
        let prompt = self.build_prompt(&task, continuous_runs).await?;

        let task_store = self.task_store.clone();
        let log_store = self.log_store.clone();
        let unified_storage = self.unified_storage.clone();
        let has_unified = self.has_unified_storage();
        let engine_registry = self.engine_registry.clone();
        let running_tasks = self.running_tasks.clone();
        let dispatcher_for_continue = self.clone();

        // 用于后续处理用户补充
        let task_for_post = task.clone();

        // 创建日志记录（状态为 Running）
        let log_id = if has_unified {
            let storage = unified_storage.as_ref().unwrap();
            let storage = storage.lock().await;
            let log = storage.create_log(&task_id, &task_name, &prompt, &engine_id)?;
            tracing::info!("[Scheduler] 创建日志 (SQLite): {} for task: {}", log.id, task_name);
            log.id
        } else {
            let mut store = self.log_store.lock().await;
            let log = store.create(&task_id, &task_name, &prompt, &engine_id)?;
            tracing::info!("[Scheduler] 创建日志 (JSON): {} for task: {}", log.id, task_name);
            log.id
        };

        // 标记任务开始执行
        if has_unified {
            let storage = unified_storage.as_ref().unwrap();
            let storage = storage.lock().await;
            storage.update_run_status(&task_id, TaskStatus::Running, true)?;
        } else {
            let mut store = self.task_store.lock().await;
            store.update_run_status(&task_id, TaskStatus::Running)?;
        }

        let log_id_clone = log_id.clone();
        let handle = tokio::spawn(async move {
            tracing::info!("[Scheduler] 开始执行任务: {} ({})", task_name, task_id);

            // 解析引擎 ID
            let engine_id_parsed = EngineId::from_str(&engine_id)
                .unwrap_or(EngineId::ClaudeCode);

            // 收集输出、思考过程、工具调用、session_id
            let output = Arc::new(AsyncMutex::new(String::new()));
            let thinking = Arc::new(AsyncMutex::new(String::new()));
            let session_id = Arc::new(AsyncMutex::new(existing_session_id.clone()));
            let session_id_for_update = session_id.clone();
            let tool_call_count = Arc::new(AsyncMutex::new(0u32));

            // 用于标记是否已更新完成状态
            let completed = Arc::new(AtomicBool::new(false));
            let completed_clone = completed.clone();
            let _completed_for_timeout = completed.clone();

            let output_clone = output.clone();
            let thinking_clone = thinking.clone();
            let session_id_clone = session_id.clone();
            let tool_call_count_clone = tool_call_count.clone();

            // 完成回调的闭包所需变量
            let log_id_for_complete = log_id_clone.clone();
            let task_id_for_complete = task_id.clone();
            let task_name_for_complete = task_name.clone();
            let task_store_for_complete = task_store.clone();
            let log_store_for_complete = log_store.clone();
            let unified_storage_for_complete = unified_storage.clone();
            let has_unified_for_complete = has_unified;
            let output_for_complete = output.clone();
            let thinking_for_complete = thinking.clone();
            let session_id_for_complete = session_id.clone();
            let tool_call_count_for_complete = tool_call_count.clone();
            let running_tasks_for_complete = running_tasks.clone();
            let task_for_complete = task_for_post.clone();
            let dispatcher_for_complete = dispatcher_for_continue.clone();
            let continuous_runs_for_complete = continuous_runs;
            // 克隆 app_handle 给完成回调和超时监控分别使用
            let app_handle_for_complete = app_handle_for_notify.clone();
            let app_handle_for_timeout_main = app_handle_for_notify.clone();

            let build_options = || {
                let output_clone = output_clone.clone();
                let thinking_clone = thinking_clone.clone();
                let session_id_clone = session_id_clone.clone();
                let tool_call_count_clone = tool_call_count_clone.clone();
                let session_id_for_update = session_id_for_update.clone();
                let completed_clone = completed_clone.clone();
                let log_id_for_complete = log_id_for_complete.clone();
                let task_id_for_complete = task_id_for_complete.clone();
                let task_name_for_complete = task_name_for_complete.clone();
                let task_store_for_complete = task_store_for_complete.clone();
                let log_store_for_complete = log_store_for_complete.clone();
                let unified_storage_for_complete = unified_storage_for_complete.clone();
                let has_unified_for_complete = has_unified_for_complete;
                let output_for_complete = output_for_complete.clone();
                let thinking_for_complete = thinking_for_complete.clone();
                let session_id_for_complete = session_id_for_complete.clone();
                let tool_call_count_for_complete = tool_call_count_for_complete.clone();
                let running_tasks_for_complete = running_tasks_for_complete.clone();
                let task_for_complete = task_for_complete.clone();
                let dispatcher_for_complete = dispatcher_for_complete.clone();
                let app_handle_for_complete = app_handle_for_complete.clone();

                SessionOptions::new(move |event: AIEvent| {
                    match &event {
                        AIEvent::AssistantMessage(msg) => {
                            if let Ok(mut o) = output_clone.try_lock() {
                                o.push_str(&msg.content);
                            }
                        }
                        AIEvent::Thinking(t) => {
                            if let Ok(mut th) = thinking_clone.try_lock() {
                                th.push_str(&t.content);
                                th.push('\n');
                            }
                        }
                        AIEvent::ToolCallStart(_) => {
                            if let Ok(mut count) = tool_call_count_clone.try_lock() {
                                *count += 1;
                            }
                        }
                        AIEvent::SessionStart(s) => {
                            if let Ok(mut sid) = session_id_clone.try_lock() {
                                *sid = Some(s.session_id.clone());
                            }
                        }
                        _ => {}
                    }
                })
                .with_work_dir(work_dir.clone().unwrap_or_else(|| ".".to_string()))
                .with_on_session_id_update(move |sid: String| {
                    if let Ok(mut s) = session_id_for_update.try_lock() {
                        *s = Some(sid);
                    }
                })
                .with_on_complete(move |exit_code: i32| {
                    // 防止重复调用
                    if completed_clone.swap(true, Ordering::SeqCst) {
                        return;
                    }

                    tracing::info!("[Scheduler] 会话完成，exit_code: {}", exit_code);

                    let log_id = log_id_for_complete.clone();
                    let task_id = task_id_for_complete.clone();
                    let task_name = task_name_for_complete.clone();
                    let task_store = task_store_for_complete.clone();
                    let log_store = log_store_for_complete.clone();
                    let unified_storage = unified_storage_for_complete.clone();
                    let has_unified = has_unified_for_complete;
                    let output = output_for_complete.clone();
                    let thinking = thinking_for_complete.clone();
                    let session_id = session_id_for_complete.clone();
                    let tool_call_count = tool_call_count_for_complete.clone();
                    let running_tasks = running_tasks_for_complete.clone();
                    let task_for_complete = task_for_complete.clone();
                    let dispatcher_for_complete = dispatcher_for_complete.clone();
                    let app_handle_for_notify = app_handle_for_complete.clone();

                    let task_work_dir_for_complete = task_for_complete.work_dir.clone();
                    let task_task_path_for_complete = task_for_complete.task_path.clone();

                    tauri::async_runtime::spawn(async move {
                        let final_output = output.lock().await.clone();
                        let final_thinking = thinking.lock().await.clone();
                        let final_session_id = session_id.lock().await.clone();
                        let final_tool_count = *tool_call_count.lock().await;
                        let run_summary = SchedulerDispatcher::summarize_run_output(&final_output);
                        let pending_summary = if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                            SchedulerDispatcher::summarize_pending_tasks(work_dir, task_path)
                        } else {
                            "非协议任务，无待办摘要".to_string()
                        };

                        // 使用结构化执行结果分析器
                        let execution_outcome = ExecutionResultAnalyzer::analyze(
                            exit_code,
                            &final_output,
                            final_tool_count,
                            task_work_dir_for_complete.as_deref(),
                            task_task_path_for_complete.as_deref(),
                        );

                        let is_success = matches!(
                            &execution_outcome,
                            ExecutionOutcome::SuccessWithProgress | ExecutionOutcome::SuccessNoProgress | ExecutionOutcome::PartialSuccess
                        );

                        // 检测阻塞状态和当前阶段（协议任务）
                        let detected_blocked = if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                            ExecutionResultAnalyzer::detect_blocked(work_dir, task_path)
                        } else {
                            None
                        };
                        let detected_phase = if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                            ExecutionResultAnalyzer::extract_current_phase(work_dir, task_path)
                        } else {
                            None
                        };

                        // 判断是否应继续执行（带无增量检测）
                        let should_continue = is_success
                            && !ExecutionResultAnalyzer::should_stop_continuation_with_increment_check(
                                &execution_outcome,
                                task_work_dir_for_complete.as_deref(),
                                task_task_path_for_complete.as_deref(),
                                Some(&run_summary),
                                None, // 使用默认相似度阈值 0.7
                            )
                            && ContinuationDecider::should_continue(&task_for_complete, continuous_runs_for_complete);

                        // 执行存储操作（根据是否有统一存储选择后端）
                        if is_success {
                            if has_unified {
                                let storage = unified_storage.as_ref().unwrap();
                                let storage = storage.lock().await;

                                if let Err(e) = storage.update_log_complete(
                                    &log_id,
                                    final_session_id.clone(),
                                    Some(final_output.clone()),
                                    None,
                                    if final_thinking.is_empty() { None } else { Some(final_thinking.clone()) },
                                    final_tool_count,
                                    None,
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败 (SQLite): {:?}", e);
                                }

                                if let Err(e) = storage.update_run_status(&task_id, TaskStatus::Success, false) {
                                    tracing::error!("[Scheduler] 更新任务状态失败 (SQLite): {:?}", e);
                                }

                                if task_for_complete.reuse_session {
                                    if let Err(e) = storage.update_conversation_session_id(&task_id, final_session_id.clone()) {
                                        tracing::error!("[Scheduler] 更新任务会话 ID 失败 (SQLite): {:?}", e);
                                    }
                                }

                                if let Err(e) = storage.update_last_run_outcome(&task_id, execution_outcome.clone()) {
                                    tracing::error!("[Scheduler] 更新任务执行结果类型失败 (SQLite): {:?}", e);
                                }

                                if let Err(e) = storage.reset_retry_count(&task_id) {
                                    tracing::error!("[Scheduler] 重置重试计数失败 (SQLite): {:?}", e);
                                }

                                if matches!(&execution_outcome, ExecutionOutcome::SuccessWithProgress) {
                                    if let Err(e) = storage.update_last_effective_progress(&task_id) {
                                        tracing::error!("[Scheduler] 更新有效进展时间失败 (SQLite): {:?}", e);
                                    }
                                }
                            } else {
                                let mut log_store = log_store.lock().await;
                                let mut task_store = task_store.lock().await;

                                if let Err(e) = log_store.update_complete(
                                    &log_id,
                                    UpdateCompleteParams {
                                        session_id: final_session_id.clone(),
                                        output: Some(final_output.clone()),
                                        thinking_summary: if final_thinking.is_empty() { None } else { Some(final_thinking.clone()) },
                                        tool_call_count: final_tool_count,
                                        ..Default::default()
                                    },
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败 (JSON): {:?}", e);
                                }

                                if let Err(e) = task_store.update_run_status(&task_id, TaskStatus::Success) {
                                    tracing::error!("[Scheduler] 更新任务状态失败 (JSON): {:?}", e);
                                }

                                if task_for_complete.reuse_session {
                                    if let Err(e) = task_store.update_conversation_session_id(&task_id, final_session_id.clone()) {
                                        tracing::error!("[Scheduler] 更新任务会话 ID 失败 (JSON): {:?}", e);
                                    }
                                }

                                if let Err(e) = task_store.update_last_run_outcome(&task_id, execution_outcome.clone()) {
                                    tracing::error!("[Scheduler] 更新任务执行结果类型失败 (JSON): {:?}", e);
                                }

                                if let Err(e) = task_store.reset_retry_count(&task_id) {
                                    tracing::error!("[Scheduler] 重置重试计数失败 (JSON): {:?}", e);
                                }

                                if matches!(&execution_outcome, ExecutionOutcome::SuccessWithProgress) {
                                    if let Err(e) = task_store.update_last_effective_progress(&task_id) {
                                        tracing::error!("[Scheduler] 更新有效进展时间失败 (JSON): {:?}", e);
                                    }
                                }
                            }

                            tracing::info!("[Scheduler] 任务执行成功: {} (结果: {:?})", task_name, execution_outcome);

                            // 获取 run_number 用于追加执行记录
                            let run_number = if has_unified {
                                let storage = unified_storage.as_ref().unwrap();
                                let storage = storage.lock().await;
                                storage.get_task(&task_id)
                                    .map(|t| t.map(|t| t.current_runs).unwrap_or(0))
                                    .unwrap_or(0)
                            } else {
                                let store = task_store.lock().await;
                                store.get(&task_id)
                                    .map(|task| task.current_runs)
                                    .unwrap_or(0)
                            };

                            if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                                if let Err(e) = ProtocolTaskService::append_memory_run(
                                    work_dir,
                                    task_path,
                                    run_number,
                                    final_session_id.as_deref(),
                                    &run_summary,
                                    &pending_summary,
                                    should_continue,
                                    Some(&execution_outcome),
                                ) {
                                    tracing::error!("[Scheduler] 追加执行轮次记录失败: {:?}", e);
                                }
                            }

                            if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                                if let Ok(supplement) = ProtocolTaskService::read_supplement_md(work_dir, task_path) {
                                    if ProtocolTaskService::has_supplement_content(&supplement) {
                                        let content = ProtocolTaskService::extract_user_content(&supplement);

                                        if let Err(e) = ProtocolTaskService::backup_supplement(work_dir, task_path, &content) {
                                            tracing::error!("[Scheduler] 备份用户补充失败: {:?}", e);
                                        }

                                        if let Err(e) = ProtocolTaskService::clear_supplement_md(work_dir, task_path) {
                                            tracing::error!("[Scheduler] 清空用户补充文档失败: {:?}", e);
                                        }
                                    }
                                }
                            }
                        } else {
                            let error_msg = match &execution_outcome {
                                ExecutionOutcome::Blocked(reason) => format!("任务被阻塞: {}", reason),
                                ExecutionOutcome::Failed => format!("进程退出码: {}", exit_code),
                                _ => format!("执行结果: {:?}", execution_outcome),
                            };

                            if has_unified {
                                let storage = unified_storage.as_ref().unwrap();
                                let storage = storage.lock().await;

                                if let Err(e) = storage.update_log_complete(
                                    &log_id,
                                    final_session_id.clone(),
                                    Some(final_output.clone()),
                                    Some(error_msg.clone()),
                                    if final_thinking.is_empty() { None } else { Some(final_thinking.clone()) },
                                    final_tool_count,
                                    None,
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败 (SQLite): {:?}", e);
                                }

                                // UnifiedStorageService 暂不支持 update_retry_status 返回 bool，需要额外处理
                                // 暂时使用 JSON 存储的 retry 逻辑
                                let can_retry = {
                                    let mut store = task_store.lock().await;
                                    store.update_retry_status(&task_id).unwrap_or(false)
                                };

                                if can_retry {
                                    tracing::info!("[Scheduler] 任务 {} 失败，将自动重试", task_name);
                                } else {
                                    if let Err(e) = storage.update_run_status(&task_id, TaskStatus::Failed, false) {
                                        tracing::error!("[Scheduler] 更新任务状态失败 (SQLite): {:?}", e);
                                    }
                                    if let Err(e) = storage.update_last_run_outcome(&task_id, execution_outcome.clone()) {
                                        tracing::error!("[Scheduler] 更新任务执行结果类型失败 (SQLite): {:?}", e);
                                    }
                                    tracing::error!("[Scheduler] 任务执行失败: {} - {}", task_name, error_msg);
                                }
                            } else {
                                let mut log_store = log_store.lock().await;
                                let mut task_store = task_store.lock().await;

                                if let Err(e) = log_store.update_complete(
                                    &log_id,
                                    UpdateCompleteParams {
                                        session_id: final_session_id.clone(),
                                        output: Some(final_output.clone()),
                                        error: Some(error_msg.clone()),
                                        thinking_summary: if final_thinking.is_empty() { None } else { Some(final_thinking.clone()) },
                                        tool_call_count: final_tool_count,
                                        ..Default::default()
                                    },
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败 (JSON): {:?}", e);
                                }

                                let can_retry = task_store.update_retry_status(&task_id).unwrap_or(false);

                                if can_retry {
                                    tracing::info!("[Scheduler] 任务 {} 失败，将自动重试", task_name);
                                } else {
                                    if let Err(e) = task_store.update_run_status(&task_id, TaskStatus::Failed) {
                                        tracing::error!("[Scheduler] 更新任务状态失败 (JSON): {:?}", e);
                                    }
                                    if let Err(e) = task_store.update_last_run_outcome(&task_id, execution_outcome.clone()) {
                                        tracing::error!("[Scheduler] 更新任务执行结果类型失败 (JSON): {:?}", e);
                                    }
                                    tracing::error!("[Scheduler] 任务执行失败: {} - {}", task_name, error_msg);
                                }
                            }
                        }

                        // 更新任务的阻塞状态和当前阶段
                        if let Some(ref phase) = detected_phase {
                            if has_unified {
                                let storage = unified_storage.as_ref().unwrap();
                                let storage = storage.lock().await;
                                if let Err(e) = storage.update_current_phase(&task_id, phase) {
                                    tracing::error!("[Scheduler] 更新任务阶段失败 (SQLite): {:?}", e);
                                }
                            } else {
                                let mut store = task_store.lock().await;
                                if let Err(e) = store.update_current_phase(&task_id, phase) {
                                    tracing::error!("[Scheduler] 更新任务阶段失败 (JSON): {:?}", e);
                                }
                            }
                        }
                        if let Some(ref reason) = detected_blocked {
                            if has_unified {
                                let storage = unified_storage.as_ref().unwrap();
                                let storage = storage.lock().await;
                                if let Err(e) = storage.update_blocked_status(&task_id, true, Some(reason.clone())) {
                                    tracing::error!("[Scheduler] 更新任务阻塞状态失败 (SQLite): {:?}", e);
                                }
                            } else {
                                let mut store = task_store.lock().await;
                                if let Err(e) = store.update_blocked_status(&task_id, true, Some(reason.clone())) {
                                    tracing::error!("[Scheduler] 更新任务阻塞状态失败 (JSON): {:?}", e);
                                }
                            }
                            tracing::warn!("[Scheduler] 检测到任务 {} 被阻塞: {}", task_name, reason);
                        } else {
                            if has_unified {
                                let storage = unified_storage.as_ref().unwrap();
                                let storage = storage.lock().await;
                                if let Err(e) = storage.update_blocked_status(&task_id, false, None) {
                                    tracing::error!("[Scheduler] 清除任务阻塞状态失败 (SQLite): {:?}", e);
                                }
                            } else {
                                let mut store = task_store.lock().await;
                                if let Err(e) = store.update_blocked_status(&task_id, false, None) {
                                    tracing::error!("[Scheduler] 清除任务阻塞状态失败 (JSON): {:?}", e);
                                }
                            }
                        }

                        if should_continue {
                            tracing::info!(
                                "[Scheduler] 任务 {} 满足连续执行条件，立即进入第 {} 轮",
                                task_name,
                                continuous_runs_for_complete + 1
                            );

                            {
                                let mut running = running_tasks.lock().await;
                                running.remove(&task_id);
                            }

                            let mut next_task = task_for_complete.clone();
                            next_task.conversation_session_id = final_session_id;

                            tokio::task::spawn_blocking(move || {
                                tauri::async_runtime::block_on(async move {
                                    if let Err(e) = dispatcher_for_complete
                                        .execute_task_with_continuation_count(next_task, continuous_runs_for_complete + 1)
                                        .await
                                    {
                                        tracing::error!("[Scheduler] 连续执行任务失败: {:?}", e);
                                    }
                                });
                            });
                            return;
                        }

                        if notify_on_complete {
                            if let Some(ref app_handle) = app_handle_for_notify {
                                let (title, body) = if is_success {
                                    ("任务执行成功".to_string(), format!("「{}」已完成", task_name))
                                } else {
                                    ("任务执行失败".to_string(), format!("「{}」执行失败", task_name))
                                };

                                if let Err(e) = app_handle.notification()
                                    .builder()
                                    .title(&title)
                                    .body(&body)
                                    .show()
                                {
                                    tracing::warn!("[Scheduler] 发送桌面通知失败: {:?}", e);
                                }
                            }
                        }

                        {
                            let mut running = running_tasks.lock().await;
                            running.remove(&task_id);
                        }
                    });
                })
            };

            let result = {
                let mut registry = engine_registry.lock().await;

                if let Some(existing_id) = existing_session_id.clone() {
                    tracing::info!("[Scheduler] 尝试复用会话: {} ({})", task_name, existing_id);
                    match registry.continue_session(engine_id_parsed.clone(), &existing_id, &prompt, build_options()) {
                        Ok(()) => Ok(existing_id),
                        Err(e) => {
                            tracing::warn!(
                                "[Scheduler] 会话复用失败，回退到新会话: {} - {}",
                                task_name,
                                SessionStrategyResolver::extract_resume_error_message(&e.to_string())
                            );
                            registry.start_session(Some(engine_id_parsed.clone()), &prompt, build_options())
                        }
                    }
                } else {
                    registry.start_session(Some(engine_id_parsed.clone()), &prompt, build_options())
                }
            };

            match result {
                Ok(session_id) => {
                    tracing::info!("[Scheduler] 会话已启动: {} (session: {})", task_name, session_id);

                    if reuse_session {
                        if has_unified {
                            let storage = unified_storage.as_ref().unwrap();
                            let storage = storage.lock().await;
                            if let Err(e) = storage.update_conversation_session_id(&task_id, Some(session_id.clone())) {
                                tracing::error!("[Scheduler] 写回任务会话 ID 失败 (SQLite): {:?}", e);
                            }
                        } else {
                            let mut store = task_store.lock().await;
                            if let Err(e) = store.update_conversation_session_id(&task_id, Some(session_id.clone())) {
                                tracing::error!("[Scheduler] 写回任务会话 ID 失败 (JSON): {:?}", e);
                            }
                        }
                    }

                    if let Some(timeout) = timeout_secs {
                        let session_id_for_timeout = session_id.clone();
                        let completed_for_timeout = completed.clone();
                        let task_store_for_timeout = task_store.clone();
                        let log_store_for_timeout = log_store.clone();
                        let unified_storage_for_timeout = unified_storage.clone();
                        let has_unified_for_timeout = has_unified;
                        let log_id_for_timeout = log_id_clone.clone();
                        let task_id_for_timeout = task_id.clone();
                        let task_name_for_timeout = task_name.clone();
                        let registry_for_timeout = engine_registry.clone();
                        let running_tasks_for_timeout = running_tasks.clone();
                        let app_handle_for_timeout = app_handle_for_timeout_main.clone();
                        let notify_for_timeout = notify_on_complete;

                        tokio::spawn(async move {
                            tokio::time::sleep(tokio::time::Duration::from_secs(timeout)).await;

                            if completed_for_timeout.load(Ordering::SeqCst) {
                                return;
                            }

                            tracing::warn!("[Scheduler] 任务 {} 执行超时 ({}秒)，正在终止...", task_name_for_timeout, timeout);

                            completed_for_timeout.store(true, Ordering::SeqCst);

                            {
                                let mut registry = registry_for_timeout.lock().await;
                                if !registry.try_interrupt_all(&session_id_for_timeout) {
                                    tracing::warn!("[Scheduler] 未能终止会话 {}", session_id_for_timeout);
                                }
                            }

                            let error_msg = format!("任务执行超时 ({}分钟)", timeout / 60);
                            if has_unified_for_timeout {
                                let storage = unified_storage_for_timeout.as_ref().unwrap();
                                let storage = storage.lock().await;

                                if let Err(e) = storage.update_log_complete(
                                    &log_id_for_timeout,
                                    Some(session_id_for_timeout.clone()),
                                    None,
                                    Some(error_msg.clone()),
                                    None,
                                    0,
                                    None,
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败 (SQLite): {:?}", e);
                                }

                                if let Err(e) = storage.update_run_status(&task_id_for_timeout, TaskStatus::Failed, false) {
                                    tracing::error!("[Scheduler] 更新任务状态失败 (SQLite): {:?}", e);
                                }
                            } else {
                                let mut log_store = log_store_for_timeout.lock().await;
                                let mut task_store = task_store_for_timeout.lock().await;

                                if let Err(e) = log_store.update_complete(
                                    &log_id_for_timeout,
                                    UpdateCompleteParams {
                                        session_id: Some(session_id_for_timeout.clone()),
                                        error: Some(error_msg.clone()),
                                        ..Default::default()
                                    },
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败 (JSON): {:?}", e);
                                }

                                if let Err(e) = task_store.update_run_status(&task_id_for_timeout, TaskStatus::Failed) {
                                    tracing::error!("[Scheduler] 更新任务状态失败 (JSON): {:?}", e);
                                }
                            }

                            if notify_for_timeout {
                                if let Some(ref app_handle) = app_handle_for_timeout {
                                    if let Err(e) = app_handle.notification()
                                        .builder()
                                        .title("任务执行超时")
                                        .body(format!("「{}」执行超时已被终止", task_name_for_timeout))
                                        .show()
                                    {
                                        tracing::warn!("[Scheduler] 发送超时通知失败: {:?}", e);
                                    }
                                }
                            }

                            {
                                let mut running = running_tasks_for_timeout.lock().await;
                                running.remove(&task_id_for_timeout);
                            }
                        });
                    }
                }
                Err(e) => {
                    tracing::error!("[Scheduler] 启动会话失败: {} - {:?}", task_name, e);

                    if has_unified {
                        let storage = unified_storage.as_ref().unwrap();
                        let storage = storage.lock().await;

                        if let Err(update_err) = storage.update_log_complete(
                            &log_id_clone,
                            None,
                            None,
                            Some(e.to_string()),
                            None,
                            0,
                            None,
                        ) {
                            tracing::error!("[Scheduler] 更新日志失败 (SQLite): {:?}", update_err);
                        }

                        if let Err(update_err) = storage.update_run_status(&task_id, TaskStatus::Failed, false) {
                            tracing::error!("[Scheduler] 更新任务状态失败 (SQLite): {:?}", update_err);
                        }
                    } else {
                        let mut log_store = log_store.lock().await;
                        let mut task_store = task_store.lock().await;

                        if let Err(update_err) = log_store.update_complete(
                            &log_id_clone,
                            UpdateCompleteParams {
                                error: Some(e.to_string()),
                                ..Default::default()
                            },
                        ) {
                            tracing::error!("[Scheduler] 更新日志失败 (JSON): {:?}", update_err);
                        }

                        if let Err(update_err) = task_store.update_run_status(&task_id, TaskStatus::Failed) {
                            tracing::error!("[Scheduler] 更新任务状态失败 (JSON): {:?}", update_err);
                        }
                    }

                    {
                        let mut running = running_tasks.lock().await;
                        running.remove(&task_id);
                    }
                }
            }
        });

        {
            let mut running = self.running_tasks.lock().await;
            running.insert(task_id_for_map, handle);
        }

        Ok(log_id)
    }


    /// 手动执行任务（返回日志 ID）
    pub async fn run_now(&self, task_id: &str) -> Result<RunTaskResult> {
        let task = {
            let store = self.task_store.lock().await;
            store.get(task_id)
                .cloned()
                .ok_or_else(|| crate::error::AppError::ValidationError(format!("任务不存在: {}", task_id)))?
        };

        // execute_task 内部会创建日志并返回 log_id
        let log_id = self.execute_task(task).await?;

        Ok(RunTaskResult {
            log_id,
            message: "任务已启动".to_string(),
        })
    }

    /// 手动执行任务并发送事件到前端窗口（用于订阅模式）
    ///
    /// 与 run_now 不同，此方法会实时发送 AI 事件到前端窗口，
    /// 让用户可以在 AI 对话窗口中看到执行过程。
    pub async fn run_now_with_window(
        &self,
        task_id: &str,
        window: Window,
        context_id: Option<String>,
    ) -> Result<RunTaskResult> {
        let task = {
            let store = self.task_store.lock().await;
            store.get(task_id)
                .cloned()
                .ok_or_else(|| crate::error::AppError::ValidationError(format!("任务不存在: {}", task_id)))?
        };

        let log_id = self.execute_task_with_window(task, window, context_id).await?;

        Ok(RunTaskResult {
            log_id,
            message: "任务已启动".to_string(),
        })
    }

    /// 执行任务并发送事件到窗口（用于订阅模式）
    async fn execute_task_with_window(
        &self,
        task: ScheduledTask,
        window: Window,
        context_id: Option<String>,
    ) -> Result<String> {
        self.execute_task_with_window_and_continuation_count(task, window, context_id, 1).await
    }

    async fn execute_task_with_window_and_continuation_count(
        &self,
        task: ScheduledTask,
        window: Window,
        context_id: Option<String>,
        continuous_runs: u32,
    ) -> Result<String> {
        let task_id = task.id.clone();
        let task_id_for_map = task.id.clone();
        let task_name = task.name.clone();
        let engine_id = task.engine_id.clone();
        let work_dir = task.work_dir.clone();
        let reuse_session = task.reuse_session;
        // 使用 SessionStrategyResolver 决定会话策略
        let existing_session_id = match SessionStrategyResolver::decide(&task) {
            super::session_strategy::SessionDecision::Continue { session_id } => Some(session_id),
            super::session_strategy::SessionDecision::StartNew => None,
        };
        let notify_on_complete = task.notify_on_complete;
        let timeout_secs = task.timeout_minutes.map(|m| m as u64 * 60);

        // 根据模式构建提示词（传递连续执行轮次）
        let prompt = self.build_prompt(&task, continuous_runs).await?;

        let task_store = self.task_store.clone();
        let log_store = self.log_store.clone();
        let engine_registry = self.engine_registry.clone();
        let running_tasks = self.running_tasks.clone();
        let dispatcher_for_continue = self.clone();

        let task_for_post = task.clone();

        let log_id = {
            let mut store = self.log_store.lock().await;
            let log = store.create(&task_id, &task_name, &prompt, &engine_id)?;
            tracing::info!("[Scheduler] 创建日志: {} for task: {}", log.id, task_name);
            log.id
        };

        {
            let mut store = self.task_store.lock().await;
            store.update_run_status(&task_id, TaskStatus::Running)?;
        }

        let ctx_id = context_id.clone();
        if let Err(e) = window.emit("scheduler-event", serde_json::json!({
            "contextId": ctx_id,
            "payload": {
                "type": "task_start",
                "taskId": task_id,
                "taskName": task_name,
                "logId": log_id,
            }
        })) {
            tracing::warn!("[Scheduler] 发送任务开始事件失败: {:?}", e);
        }

        let ctx_id_for_user_msg = context_id.clone();
        let user_msg = format!("🔄 定时任务「{}」开始执行", task_name);
        if let Err(e) = window.emit("chat-event", serde_json::json!({
            "contextId": ctx_id_for_user_msg.unwrap_or_else(|| "main".to_string()),
            "payload": {
                "type": "user_message",
                "content": user_msg,
            }
        })) {
            tracing::warn!("[Scheduler] 发送用户消息事件失败: {:?}", e);
        }

        let log_id_clone = log_id.clone();
        let window_clone = window.clone();
        let context_id_clone = context_id.clone();

        let handle = tokio::spawn(async move {
            tracing::info!("[Scheduler] 开始执行任务（订阅模式）: {} ({})", task_name, task_id);

            let engine_id_parsed = EngineId::from_str(&engine_id)
                .unwrap_or(EngineId::ClaudeCode);

            let output = Arc::new(AsyncMutex::new(String::new()));
            let thinking = Arc::new(AsyncMutex::new(String::new()));
            let session_id = Arc::new(AsyncMutex::new(existing_session_id.clone()));
            let session_id_for_update = session_id.clone();
            let tool_call_count = Arc::new(AsyncMutex::new(0u32));

            let completed = Arc::new(AtomicBool::new(false));
            let completed_clone = completed.clone();

            let output_clone = output.clone();
            let thinking_clone = thinking.clone();
            let session_id_clone = session_id.clone();
            let tool_call_count_clone = tool_call_count.clone();
            let window_for_event = window_clone.clone();
            let ctx_id_for_event = context_id_clone.clone();

            let log_id_for_complete = log_id_clone.clone();
            let task_id_for_complete = task_id.clone();
            let task_name_for_complete = task_name.clone();
            let task_store_for_complete = task_store.clone();
            let log_store_for_complete = log_store.clone();
            let output_for_complete = output.clone();
            let thinking_for_complete = thinking.clone();
            let session_id_for_complete = session_id.clone();
            let tool_call_count_for_complete = tool_call_count.clone();
            let running_tasks_for_complete = running_tasks.clone();
            let task_for_complete = task_for_post.clone();
            let window_for_complete = window_clone.clone();
            let ctx_id_for_complete = context_id_clone.clone();
            let dispatcher_for_complete = dispatcher_for_continue.clone();
            let continuous_runs_for_complete = continuous_runs;

            let build_options = || {
                let output_clone = output_clone.clone();
                let thinking_clone = thinking_clone.clone();
                let session_id_clone = session_id_clone.clone();
                let tool_call_count_clone = tool_call_count_clone.clone();
                let window_for_event = window_for_event.clone();
                let ctx_id_for_event = ctx_id_for_event.clone();
                let session_id_for_update = session_id_for_update.clone();
                let completed_clone = completed_clone.clone();
                let log_id_for_complete = log_id_for_complete.clone();
                let task_id_for_complete = task_id_for_complete.clone();
                let task_name_for_complete = task_name_for_complete.clone();
                let task_store_for_complete = task_store_for_complete.clone();
                let log_store_for_complete = log_store_for_complete.clone();
                let output_for_complete = output_for_complete.clone();
                let thinking_for_complete = thinking_for_complete.clone();
                let session_id_for_complete = session_id_for_complete.clone();
                let tool_call_count_for_complete = tool_call_count_for_complete.clone();
                let running_tasks_for_complete = running_tasks_for_complete.clone();
                let task_for_complete = task_for_complete.clone();
                let window_for_complete = window_for_complete.clone();
                let ctx_id_for_complete = ctx_id_for_complete.clone();
                let dispatcher_for_complete = dispatcher_for_complete.clone();

                SessionOptions::new(move |event: AIEvent| {
                    let event_json = if let Some(ref cid) = ctx_id_for_event {
                        serde_json::json!({ "contextId": cid, "payload": event })
                    } else {
                        serde_json::json!({ "contextId": "main", "payload": event })
                    };

                    if let Err(e) = window_for_event.emit("chat-event", &event_json) {
                        tracing::debug!("[Scheduler] 发送事件失败: {:?}", e);
                    }

                    match &event {
                        AIEvent::AssistantMessage(msg) => {
                            if let Ok(mut o) = output_clone.try_lock() {
                                o.push_str(&msg.content);
                            }
                        }
                        AIEvent::Thinking(t) => {
                            if let Ok(mut th) = thinking_clone.try_lock() {
                                th.push_str(&t.content);
                                th.push('\n');
                            }
                        }
                        AIEvent::ToolCallStart(_) => {
                            if let Ok(mut count) = tool_call_count_clone.try_lock() {
                                *count += 1;
                            }
                        }
                        AIEvent::SessionStart(s) => {
                            if let Ok(mut sid) = session_id_clone.try_lock() {
                                *sid = Some(s.session_id.clone());
                            }
                        }
                        _ => {}
                    }
                })
                .with_work_dir(work_dir.clone().unwrap_or_else(|| ".".to_string()))
                .with_on_session_id_update(move |sid: String| {
                    if let Ok(mut s) = session_id_for_update.try_lock() {
                        *s = Some(sid);
                    }
                })
                .with_on_complete(move |exit_code: i32| {
                    if completed_clone.swap(true, Ordering::SeqCst) {
                        return;
                    }

                    tracing::info!("[Scheduler] 会话完成，exit_code: {}", exit_code);

                    let log_id = log_id_for_complete.clone();
                    let task_id = task_id_for_complete.clone();
                    let task_name = task_name_for_complete.clone();
                    let task_store = task_store_for_complete.clone();
                    let log_store = log_store_for_complete.clone();
                    let output = output_for_complete.clone();
                    let thinking = thinking_for_complete.clone();
                    let session_id = session_id_for_complete.clone();
                    let tool_call_count = tool_call_count_for_complete.clone();
                    let running_tasks = running_tasks_for_complete.clone();
                    let window = window_for_complete.clone();
                    let ctx_id = ctx_id_for_complete.clone();
                    let task_for_complete = task_for_complete.clone();
                    let dispatcher_for_complete = dispatcher_for_complete.clone();

                    let task_work_dir_for_complete = task_for_complete.work_dir.clone();
                    let task_task_path_for_complete = task_for_complete.task_path.clone();

                    tauri::async_runtime::spawn(async move {
                        let final_output = output.lock().await.clone();
                        let final_thinking = thinking.lock().await.clone();
                        let final_session_id = session_id.lock().await.clone();
                        let final_tool_count = *tool_call_count.lock().await;
                        let run_summary = SchedulerDispatcher::summarize_run_output(&final_output);
                        let pending_summary = if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                            SchedulerDispatcher::summarize_pending_tasks(work_dir, task_path)
                        } else {
                            "非协议任务，无待办摘要".to_string()
                        };

                        // 使用结构化执行结果分析器
                        let execution_outcome = ExecutionResultAnalyzer::analyze(
                            exit_code,
                            &final_output,
                            final_tool_count,
                            task_work_dir_for_complete.as_deref(),
                            task_task_path_for_complete.as_deref(),
                        );

                        let is_success = matches!(
                            &execution_outcome,
                            ExecutionOutcome::SuccessWithProgress | ExecutionOutcome::SuccessNoProgress | ExecutionOutcome::PartialSuccess
                        );

                        // 检测阻塞状态和当前阶段（协议任务）
                        let detected_blocked = if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                            ExecutionResultAnalyzer::detect_blocked(work_dir, task_path)
                        } else {
                            None
                        };
                        let detected_phase = if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                            ExecutionResultAnalyzer::extract_current_phase(work_dir, task_path)
                        } else {
                            None
                        };

                        // 判断是否应继续执行（带无增量检测）
                        let should_continue = is_success
                            && !ExecutionResultAnalyzer::should_stop_continuation_with_increment_check(
                                &execution_outcome,
                                task_work_dir_for_complete.as_deref(),
                                task_task_path_for_complete.as_deref(),
                                Some(&run_summary),
                                None, // 使用默认相似度阈值 0.7
                            )
                            && ContinuationDecider::should_continue(&task_for_complete, continuous_runs_for_complete);

                        {
                            let mut log_store = log_store.lock().await;
                            let mut task_store = task_store.lock().await;

                            if is_success {
                                if let Err(e) = log_store.update_complete(
                                    &log_id,
                                    UpdateCompleteParams {
                                        session_id: final_session_id.clone(),
                                        output: Some(final_output),
                                        thinking_summary: if final_thinking.is_empty() { None } else { Some(final_thinking) },
                                        tool_call_count: final_tool_count,
                                        ..Default::default()
                                    },
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败: {:?}", e);
                                }

                                if let Err(e) = task_store.update_run_status(&task_id, TaskStatus::Success) {
                                    tracing::error!("[Scheduler] 更新任务状态失败: {:?}", e);
                                }

                                if task_for_complete.reuse_session {
                                    if let Err(e) = task_store.update_conversation_session_id(&task_id, final_session_id.clone()) {
                                        tracing::error!("[Scheduler] 更新任务会话 ID 失败: {:?}", e);
                                    }
                                }

                                if let Err(e) = task_store.update_last_run_outcome(&task_id, execution_outcome.clone()) {
                                    tracing::error!("[Scheduler] 更新任务执行结果类型失败: {:?}", e);
                                }

                                if let Err(e) = task_store.reset_retry_count(&task_id) {
                                    tracing::error!("[Scheduler] 重置重试计数失败: {:?}", e);
                                }

                                // 更新最近有效进展时间
                                if matches!(&execution_outcome, ExecutionOutcome::SuccessWithProgress) {
                                    if let Err(e) = task_store.update_last_effective_progress(&task_id) {
                                        tracing::error!("[Scheduler] 更新有效进展时间失败: {:?}", e);
                                    }
                                }

                                tracing::info!("[Scheduler] 任务执行成功: {} (结果: {:?})", task_name, execution_outcome);

                                if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                                    let run_number = task_store.get(&task_id)
                                        .map(|task| task.current_runs)
                                        .unwrap_or(0);

                                    if let Err(e) = ProtocolTaskService::append_memory_run(
                                        work_dir,
                                        task_path,
                                        run_number,
                                        final_session_id.as_deref(),
                                        &run_summary,
                                        &pending_summary,
                                        should_continue,
                                        Some(&execution_outcome),
                                    ) {
                                        tracing::error!("[Scheduler] 追加执行轮次记录失败: {:?}", e);
                                    }
                                }

                                if let (Some(work_dir), Some(task_path)) = (&task_work_dir_for_complete, &task_task_path_for_complete) {
                                    if let Ok(supplement) = ProtocolTaskService::read_supplement_md(work_dir, task_path) {
                                        if ProtocolTaskService::has_supplement_content(&supplement) {
                                            let content = ProtocolTaskService::extract_user_content(&supplement);

                                            if let Err(e) = ProtocolTaskService::backup_supplement(work_dir, task_path, &content) {
                                                tracing::error!("[Scheduler] 备份用户补充失败: {:?}", e);
                                            }

                                            if let Err(e) = ProtocolTaskService::clear_supplement_md(work_dir, task_path) {
                                                tracing::error!("[Scheduler] 清空用户补充文档失败: {:?}", e);
                                            }
                                        }
                                    }
                                }
                            } else {
                                let error_msg = match &execution_outcome {
                                    ExecutionOutcome::Blocked(reason) => format!("任务被阻塞: {}", reason),
                                    ExecutionOutcome::Failed => format!("进程退出码: {}", exit_code),
                                    _ => format!("执行结果: {:?}", execution_outcome),
                                };
                                if let Err(e) = log_store.update_complete(
                                    &log_id,
                                    UpdateCompleteParams {
                                        session_id: final_session_id.clone(),
                                        output: Some(final_output),
                                        error: Some(error_msg.clone()),
                                        thinking_summary: if final_thinking.is_empty() { None } else { Some(final_thinking) },
                                        tool_call_count: final_tool_count,
                                        ..Default::default()
                                    },
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败: {:?}", e);
                                }

                                let can_retry = task_store.update_retry_status(&task_id).unwrap_or(false);

                                if can_retry {
                                    tracing::info!("[Scheduler] 任务 {} 失败，将自动重试", task_name);
                                } else {
                                    if let Err(e) = task_store.update_run_status(&task_id, TaskStatus::Failed) {
                                        tracing::error!("[Scheduler] 更新任务状态失败: {:?}", e);
                                    }
                                    // 更新任务执行结果类型
                                    if let Err(e) = task_store.update_last_run_outcome(&task_id, execution_outcome.clone()) {
                                        tracing::error!("[Scheduler] 更新任务执行结果类型失败: {:?}", e);
                                    }

                                    tracing::error!("[Scheduler] 任务执行失败: {} - {}", task_name, error_msg);
                                }
                            }
                        }

                        // 更新任务的阻塞状态和当前阶段
                        if let Some(ref phase) = detected_phase {
                            let mut store = task_store.lock().await;
                            if let Err(e) = store.update_current_phase(&task_id, phase) {
                                tracing::error!("[Scheduler] 更新任务阶段失败: {:?}", e);
                            }
                        }
                        if let Some(ref reason) = detected_blocked {
                            let mut store = task_store.lock().await;
                            if let Err(e) = store.update_blocked_status(&task_id, true, Some(reason.clone())) {
                                tracing::error!("[Scheduler] 更新任务阻塞状态失败: {:?}", e);
                            }
                            tracing::warn!("[Scheduler] 检测到任务 {} 被阻塞: {}", task_name, reason);
                        } else {
                            let mut store = task_store.lock().await;
                            if let Err(e) = store.update_blocked_status(&task_id, false, None) {
                                tracing::error!("[Scheduler] 清除任务阻塞状态失败: {:?}", e);
                            }
                        }

                        if should_continue {
                            tracing::info!(
                                "[Scheduler] 任务 {} 满足连续执行条件（订阅模式），立即进入第 {} 轮",
                                task_name,
                                continuous_runs_for_complete + 1
                            );

                            {
                                let mut running = running_tasks.lock().await;
                                running.remove(&task_id);
                            }

                            let mut next_task = task_for_complete.clone();
                            next_task.conversation_session_id = final_session_id;

                            tokio::task::spawn_blocking(move || {
                                tauri::async_runtime::block_on(async move {
                                    if let Err(e) = dispatcher_for_complete
                                        .execute_task_with_window_and_continuation_count(
                                            next_task,
                                            window.clone(),
                                            ctx_id.clone(),
                                            continuous_runs_for_complete + 1,
                                        )
                                        .await
                                    {
                                        tracing::error!("[Scheduler] 连续执行任务失败（订阅模式）: {:?}", e);
                                    }
                                });
                            });
                            return;
                        }

                        if notify_on_complete {
                            let (title, body) = if is_success {
                                ("任务执行成功".to_string(), format!("「{}」已完成", task_name))
                            } else {
                                ("任务执行失败".to_string(), format!("「{}」执行失败", task_name))
                            };

                            if let Err(e) = window.notification()
                                .builder()
                                .title(&title)
                                .body(&body)
                                .show()
                            {
                                tracing::warn!("[Scheduler] 发送桌面通知失败: {:?}", e);
                            }
                        }

                        let _ = window.emit("scheduler-event", serde_json::json!({
                            "contextId": ctx_id,
                            "payload": {
                                "type": "task_end",
                                "taskId": task_id,
                                "taskName": task_name,
                                "logId": log_id,
                                "success": is_success,
                            }
                        }));

                        {
                            let mut running = running_tasks.lock().await;
                            running.remove(&task_id);
                        }
                    });
                })
            };

            let result = {
                let mut registry = engine_registry.lock().await;

                if let Some(existing_id) = existing_session_id.clone() {
                    tracing::info!("[Scheduler] 尝试复用会话（订阅模式）: {} ({})", task_name, existing_id);
                    match registry.continue_session(engine_id_parsed.clone(), &existing_id, &prompt, build_options()) {
                        Ok(()) => Ok(existing_id),
                        Err(e) => {
                            tracing::warn!(
                                "[Scheduler] 会话复用失败（订阅模式），回退到新会话: {} - {}",
                                task_name,
                                SessionStrategyResolver::extract_resume_error_message(&e.to_string())
                            );
                            registry.start_session(Some(engine_id_parsed.clone()), &prompt, build_options())
                        }
                    }
                } else {
                    registry.start_session(Some(engine_id_parsed.clone()), &prompt, build_options())
                }
            };

            match result {
                Ok(session_id) => {
                    tracing::info!("[Scheduler] 会话已启动（订阅模式）: {} (session: {})", task_name, session_id);

                    if reuse_session {
                        let mut store = task_store.lock().await;
                        if let Err(e) = store.update_conversation_session_id(&task_id, Some(session_id.clone())) {
                            tracing::error!("[Scheduler] 写回任务会话 ID 失败: {:?}", e);
                        }
                    }

                    if let Some(timeout) = timeout_secs {
                        let session_id_for_timeout = session_id.clone();
                        let completed_for_timeout = completed.clone();
                        let task_store_for_timeout = task_store.clone();
                        let log_store_for_timeout = log_store.clone();
                        let log_id_for_timeout = log_id_clone.clone();
                        let task_id_for_timeout = task_id.clone();
                        let task_name_for_timeout = task_name.clone();
                        let registry_for_timeout = engine_registry.clone();
                        let running_tasks_for_timeout = running_tasks.clone();
                        let window_for_timeout = window_clone.clone();
                        let ctx_id_for_timeout = context_id_clone.clone();
                        let notify_for_timeout = notify_on_complete;

                        tokio::spawn(async move {
                            tokio::time::sleep(tokio::time::Duration::from_secs(timeout)).await;

                            if completed_for_timeout.load(Ordering::SeqCst) {
                                return;
                            }

                            tracing::warn!("[Scheduler] 任务 {} 执行超时 ({}秒)，正在终止...", task_name_for_timeout, timeout);

                            completed_for_timeout.store(true, Ordering::SeqCst);

                            {
                                let mut registry = registry_for_timeout.lock().await;
                                if !registry.try_interrupt_all(&session_id_for_timeout) {
                                    tracing::warn!("[Scheduler] 未能终止会话 {}", session_id_for_timeout);
                                }
                            }

                            {
                                let mut log_store = log_store_for_timeout.lock().await;
                                let mut task_store = task_store_for_timeout.lock().await;

                                let error_msg = format!("任务执行超时 ({}分钟)", timeout / 60);
                                if let Err(e) = log_store.update_complete(
                                    &log_id_for_timeout,
                                    UpdateCompleteParams {
                                        session_id: Some(session_id_for_timeout),
                                        error: Some(error_msg.clone()),
                                        ..Default::default()
                                    },
                                ) {
                                    tracing::error!("[Scheduler] 更新日志失败: {:?}", e);
                                }

                                if let Err(e) = task_store.update_run_status(&task_id_for_timeout, TaskStatus::Failed) {
                                    tracing::error!("[Scheduler] 更新任务状态失败: {:?}", e);
                                }
                            }

                            let _ = window_for_timeout.emit("scheduler-event", serde_json::json!({
                                "contextId": ctx_id_for_timeout,
                                "payload": {
                                    "type": "task_timeout",
                                    "taskId": task_id_for_timeout,
                                    "taskName": task_name_for_timeout,
                                    "logId": log_id_for_timeout,
                                }
                            }));

                            if notify_for_timeout {
                                if let Err(e) = window_for_timeout.notification()
                                    .builder()
                                    .title("任务执行超时")
                                    .body(format!("「{}」执行超时已被终止", task_name_for_timeout))
                                    .show()
                                {
                                    tracing::warn!("[Scheduler] 发送超时通知失败: {:?}", e);
                                }
                            }

                            {
                                let mut running = running_tasks_for_timeout.lock().await;
                                running.remove(&task_id_for_timeout);
                            }
                        });
                    }
                }
                Err(e) => {
                    tracing::error!("[Scheduler] 启动会话失败: {} - {:?}", task_name, e);

                    let mut log_store = log_store.lock().await;
                    let mut task_store = task_store.lock().await;

                    if let Err(update_err) = log_store.update_complete(
                        &log_id_clone,
                        UpdateCompleteParams {
                            error: Some(e.to_string()),
                            ..Default::default()
                        },
                    ) {
                        tracing::error!("[Scheduler] 更新日志失败: {:?}", update_err);
                    }

                    if let Err(update_err) = task_store.update_run_status(&task_id, TaskStatus::Failed) {
                        tracing::error!("[Scheduler] 更新任务状态失败: {:?}", update_err);
                    }

                    {
                        let mut running = running_tasks.lock().await;
                        running.remove(&task_id);
                    }
                }
            }
        });

        {
            let mut running = self.running_tasks.lock().await;
            running.insert(task_id_for_map, handle);
        }

        Ok(log_id)
    }

    fn summarize_run_output(output: &str) -> String {
        let summary = output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .find(|line| !line.starts_with('#') && !line.starts_with('>'))
            .unwrap_or("本轮执行已完成，待补充成果摘要");

        summary.chars().take(160).collect()
    }

    fn summarize_pending_tasks(work_dir: &str, task_path: &str) -> String {
        let content = match ProtocolTaskService::read_memory_tasks(work_dir, task_path) {
            Ok(content) => content,
            Err(_) => return "待读取 memory/tasks.md 确认后续事项".to_string(),
        };

        let mut in_pending = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("## ") {
                in_pending = trimmed == "## 待办";
                continue;
            }

            if !in_pending || trimmed.is_empty() {
                continue;
            }

            let normalized = trimmed
                .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '-' || c.is_whitespace())
                .trim();
            if !normalized.is_empty() {
                return normalized.chars().take(160).collect();
            }
        }

        "待结合 memory/index.md 与 tasks.md 决定下一步".to_string()
    }

    /// 构建提示词（协议模式：读取 task.md + memory + supplement）
    ///
    /// # Arguments
    /// * `task` - 任务定义
    /// * `continuous_runs` - 当前连续执行轮次（1 表示首次执行，>1 表示续跑）
    async fn build_prompt(&self, task: &ScheduledTask, continuous_runs: u32) -> Result<String> {
        tracing::info!(
            "[Scheduler] 构建提示词: work_dir={:?}, task_path={:?}, continuous_runs={}",
            task.work_dir, task.task_path, continuous_runs
        );

        let work_dir = task.work_dir.as_ref()
            .ok_or_else(|| crate::error::AppError::ValidationError("协议模式需要指定工作目录".to_string()))?;
        let task_path = task.task_path.as_ref()
            .ok_or_else(|| crate::error::AppError::ValidationError("协议模式需要任务路径".to_string()))?;

        // 判断是首次执行还是续跑
        let (prompt_type, previous_summary) = if continuous_runs > 1 {
            // 续跑模式：读取上轮摘要
            let summary = ProtocolTaskService::get_latest_run_summary(work_dir, task_path);
            tracing::info!(
                "[Scheduler] 续跑模式，上轮摘要: {:?}",
                summary.as_ref().map(|s| s.chars().take(100).collect::<String>())
            );
            (PromptType::Continuation, summary)
        } else {
            // 首次执行
            (PromptType::Initial, None)
        };

        PromptBuilder::build(work_dir, task_path, prompt_type, previous_summary.as_deref())
    }

    /// 处理用户补充文档（执行成功后调用）
    #[allow(dead_code)]
    async fn handle_supplement_post_execution(&self, task: &ScheduledTask) {
        let work_dir = match &task.work_dir {
            Some(w) => w,
            None => return,
        };
        let task_path = match &task.task_path {
            Some(p) => p,
            None => return,
        };

        // 读取用户补充
        let supplement = match ProtocolTaskService::read_supplement_md(work_dir, task_path) {
            Ok(s) => s,
            Err(_) => return,
        };

        // 检查是否有内容
        if !ProtocolTaskService::has_supplement_content(&supplement) {
            return;
        }

        let content = ProtocolTaskService::extract_user_content(&supplement);

        // 备份内容
        if let Err(e) = ProtocolTaskService::backup_supplement(work_dir, task_path, &content) {
            tracing::error!("[Scheduler] 备份用户补充失败: {:?}", e);
        }

        // 清空原文档
        if let Err(e) = ProtocolTaskService::clear_supplement_md(work_dir, task_path) {
            tracing::error!("[Scheduler] 清空用户补充文档失败: {:?}", e);
        }

        tracing::info!("[Scheduler] 已处理用户补充文档");
    }

    /// 检查文档是否需要备份（超过 800 行）
    #[allow(dead_code)]
    async fn check_and_backup_documents(&self, task: &ScheduledTask) {
        let work_dir = match &task.work_dir {
            Some(w) => w,
            None => return,
        };
        let task_path = match &task.task_path {
            Some(p) => p,
            None => return,
        };

        // 检查 task.md
        if let Ok(content) = ProtocolTaskService::read_task_md(work_dir, task_path) {
            if ProtocolTaskService::needs_backup(&content) {
                tracing::info!("[Scheduler] 协议文档超过 800 行，建议进行总结备份");
                // 注意：这里不自动备份，让 AI 在执行时自行决定是否总结
            }
        }

        // 检查 memory/index.md
        if let Ok(content) = ProtocolTaskService::read_memory_index(work_dir, task_path) {
            if ProtocolTaskService::needs_backup(&content) {
                tracing::info!("[Scheduler] 记忆索引超过 800 行，建议进行总结备份");
            }
        }
    }
}
