use crate::error::{AppError, Result};
use crate::models::scheduler::{CreateTaskParams, ScheduledTask, TaskLog, TaskStore, LogStore, PaginatedLogs, LogRetentionConfig};
use crate::services::scheduler::ProtocolTaskService;
use std::path::PathBuf;
use uuid::Uuid;
use chrono::Utc;

/// update_complete 函数的参数
/// 用于减少参数数量，避免 too_many_arguments 警告
#[derive(Debug, Clone, Default)]
pub struct UpdateCompleteParams {
    /// 会话 ID
    pub session_id: Option<String>,
    /// 输出内容
    pub output: Option<String>,
    /// 错误信息
    pub error: Option<String>,
    /// 思考摘要
    pub thinking_summary: Option<String>,
    /// 工具调用次数
    pub tool_call_count: u32,
    /// Token 数量
    pub token_count: Option<u32>,
}

/// UTF-8 安全截取字符串（按字节限制，确保不切断多字节字符）
fn truncate_utf8_safe(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }

    // 找到不超过 max_bytes 的最大字符边界
    let mut boundary = max_bytes;
    while boundary > 0 && !s.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &s[..boundary]
}

/// 任务存储服务
pub struct TaskStoreService {
    store: TaskStore,
    store_path: PathBuf,
}

impl TaskStoreService {
    /// 创建新的任务存储服务
    pub fn new() -> Result<Self> {
        let store_dir = dirs::config_dir()
            .ok_or_else(|| AppError::ConfigError("无法获取配置目录".to_string()))?
            .join("claude-code-pro");

        // 确保目录存在
        std::fs::create_dir_all(&store_dir)?;

        let store_path = store_dir.join("scheduler_tasks.json");
        let store = Self::load_from_file(&store_path)?;

        Ok(Self { store, store_path })
    }

