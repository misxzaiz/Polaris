//! 存储后端抽象层
//!
//! 提供统一的存储接口，支持 JSON 和 SQLite 两种后端
//! 用于平滑迁移和未来扩展

use crate::error::Result;
use crate::models::scheduler::{
    CreateTaskParams, LogRetentionConfig, PaginatedLogs, ScheduledTask, TaskLog, TaskStatus,
};
use crate::services::scheduler::ExecutionOutcome;

/// 存储后端类型
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StorageBackendType {
    /// JSON 文件存储（旧版）
    Json,
    /// SQLite 数据库存储（新版）
    Sqlite,
}

/// 存储后端 Trait
///
/// 定义统一的存储接口，所有存储实现都必须满足此接口
pub trait StorageBackend: Send + Sync {
    /// 获取存储后端类型
    fn backend_type(&self) -> StorageBackendType;

    // ========================================================================
    // 任务操作
    // ========================================================================

    /// 获取所有任务
    fn get_all_tasks(&self) -> Result<Vec<ScheduledTask>>;

    /// 获取单个任务
    fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>>;

    /// 创建任务
    fn create_task(
        &self,
        params: CreateTaskParams,
        task_path: Option<String>,
    ) -> Result<ScheduledTask>;

    /// 更新任务
    fn update_task(&self, task: &ScheduledTask) -> Result<()>;

    /// 删除任务
    fn delete_task(&self, id: &str) -> Result<()>;

    /// 获取待执行的任务
    fn get_pending_tasks(&self) -> Result<Vec<ScheduledTask>>;

    /// 切换任务启用状态
    fn toggle_task(&self, id: &str, enabled: bool, next_run_at: Option<i64>) -> Result<()>;

    // ========================================================================
    // 任务运行态操作
    // ========================================================================

    /// 更新任务会话 ID
    fn update_conversation_session_id(&self, id: &str, session_id: Option<String>) -> Result<()>;

    /// 更新任务执行状态
    fn update_run_status(&self, id: &str, status: TaskStatus, increment_runs: bool) -> Result<()>;

    /// 更新任务上次执行结果类型
    fn update_last_run_outcome(&self, id: &str, outcome: ExecutionOutcome) -> Result<()>;

    /// 更新下次执行时间
    fn update_next_run_at(&self, id: &str, next_run_at: Option<i64>) -> Result<()>;

    /// 设置订阅
    fn set_subscription(&self, id: &str, context_id: Option<&str>) -> Result<()>;

    /// 更新重试状态
    /// 返回 true 表示可以重试，false 表示已达上限
    fn update_retry_status(&self, id: &str, max_retries: u32, interval_secs: i64) -> Result<bool>;

    /// 重置重试计数
    fn reset_retry_count(&self, id: &str) -> Result<()>;

    /// 重置任务会话
    fn reset_session(&self, id: &str) -> Result<()>;

    /// 更新任务阻塞状态
    fn update_blocked_status(&self, id: &str, blocked: bool, reason: Option<String>) -> Result<()>;

    /// 更新任务当前阶段
    fn update_current_phase(&self, id: &str, phase: &str) -> Result<()>;

    /// 更新最近有效进展时间
    fn update_last_effective_progress(&self, id: &str) -> Result<()>;

    /// 更新连续无进展计数
    fn update_consecutive_no_progress(&self, id: &str) -> Result<u32>;

    // ========================================================================
    // 日志操作
    // ========================================================================

    /// 创建日志记录
    fn create_log(
        &self,
        task_id: &str,
        task_name: &str,
        prompt: &str,
        engine_id: &str,
    ) -> Result<TaskLog>;

    /// 更新日志（完成时）
    fn update_log_complete(
        &self,
        log_id: &str,
        session_id: Option<String>,
        output: Option<String>,
        error: Option<String>,
        thinking_summary: Option<String>,
        tool_call_count: u32,
        token_count: Option<u32>,
    ) -> Result<()>;

    /// 获取任务日志
    fn get_task_logs(&self, task_id: &str) -> Result<Vec<TaskLog>>;

    /// 获取所有日志
    fn get_all_logs(&self, limit: Option<usize>) -> Result<Vec<TaskLog>>;

    /// 分页获取日志
    fn get_logs_paginated(
        &self,
        task_id: Option<&str>,
        page: u32,
        page_size: u32,
    ) -> Result<PaginatedLogs>;

    /// 删除单条日志
    fn delete_log(&self, log_id: &str) -> Result<bool>;

    /// 清理指定任务的所有日志
    fn clear_task_logs(&self, task_id: &str) -> Result<usize>;

    /// 清理过期日志
    fn cleanup_expired_logs(&self, retention_days: u32) -> Result<usize>;

    // ========================================================================
    // 配置操作
    // ========================================================================

    /// 获取日志保留配置
    fn get_retention_config(&self) -> Result<LogRetentionConfig>;

    /// 更新日志保留配置
    fn update_retention_config(&self, config: &LogRetentionConfig) -> Result<()>;

    // ========================================================================
    // 统计与诊断
    // ========================================================================

    /// 获取任务数量
    fn task_count(&self) -> Result<usize>;

    /// 获取日志数量
    fn log_count(&self) -> Result<usize>;
}
