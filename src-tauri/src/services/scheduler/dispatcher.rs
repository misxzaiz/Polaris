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
    task_store: Arc<AsyncMutex<TaskStoreService>>,
    log_store: Arc<AsyncMutex<LogStoreService>>,
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
            engine_registry,
            running_tasks: Arc::new(AsyncMutex::new(HashMap::new())),
            cancel_token: Arc::new(AsyncMutex::new(None)),
            app_handle: None,
        }
    }

    /// 设置 AppHandle
    pub fn with_app_handle(mut self, handle: AppHandle) -> Self {
        self.app_handle = Some(handle);
        self
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
        let pending_tasks: Vec<ScheduledTask> = {
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
        let task_id = task.id.clone();
        let task_id_for_map = task.id.clone();
        let task_name = task.name.clone();
        let engine_id = task.engine_id.clone();
        let work_dir = task.work_dir.clone();
        // 克隆 app_handle 用于通知
        let app_handle_for_notify = self.app_handle.clone();
        let notify_on_complete = task.notify_on_complete;
        // 获取超时配置（分钟转秒）
        let timeout_secs = task.timeout_minutes.map(|m| m as u64 * 60);

        // 根据模式构建提示词
        let prompt = self.build_prompt(&task).await?;

        let task_store = self.task_store.clone();
        let log_store = self.log_store.clone();
        let engine_registry = self.engine_registry.clone();
        let running_tasks = self.running_tasks.clone();

        // 用于后续处理用户补充
        let task_for_post = task.clone();

        // 创建日志记录（状态为 Running）
        let log_id = {
            let mut store = self.log_store.lock().await;
            let log = store.create(&task_id, &task_name, &prompt, &engine_id)?;
            tracing::info!("[Scheduler] 创建日志: {} for task: {}", log.id, task_name);
            log.id
        };

        // 标记任务开始执行
        {
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
            let session_id = Arc::new(AsyncMutex::new(None::<String>));
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
            let output_for_complete = output.clone();
            let thinking_for_complete = thinking.clone();
            let session_id_for_complete = session_id.clone();
            let tool_call_count_for_complete = tool_call_count.clone();
            let running_tasks_for_complete = running_tasks.clone();
            let task_for_complete = task_for_post.clone();
            // 克隆 app_handle 给完成回调和超时监控分别使用
            let app_handle_for_complete = app_handle_for_notify.clone();
            let app_handle_for_timeout_main = app_handle_for_notify.clone();

            // 创建会话选项
            let options = SessionOptions::new(move |event: AIEvent| {
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
            .with_work_dir(work_dir.unwrap_or_else(|| ".".to_string()))
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

                // 在新的 tokio 任务中处理完成逻辑（因为回调在非异步上下文中）
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

                // 克隆协议任务相关字段（避免在 Fn 闭包中移动）
                let task_work_dir_for_complete = task_for_complete.work_dir.clone();
                let task_task_path_for_complete = task_for_complete.task_path.clone();
                // clone app_handle 以便在 async 块中使用
                let app_handle_for_notify = app_handle_for_complete.clone();

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

                    // 判断是否成功
                    let is_success = exit_code == 0;

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

                            // 成功后重置重试计数
                            if let Err(e) = task_store.reset_retry_count(&task_id) {
                                tracing::error!("[Scheduler] 重置重试计数失败: {:?}", e);
                            }

                            tracing::info!("[Scheduler] 任务执行成功: {}", task_name);

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
                                    false,
                                ) {
                                    tracing::error!("[Scheduler] 追加执行轮次记录失败: {:?}", e);
                                }
                            }

                            // 处理用户补充文档
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
                            let error_msg = format!("进程退出码: {}", exit_code);
                            if let Err(e) = log_store.update_complete(
                                &log_id,
                                UpdateCompleteParams {
                                    session_id: final_session_id,
                                    output: Some(final_output),
                                    error: Some(error_msg.clone()),
                                    thinking_summary: if final_thinking.is_empty() { None } else { Some(final_thinking) },
                                    tool_call_count: final_tool_count,
                                    ..Default::default()
                                },
                            ) {
                                tracing::error!("[Scheduler] 更新日志失败: {:?}", e);
                            }

                            // 检查是否可以重试
                            let can_retry = task_store.update_retry_status(&task_id).unwrap_or(false);

                            if can_retry {
                                tracing::info!("[Scheduler] 任务 {} 失败，将自动重试", task_name);
                                // 不更新状态为 Failed，保持 Running 以便下次执行
                            } else {
                                // 不能重试，标记为失败
                                if let Err(e) = task_store.update_run_status(&task_id, TaskStatus::Failed) {
                                    tracing::error!("[Scheduler] 更新任务状态失败: {:?}", e);
                                }
                                tracing::error!("[Scheduler] 任务执行失败: {} - {}", task_name, error_msg);
                            }
                        }
                    }

                    // 发送桌面通知
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

                    // 从运行列表中移除
                    {
                        let mut running = running_tasks.lock().await;
                        running.remove(&task_id);
                    }
                });
            });

            // 执行
            let result = {
                let mut registry = engine_registry.lock().await;
                registry.start_session(Some(engine_id_parsed), &prompt, options)
            };

            match result {
                Ok(session_id) => {
                    tracing::info!("[Scheduler] 会话已启动: {} (session: {})", task_name, session_id);
                    
                    // 如果设置了超时，启动超时监控任务
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
                        let app_handle_for_timeout = app_handle_for_timeout_main.clone();
                        let notify_for_timeout = notify_on_complete;
                        
                        tokio::spawn(async move {
                            tokio::time::sleep(tokio::time::Duration::from_secs(timeout)).await;
                            
                            // 检查是否已完成
                            if completed_for_timeout.load(Ordering::SeqCst) {
                                return;
                            }
                            
                            tracing::warn!("[Scheduler] 任务 {} 执行超时 ({}秒)，正在终止...", task_name_for_timeout, timeout);
                            
                            // 标记为已完成（防止 on_complete 回调再次处理）
                            completed_for_timeout.store(true, Ordering::SeqCst);
                            
                            // 终止会话进程
                            {
                                let mut registry = registry_for_timeout.lock().await;
                                if !registry.try_interrupt_all(&session_id_for_timeout) {
                                    tracing::warn!("[Scheduler] 未能终止会话 {}", session_id_for_timeout);
                                }
                            }

                            // 更新日志和任务状态
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

                            // 发送桌面通知
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

                            // 从运行列表中移除
                            {
                                let mut running = running_tasks_for_timeout.lock().await;
                                running.remove(&task_id_for_timeout);
                            }
                        });
                    }
                }
                Err(e) => {
                    tracing::error!("[Scheduler] 启动会话失败: {} - {:?}", task_name, e);

                    // 启动失败，更新状态
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

                    // 从运行列表中移除
                    {
                        let mut running = running_tasks.lock().await;
                        running.remove(&task_id);
                    }
                }
            }
        });

        // 添加到运行列表
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
        let task_id = task.id.clone();
        let task_id_for_map = task.id.clone();
        let task_name = task.name.clone();
        let engine_id = task.engine_id.clone();
        let work_dir = task.work_dir.clone();
        // 获取超时配置（分钟转秒）
        let timeout_secs = task.timeout_minutes.map(|m| m as u64 * 60);

        // 根据模式构建提示词
        let prompt = self.build_prompt(&task).await?;

        let task_store = self.task_store.clone();
        let log_store = self.log_store.clone();
        let engine_registry = self.engine_registry.clone();
        let running_tasks = self.running_tasks.clone();

        // 用于后续处理用户补充
        let task_for_post = task.clone();

        // 创建日志记录（状态为 Running）
        let log_id = {
            let mut store = self.log_store.lock().await;
            let log = store.create(&task_id, &task_name, &prompt, &engine_id)?;
            tracing::info!("[Scheduler] 创建日志: {} for task: {}", log.id, task_name);
            log.id
        };

        // 标记任务开始执行
        {
            let mut store = self.task_store.lock().await;
            store.update_run_status(&task_id, TaskStatus::Running)?;
        }

        // 发送任务开始事件到前端
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

        // 发送用户消息事件，显示任务执行提示（让用户在对话窗口看到任务开始）
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

            // 解析引擎 ID
            let engine_id_parsed = EngineId::from_str(&engine_id)
                .unwrap_or(EngineId::ClaudeCode);

            // 收集输出、思考过程、工具调用、session_id
            let output = Arc::new(AsyncMutex::new(String::new()));
            let thinking = Arc::new(AsyncMutex::new(String::new()));
            let session_id = Arc::new(AsyncMutex::new(None::<String>));
            let session_id_for_update = session_id.clone();
            let tool_call_count = Arc::new(AsyncMutex::new(0u32));

            // 用于标记是否已更新完成状态
            let completed = Arc::new(AtomicBool::new(false));
            let completed_clone = completed.clone();

            let output_clone = output.clone();
            let thinking_clone = thinking.clone();
            let session_id_clone = session_id.clone();
            let tool_call_count_clone = tool_call_count.clone();
            let window_for_event = window_clone.clone();
            let ctx_id_for_event = context_id_clone.clone();

            // 完成回调的闭包所需变量
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
            let notify_on_complete = task.notify_on_complete;

            // 创建会话选项 - 实时发送事件到前端
            let options = SessionOptions::new(move |event: AIEvent| {
                // 发送事件到前端窗口
                // 默认使用 'main' contextId，这样事件会自动在 AI 对话窗口显示
                let event_json = if let Some(ref cid) = ctx_id_for_event {
                    serde_json::json!({ "contextId": cid, "payload": event })
                } else {
                    serde_json::json!({ "contextId": "main", "payload": event })
                };

                if let Err(e) = window_for_event.emit("chat-event", &event_json) {
                    tracing::debug!("[Scheduler] 发送事件失败: {:?}", e);
                }

                // 同时收集到内部变量
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
            .with_work_dir(work_dir.unwrap_or_else(|| ".".to_string()))
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

                // 在新的 tokio 任务中处理完成逻辑
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

                // 克隆协议任务相关字段
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

                    // 判断是否成功
                    let is_success = exit_code == 0;

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

                            // 成功后重置重试计数
                            if let Err(e) = task_store.reset_retry_count(&task_id) {
                                tracing::error!("[Scheduler] 重置重试计数失败: {:?}", e);
                            }

                            tracing::info!("[Scheduler] 任务执行成功: {}", task_name);

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
                                    false,
                                ) {
                                    tracing::error!("[Scheduler] 追加执行轮次记录失败: {:?}", e);
                                }
                            }

                            // 处理用户补充文档
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
                                                        let error_msg = format!("进程退出码: {}", exit_code);
                                                        if let Err(e) = log_store.update_complete(
                                                            &log_id,
                                                            UpdateCompleteParams {
                                                                session_id: final_session_id,
                                                                output: Some(final_output),
                                                                error: Some(error_msg.clone()),
                                                                thinking_summary: if final_thinking.is_empty() { None } else { Some(final_thinking) },
                                                                tool_call_count: final_tool_count,
                                                                ..Default::default()
                                                            },
                                                        ) {
                                                            tracing::error!("[Scheduler] 更新日志失败: {:?}", e);
                                                        }

                                                        // 检查是否可以重试
                                                        let can_retry = task_store.update_retry_status(&task_id).unwrap_or(false);

                                                        if can_retry {
                                                            tracing::info!("[Scheduler] 任务 {} 失败，将自动重试", task_name);
                                                            // 不更新状态为 Failed
                                                        } else {
                                                            // 不能重试，标记为失败
                                                            if let Err(e) = task_store.update_run_status(&task_id, TaskStatus::Failed) {
                                                                tracing::error!("[Scheduler] 更新任务状态失败: {:?}", e);
                                                            }
                                                            tracing::error!("[Scheduler] 任务执行失败: {} - {}", task_name, error_msg);
                                                        }
                                                    }
                                                }

                    // 发送桌面通知
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

                    // 发送任务完成事件到前端
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

                    // 从运行列表中移除
                    {
                        let mut running = running_tasks.lock().await;
                        running.remove(&task_id);
                    }
                });
            });

            // 执行
            let result = {
                let mut registry = engine_registry.lock().await;
                registry.start_session(Some(engine_id_parsed), &prompt, options)
            };

            match result {
                Ok(session_id) => {
                    tracing::info!("[Scheduler] 会话已启动（订阅模式）: {} (session: {})", task_name, session_id);
                    
                    // 如果设置了超时，启动超时监控任务
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
                            
                            // 检查是否已完成
                            if completed_for_timeout.load(Ordering::SeqCst) {
                                return;
                            }
                            
                            tracing::warn!("[Scheduler] 任务 {} 执行超时 ({}秒)，正在终止...", task_name_for_timeout, timeout);
                            
                            // 标记为已完成（防止 on_complete 回调再次处理）
                            completed_for_timeout.store(true, Ordering::SeqCst);
                            
                            // 终止会话进程
                            {
                                let mut registry = registry_for_timeout.lock().await;
                                if !registry.try_interrupt_all(&session_id_for_timeout) {
                                    tracing::warn!("[Scheduler] 未能终止会话 {}", session_id_for_timeout);
                                }
                            }
                            
                            // 更新日志和任务状态
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

                            // 发送超时事件到前端
                            let _ = window_for_timeout.emit("scheduler-event", serde_json::json!({
                                "contextId": ctx_id_for_timeout,
                                "payload": {
                                    "type": "task_timeout",
                                    "taskId": task_id_for_timeout,
                                    "taskName": task_name_for_timeout,
                                    "logId": log_id_for_timeout,
                                }
                            }));
                            
                            // 发送桌面通知
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
                            
                            // 从运行列表中移除
                            {
                                let mut running = running_tasks_for_timeout.lock().await;
                                running.remove(&task_id_for_timeout);
                            }
                        });
                    }
                }
                Err(e) => {
                    tracing::error!("[Scheduler] 启动会话失败: {} - {:?}", task_name, e);

                    // 启动失败，更新状态
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

                    // 从运行列表中移除
                    {
                        let mut running = running_tasks.lock().await;
                        running.remove(&task_id);
                    }
                }
            }
        });

        // 添加到运行列表
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
    async fn build_prompt(&self, task: &ScheduledTask) -> Result<String> {
        tracing::info!(
            "[Scheduler] 构建提示词: work_dir={:?}, task_path={:?}",
            task.work_dir, task.task_path
        );

        self.build_protocol_prompt(task).await
    }

    /// 构建协议模式的提示词
    async fn build_protocol_prompt(&self, task: &ScheduledTask) -> Result<String> {
        let work_dir = task.work_dir.as_ref()
            .ok_or_else(|| crate::error::AppError::ValidationError("协议模式需要指定工作目录".to_string()))?;
        let task_path = task.task_path.as_ref()
            .ok_or_else(|| crate::error::AppError::ValidationError("协议模式需要任务路径".to_string()))?;

        // 读取协议文档
        let protocol = ProtocolTaskService::read_task_md(work_dir, task_path)
            .map_err(crate::error::AppError::IoError)?;

        // 读取用户补充
        let supplement = ProtocolTaskService::read_supplement_md(work_dir, task_path)
            .unwrap_or_default();
        let has_supplement = ProtocolTaskService::has_supplement_content(&supplement);
        let supplement_content = if has_supplement {
            ProtocolTaskService::extract_user_content(&supplement)
        } else {
            String::new()
        };

        // 读取记忆
        let memory_index = ProtocolTaskService::read_memory_index(work_dir, task_path)
            .unwrap_or_default();
        let memory_tasks = ProtocolTaskService::read_memory_tasks(work_dir, task_path)
            .unwrap_or_default();

        // 构建提示词
        let mut prompt = protocol;

        prompt.push_str("\n\n---\n\n## 当前状态\n\n");
        prompt.push_str(&memory_index);

        prompt.push_str("\n\n---\n\n## 待办任务\n\n");
        prompt.push_str(&memory_tasks);

        if has_supplement {
            prompt.push_str("\n\n---\n\n## 用户补充\n\n> 以下内容来自用户补充，请结合主任务适当参考：\n\n");
            prompt.push_str(&supplement_content);
        }

        Ok(prompt)
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