    /// 从文件加载
    fn load_from_file(path: &PathBuf) -> Result<TaskStore> {
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            if let Ok(store) = serde_json::from_str::<TaskStore>(&content) {
                return Ok(store);
            }
        }
        Ok(TaskStore::default())
    }

    /// 保存到文件
    fn save(&self) -> Result<()> {
        let content = serde_json::to_string_pretty(&self.store)?;
        std::fs::write(&self.store_path, content)?;
        Ok(())
    }

    /// 获取所有任务
    pub fn get_all(&self) -> &[ScheduledTask] {
        &self.store.tasks
    }

    /// 获取单个任务
    pub fn get(&self, id: &str) -> Option<&ScheduledTask> {
        self.store.tasks.iter().find(|t| t.id == id)
    }

    /// 创建任务
    pub fn create(&mut self, params: CreateTaskParams) -> Result<ScheduledTask> {
        let now = Utc::now().timestamp();
        let id = Uuid::new_v4().to_string();

        let mut task = ScheduledTask {
            id: id.clone(),
            name: params.name,
            enabled: params.enabled,
            trigger_type: params.trigger_type,
            trigger_value: params.trigger_value,
            engine_id: params.engine_id,
            prompt: params.prompt,
            work_dir: params.work_dir.clone(),
            group: params.group,
            description: params.description,
            task_path: None,
            mission: params.mission.clone(),
            last_run_at: None,
            last_run_status: None,
            next_run_at: None,
            created_at: now,
            updated_at: now,
            max_runs: params.max_runs,
            current_runs: 0,
            run_in_terminal: params.run_in_terminal,
            template_id: params.template_id,
            template_param_values: params.template_param_values,
            subscribed_context_id: None,
            max_retries: params.max_retries,
            retry_count: 0,
            retry_interval: params.retry_interval,
            notify_on_complete: params.notify_on_complete,
            timeout_minutes: params.timeout_minutes,
            user_supplement: params.user_supplement,
            task_template: params.task_template.clone(),
            memory_template: params.memory_template.clone(),
            tasks_template: params.tasks_template.clone(),
            runs_template: params.runs_template.clone(),
            supplement_template: params.supplement_template.clone(),
        };

        // 创建任务目录结构（使用自定义模板）
        let work_dir = params.work_dir.clone().unwrap_or_else(|| ".".to_string());
        let mission = task.mission.clone().unwrap_or_else(|| task.name.clone());

        let task_path = ProtocolTaskService::create_task_structure_with_templates(
            &work_dir,
            &id,
            &mission,
            params.task_template.as_deref(),
            params.memory_template.as_deref(),
            params.tasks_template.as_deref(),
            params.runs_template.as_deref(),
            params.supplement_template.as_deref(),
        ).map_err(AppError::IoError)?;

        task.task_path = Some(task_path);

        // 计算下次执行时间
        task.next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, now);

        self.store.tasks.push(task.clone());
        self.save()?;
        Ok(task)
    }

    /// 更新任务
    pub fn update(&mut self, task: ScheduledTask) -> Result<()> {
        if let Some(existing) = self.store.tasks.iter_mut().find(|t| t.id == task.id) {
            let now = Utc::now().timestamp();
            existing.name = task.name;
            existing.enabled = task.enabled;
            existing.trigger_type = task.trigger_type;
            existing.trigger_value = task.trigger_value;
            existing.engine_id = task.engine_id;
            existing.prompt = task.prompt;
            existing.work_dir = task.work_dir;
            existing.group = task.group;
            existing.description = task.description;
            existing.task_path = task.task_path;
            existing.max_runs = task.max_runs;
            existing.run_in_terminal = task.run_in_terminal;
            existing.template_id = task.template_id;
            existing.template_param_values = task.template_param_values;
            existing.max_retries = task.max_retries;
            existing.retry_interval = task.retry_interval;
            existing.notify_on_complete = task.notify_on_complete;
            existing.timeout_minutes = task.timeout_minutes;
            existing.user_supplement = task.user_supplement;
            existing.task_template = task.task_template;
            existing.memory_template = task.memory_template;
            existing.tasks_template = task.tasks_template;
            existing.runs_template = task.runs_template;
            existing.supplement_template = task.supplement_template;
            // 保留 current_runs、retry_count、subscribed_context_id，不更新
            existing.updated_at = now;

            // 重新计算下次执行时间
            existing.next_run_at = existing.trigger_type.calculate_next_run(&existing.trigger_value, now);

            self.save()?;
        }
        Ok(())
    }

    /// 删除任务
    pub fn delete(&mut self, id: &str) -> Result<()> {
        // 获取任务信息以删除目录
        if let Some(task) = self.store.tasks.iter().find(|t| t.id == id) {
            // 删除任务目录
            if let (Some(work_dir), Some(task_path)) = (&task.work_dir, &task.task_path) {
                let _ = ProtocolTaskService::delete_task_structure(work_dir, task_path);
            }
        }

        self.store.tasks.retain(|t| t.id != id);
        self.save()?;
        Ok(())
    }

    /// 切换任务启用状态
    pub fn toggle(&mut self, id: &str, enabled: bool) -> Result<()> {
        if let Some(task) = self.store.tasks.iter_mut().find(|t| t.id == id) {
            task.enabled = enabled;
            task.updated_at = Utc::now().timestamp();

            // 如果启用，重新计算下次执行时间
            if enabled {
                task.next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, Utc::now().timestamp());
            } else {
                task.next_run_at = None;
            }

            self.save()?;
        }
        Ok(())
    }

    /// 更新任务执行状态
    pub fn update_run_status(&mut self, id: &str, status: crate::models::scheduler::TaskStatus) -> Result<()> {
        if let Some(task) = self.store.tasks.iter_mut().find(|t| t.id == id) {
            let now = Utc::now().timestamp();
            task.last_run_at = Some(now);
            task.last_run_status = Some(status);

            // 只有成功时才增加执行轮次
            if status == crate::models::scheduler::TaskStatus::Success {
                task.current_runs += 1;
            }

            // 检查是否达到最大执行轮次
            if let Some(max_runs) = task.max_runs {
                if task.current_runs >= max_runs {
                    task.enabled = false;
                    task.next_run_at = None;
                    tracing::info!("[Scheduler] 任务 {} 已达到最大执行轮次 {}，自动禁用", task.name, max_runs);
                    self.save()?;
                    return Ok(());
                }
            }

            // 如果是间隔或 cron 任务，计算下次执行时间
            if task.enabled {
                task.next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, now);
            }

            self.save()?;
        }
        Ok(())
    }

    /// 获取待执行的任务
    pub fn get_pending_tasks(&self) -> Vec<&ScheduledTask> {
        let now = Utc::now().timestamp();
        self.store.tasks.iter()
            .filter(|t| {
                // 检查是否启用
                if !t.enabled {
                    return false;
                }

                // 检查是否到达执行时间
                if !t.next_run_at.map(|nr| nr <= now).unwrap_or(false) {
                    return false;
                }

                // 检查是否达到最大执行轮次
                if let Some(max_runs) = t.max_runs {
                    if t.current_runs >= max_runs {
                        return false;
                    }
                }

                true
            })
            .collect()
    }

    /// 设置/取消任务的订阅状态
    /// 
    /// context_id 为 Some 时表示订阅，为 None 时表示取消订阅
    pub fn set_subscription(&mut self, id: &str, context_id: Option<&str>) -> Result<()> {
        // 先找到任务，记录更新信息
        let (task_name, sub_ctx_id) = {
            if let Some(task) = self.store.tasks.iter().find(|t| t.id == id) {
                let name = task.name.clone();
                let ctx = context_id.map(|s| s.to_string());
                (name, ctx)
            } else {
                return Ok(());
            }
        };

        // 更新任务
        if let Some(task) = self.store.tasks.iter_mut().find(|t| t.id == id) {
            task.subscribed_context_id = sub_ctx_id.clone();
            task.updated_at = Utc::now().timestamp();
        }

        // 保存
        self.save()?;
        tracing::info!("[Scheduler] 任务 {} 订阅状态已更新: {:?}", task_name, sub_ctx_id);
        Ok(())
    }

    /// 更新任务重试状态
    /// 
    /// 返回 true 表示可以重试，返回 false 表示不能重试或已达到最大重试次数
    pub fn update_retry_status(&mut self, id: &str) -> Result<bool> {
        if let Some(task) = self.store.tasks.iter_mut().find(|t| t.id == id) {
            // 检查是否配置了重试
            let max_retries = match task.max_retries {
                Some(max) if max > 0 => max,
                _ => return Ok(false), // 未配置重试
            };

            // 检查是否已达到最大重试次数
            if task.retry_count >= max_retries {
                tracing::info!(
                    "[Scheduler] 任务 {} 已达到最大重试次数 {}/{}，不再重试",
                    task.name, task.retry_count, max_retries
                );
                return Ok(false);
            }

            // 增加重试计数
            task.retry_count += 1;

            // 计算下次重试时间
            let now = chrono::Utc::now().timestamp();
            let retry_interval = task.retry_interval.as_deref().unwrap_or("5m"); // 默认 5 分钟

            let interval_secs = crate::models::scheduler::parse_interval(retry_interval)
                .unwrap_or(300); // 默认 300 秒（5 分钟）

            task.next_run_at = Some(now + interval_secs);
            task.updated_at = now;

            tracing::info!(
                "[Scheduler] 任务 {} 将在 {} 秒后重试 ({}/{})",
                task.name, interval_secs, task.retry_count, max_retries
            );

            self.save()?;
            return Ok(true);
        }

        Ok(false)
    }

    /// 重置任务重试计数（任务成功后调用）
    pub fn reset_retry_count(&mut self, id: &str) -> Result<()> {
        // 先查找并记录需要重置的任务
        let (should_save, task_name) = {
            if let Some(task) = self.store.tasks.iter().find(|t| t.id == id) {
                if task.retry_count > 0 {
                    (true, Some(task.name.clone()))
                } else {
                    (false, None)
                }
            } else {
                (false, None)
            }
        };

        // 如果需要保存，执行更新
        if should_save {
            if let Some(task) = self.store.tasks.iter_mut().find(|t| t.id == id) {
                task.retry_count = 0;
                task.updated_at = chrono::Utc::now().timestamp();
            }
            self.save()?;
            if let Some(name) = task_name {
                tracing::info!("[Scheduler] 任务 {} 重试计数已重置", name);
            }
        }
        Ok(())
    }
}

