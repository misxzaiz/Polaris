use crate::error::{AppError, Result};
use crate::models::scheduler::{CreateTaskParams, ScheduledTask, TaskLog, TaskStore, LogStore, PaginatedLogs, TaskMode};
use crate::services::scheduler::ProtocolTaskService;
use std::path::PathBuf;
use uuid::Uuid;
use chrono::Utc;

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
            mode: params.mode.clone(),
            task_path: None,
            last_run_at: None,
            last_run_status: None,
            next_run_at: None,
            created_at: now,
            updated_at: now,
            max_runs: params.max_runs,
            current_runs: 0,
        };

        // 如果是协议模式，创建任务目录结构
        if params.mode == TaskMode::Protocol {
            let work_dir = params.work_dir.clone().unwrap_or_else(|| ".".to_string());
            let mission = params.mission.clone().unwrap_or_else(|| task.name.clone());

            let task_path = ProtocolTaskService::create_task_structure(
                &work_dir,
                &id,
                &mission,
            ).map_err(|e| AppError::IoError(e))?;

            task.task_path = Some(task_path);
        }

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
            existing.mode = task.mode;
            existing.task_path = task.task_path;
            existing.max_runs = task.max_runs;
            // 保留 current_runs，不更新
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
            // 如果是协议模式，删除任务目录
            if task.mode == TaskMode::Protocol {
                if let (Some(work_dir), Some(task_path)) = (&task.work_dir, &task.task_path) {
                    let _ = ProtocolTaskService::delete_task_structure(work_dir, task_path);
                }
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
}

/// 日志存储服务
pub struct LogStoreService {
    store: LogStore,
    store_path: PathBuf,
    max_logs_per_task: usize,
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
            max_logs_per_task: 100,
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
            .or_insert_with(Vec::new)
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
        session_id: Option<String>,
        output: Option<String>,
        error: Option<String>,
        thinking_summary: Option<String>,
        tool_call_count: u32,
        token_count: Option<u32>,
    ) -> Result<()> {
        let status = if error.is_some() {
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
        let truncated_output = output.map(|o| {
            if o.len() > self.max_output_length {
                let truncated = truncate_utf8_safe(&o, self.max_output_length);
                format!("{}...\n[输出已截断，共 {} 字符]",
                    truncated, o.chars().count())
            } else {
                o
            }
        });

        // 截取思考摘要（UTF-8 安全）
        let truncated_thinking = thinking_summary.map(|t| {
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
                log.session_id = session_id.clone();
                log.finished_at = Some(finished_at);
                log.duration_ms = Some(duration_ms);
                log.status = status.clone();
                log.output = truncated_output.clone();
                log.error = error.clone();
                log.thinking_summary = truncated_thinking.clone();
                log.tool_call_count = tool_call_count;
                log.token_count = token_count;
                break;
            }
        }

        // 同步更新任务日志列表
        for logs in self.store.logs.values_mut() {
            for log in logs.iter_mut() {
                if log.id == log_id {
                    log.session_id = session_id.clone();
                    log.finished_at = Some(finished_at);
                    log.duration_ms = Some(duration_ms);
                    log.status = status.clone();
                    log.output = truncated_output.clone();
                    log.error = error.clone();
                    log.thinking_summary = truncated_thinking.clone();
                    log.tool_call_count = tool_call_count;
                    log.token_count = token_count;
                    break;
                }
            }
        }

        self.save()?;
        Ok(())
    }

    /// 更新日志（兼容旧接口）
    pub fn update(&mut self, log_id: &str, output: Option<String>, error: Option<String>) -> Result<()> {
        self.update_complete(log_id, None, output, error, None, 0, None)
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
        if let Some(logs) = self.store.logs.get_mut(task_id) {
            if logs.len() > self.max_logs_per_task {
                let removed: Vec<_> = logs.drain(self.max_logs_per_task..).collect();
                // 从 all_logs 中移除
                let removed_ids: std::collections::HashSet<_> = removed.iter().map(|l| l.id.as_str()).collect();
                self.store.all_logs.retain(|l| !removed_ids.contains(l.id.as_str()));
            }
        }
        Ok(())
    }

    /// 清理过期日志（超过 30 天）
    pub fn cleanup_expired_logs(&mut self) -> Result<()> {
        let thirty_days_ago = Utc::now().timestamp() - (30 * 24 * 60 * 60);

        self.store.all_logs.retain(|log| log.started_at > thirty_days_ago);

        for logs in self.store.logs.values_mut() {
            logs.retain(|log| log.started_at > thirty_days_ago);
        }

        self.save()?;
        Ok(())
    }

    /// 分页获取日志
    pub fn get_logs_paginated(
        &self,
        task_id: Option<&str>,
        page: u32,
        page_size: u32,
    ) -> PaginatedLogs {
        let page = page.max(1);
        let page_size = page_size.max(1).min(100) as usize;

        // 获取要分页的日志
        let logs_to_page: Vec<&TaskLog> = if let Some(tid) = task_id {
            self.store.logs.get(tid)
                .map(|logs| logs.iter().collect())
                .unwrap_or_default()
        } else {
            self.store.all_logs.iter().collect()
        };

        let total = logs_to_page.len();
        let total_pages = (total + page_size - 1) / page_size;
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
}