/// 日志存储服务
pub struct LogStoreService {
    store: LogStore,
    store_path: PathBuf,
    max_output_length: usize,
}

impl LogStoreService {
    /// 创建新的日志存储服务
    pub fn new() -> Result<Self> {
        let store_dir = dirs::config_dir()
            .ok_or_else(|| AppError::ConfigError("无法获取配置目录".to_string()))?
            .join("claude-code-pro");

        std::fs::create_dir_all(&store_dir)?;

        let store_path = store_dir.join("scheduler_logs.json");
        let store = Self::load_from_file(&store_path)?;

        Ok(Self {
            store,
            store_path,
            max_output_length: 2000,
        })
    }

    /// 从文件加载
    fn load_from_file(path: &PathBuf) -> Result<LogStore> {
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            if let Ok(store) = serde_json::from_str::<LogStore>(&content) {
                return Ok(store);
            }
        }
        Ok(LogStore::default())
    }

    /// 保存到文件
    fn save(&self) -> Result<()> {
        let content = serde_json::to_string_pretty(&self.store)?;
        std::fs::write(&self.store_path, content)?;
        Ok(())
    }

    /// 创建日志记录
    pub fn create(&mut self, task_id: &str, task_name: &str, prompt: &str, engine_id: &str) -> Result<TaskLog> {
        let log = TaskLog {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            task_name: task_name.to_string(),
            engine_id: engine_id.to_string(),
            session_id: None,
            started_at: Utc::now().timestamp(),
            finished_at: None,
            duration_ms: None,
            status: crate::models::scheduler::TaskStatus::Running,
            prompt: prompt.to_string(),
            output: None,
            error: None,
            thinking_summary: None,
            tool_call_count: 0,
            token_count: None,
        };

        // 添加到任务日志列表
        self.store.logs
            .entry(task_id.to_string())
            .or_default()
            .insert(0, log.clone());

        // 添加到所有日志列表
        self.store.all_logs.insert(0, log.clone());

        // 清理旧日志
        self.cleanup_old_logs(task_id)?;

        self.save()?;
        Ok(log)
    }

    /// 更新日志（完成时调用）
    pub fn update_complete(
        &mut self,
        log_id: &str,
        params: UpdateCompleteParams,
    ) -> Result<()> {
        let status = if params.error.is_some() {
            crate::models::scheduler::TaskStatus::Failed
        } else {
            crate::models::scheduler::TaskStatus::Success
        };

        let finished_at = Utc::now().timestamp();
        let started_at = self.store.all_logs.iter()
            .find(|l| l.id == log_id)
            .map(|l| l.started_at)
            .unwrap_or(finished_at);
        let duration_ms = (finished_at - started_at) * 1000;

        // 截取输出（UTF-8 安全）
        let truncated_output = params.output.map(|o| {
            if o.len() > self.max_output_length {
                let truncated = truncate_utf8_safe(&o, self.max_output_length);
                format!("{}...\n[输出已截断，共 {} 字符]",
                    truncated, o.chars().count())
            } else {
                o
            }
        });

        // 截取思考摘要（UTF-8 安全）
        let truncated_thinking = params.thinking_summary.map(|t| {
            if t.len() > 500 {
                let truncated = truncate_utf8_safe(&t, 500);
                format!("{}...", truncated)
            } else {
                t
            }
        });

        // 更新所有日志中的记录
        for log in &mut self.store.all_logs {
            if log.id == log_id {
                log.session_id = params.session_id.clone();
                log.finished_at = Some(finished_at);
                log.duration_ms = Some(duration_ms);
                log.status = status;
                log.output = truncated_output.clone();
                log.error = params.error.clone();
                log.thinking_summary = truncated_thinking.clone();
                log.tool_call_count = params.tool_call_count;
                log.token_count = params.token_count;
                break;
            }
        }

        // 同步更新任务日志列表
        for logs in self.store.logs.values_mut() {
            for log in logs.iter_mut() {
                if log.id == log_id {
                    log.session_id = params.session_id.clone();
                    log.finished_at = Some(finished_at);
                    log.duration_ms = Some(duration_ms);
                    log.status = status;
                    log.output = truncated_output.clone();
                    log.error = params.error.clone();
                    log.thinking_summary = truncated_thinking.clone();
                    log.tool_call_count = params.tool_call_count;
                    log.token_count = params.token_count;
                    break;
                }
            }
        }

        self.save()?;
        Ok(())
    }

    /// 更新日志（兼容旧接口）
    pub fn update(&mut self, log_id: &str, output: Option<String>, error: Option<String>) -> Result<()> {
        self.update_complete(log_id, UpdateCompleteParams {
            output,
            error,
            ..Default::default()
        })
    }

    /// 获取任务日志
    pub fn get_task_logs(&self, task_id: &str) -> Vec<&TaskLog> {
        self.store.logs.get(task_id)
            .map(|logs| logs.iter().collect())
            .unwrap_or_default()
    }

    /// 获取所有日志
    pub fn get_all_logs(&self, limit: Option<usize>) -> Vec<&TaskLog> {
        match limit {
            Some(n) => self.store.all_logs.iter().take(n).collect(),
            None => self.store.all_logs.iter().collect(),
        }
    }

    /// 清理旧日志
    fn cleanup_old_logs(&mut self, task_id: &str) -> Result<()> {
        let max_logs = self.store.retention_config.max_logs_per_task as usize;
        if max_logs == 0 {
            return Ok(()); // 0 表示不限制
        }

        if let Some(logs) = self.store.logs.get_mut(task_id) {
            if logs.len() > max_logs {
                let removed: Vec<_> = logs.drain(max_logs..).collect();
                // 从 all_logs 中移除
                let removed_ids: std::collections::HashSet<_> = removed.iter().map(|l| l.id.as_str()).collect();
                self.store.all_logs.retain(|l| !removed_ids.contains(l.id.as_str()));
            }
        }
        Ok(())
    }

    /// 清理过期日志
    pub fn cleanup_expired_logs(&mut self) -> Result<usize> {
        let retention_days = self.store.retention_config.retention_days;
        if retention_days == 0 {
            return Ok(0); // 0 表示不限制
        }

        let cutoff_time = Utc::now().timestamp() - (retention_days as i64 * 24 * 60 * 60);

        // 统计要删除的数量
        let before_count = self.store.all_logs.len();

        self.store.all_logs.retain(|log| log.started_at > cutoff_time);
        let removed_count = before_count - self.store.all_logs.len();

        for logs in self.store.logs.values_mut() {
            logs.retain(|log| log.started_at > cutoff_time);
        }

        // 更新上次清理时间
        self.store.last_cleanup_at = Some(Utc::now().timestamp());

        if removed_count > 0 {
            self.save()?;
            tracing::info!("[Scheduler] 已清理 {} 条过期日志（保留 {} 天）", removed_count, retention_days);
        }

        Ok(removed_count)
    }

    /// 分页获取日志
    pub fn get_logs_paginated(
        &self,
        task_id: Option<&str>,
        page: u32,
        page_size: u32,
    ) -> PaginatedLogs {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 100) as usize;

        // 获取要分页的日志
        let logs_to_page: Vec<&TaskLog> = if let Some(tid) = task_id {
            self.store.logs.get(tid)
                .map(|logs| logs.iter().collect())
                .unwrap_or_default()
        } else {
            self.store.all_logs.iter().collect()
        };

        let total = logs_to_page.len();
        let total_pages = total.div_ceil(page_size);
        let skip = ((page - 1) as usize) * page_size;

        let logs: Vec<TaskLog> = logs_to_page
            .into_iter()
            .skip(skip)
            .take(page_size)
            .cloned()
            .collect();

        PaginatedLogs {
            logs,
            total,
            page,
            page_size: page_size as u32,
            total_pages,
        }
    }

    /// 删除单条日志
    pub fn delete_log(&mut self, log_id: &str) -> Result<bool> {
        let mut found = false;

        // 从 all_logs 中移除
        if let Some(pos) = self.store.all_logs.iter().position(|l| l.id == log_id) {
            let log = self.store.all_logs.remove(pos);
            found = true;

            // 从任务日志列表中移除
            if let Some(logs) = self.store.logs.get_mut(&log.task_id) {
                logs.retain(|l| l.id != log_id);
            }
        }

        if found {
            self.save()?;
        }

        Ok(found)
    }

    /// 批量删除日志
    pub fn delete_logs(&mut self, log_ids: &[String]) -> Result<usize> {
        let ids_set: std::collections::HashSet<_> = log_ids.iter().map(|s| s.as_str()).collect();
        let mut count = 0;

        // 从 all_logs 中移除
        self.store.all_logs.retain(|l| {
            if ids_set.contains(l.id.as_str()) {
                count += 1;
                false
            } else {
                true
            }
        });

        // 从各任务的日志列表中移除
        for logs in self.store.logs.values_mut() {
            logs.retain(|l| !ids_set.contains(l.id.as_str()));
        }

        if count > 0 {
            self.save()?;
        }

        Ok(count)
    }

    /// 清理指定任务的所有日志
    pub fn clear_task_logs(&mut self, task_id: &str) -> Result<usize> {
        let count = self.store.logs.get(task_id)
            .map(|logs| logs.len())
            .unwrap_or(0);

        if count > 0 {
            // 获取要删除的日志 ID
            let ids_to_remove: std::collections::HashSet<_> = self.store.logs.get(task_id)
                .map(|logs| logs.iter().map(|l| l.id.as_str()).collect())
                .unwrap_or_default();

            // 从 all_logs 中移除
            self.store.all_logs.retain(|l| !ids_to_remove.contains(l.id.as_str()));

            // 移除任务日志列表
            self.store.logs.remove(task_id);

            self.save()?;
        }

        Ok(count)
    }

    /// 获取日志保留配置
    pub fn get_retention_config(&self) -> &LogRetentionConfig {
        &self.store.retention_config
    }

    /// 更新日志保留配置
    pub fn update_retention_config(&mut self, config: LogRetentionConfig) -> Result<()> {
        self.store.retention_config = config;
        self.save()?;
        tracing::info!("[Scheduler] 日志保留配置已更新");
        Ok(())
    }

    /// 检查是否需要自动清理
    pub fn should_auto_cleanup(&self) -> bool {
        if !self.store.retention_config.auto_cleanup_enabled {
            return false;
        }

        let interval_hours = self.store.retention_config.auto_cleanup_interval_hours;
        if interval_hours == 0 {
            return false;
        }

        let now = Utc::now().timestamp();
        let interval_secs = interval_hours as i64 * 3600;

        match self.store.last_cleanup_at {
            Some(last) => now - last >= interval_secs,
            None => true, // 从未清理过，需要清理
        }
    }

    /// 获取日志统计信息
    pub fn get_log_stats(&self) -> LogStats {
        let total_logs = self.store.all_logs.len();
        let total_tasks = self.store.logs.len();
        let total_size_bytes = std::fs::metadata(&self.store_path)
            .map(|m| m.len())
            .unwrap_or(0);

        LogStats {
            total_logs,
            total_tasks,
            total_size_bytes,
            retention_config: self.store.retention_config.clone(),
            last_cleanup_at: self.store.last_cleanup_at,
        }
    }
}

/// 日志统计信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStats {
    /// 总日志数
    pub total_logs: usize,
    /// 有日志的任务数
    pub total_tasks: usize,
    /// 日志文件大小（字节）
    pub total_size_bytes: u64,
    /// 保留配置
    pub retention_config: LogRetentionConfig,
    /// 上次清理时间
    pub last_cleanup_at: Option<i64>,
}
