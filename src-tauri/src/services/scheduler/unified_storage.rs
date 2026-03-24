//! 统一存储服务
//!
//! 整合存储后端，提供统一的存储接口
//! 支持自动迁移和后端切换

use crate::error::Result;
use crate::models::scheduler::{
    CreateTaskParams, LogRetentionConfig, PaginatedLogs, ScheduledTask, TaskLog, TaskStatus,
};
use crate::services::scheduler::{
    ExecutionOutcome, MigrationManager, SqliteStore, StorageBackend, StorageBackendType,
};

/// 统一存储服务配置
#[derive(Debug, Clone)]
pub struct UnifiedStorageConfig {
    /// 使用的存储后端类型
    pub backend_type: StorageBackendType,
    /// 是否自动迁移
    pub auto_migrate: bool,
    /// 是否在迁移后清理 JSON 文件
    pub cleanup_after_migration: bool,
}

impl Default for UnifiedStorageConfig {
    fn default() -> Self {
        Self {
            backend_type: StorageBackendType::Sqlite,
            auto_migrate: true,
            cleanup_after_migration: false, // 默认保留备份
        }
    }
}

/// 存储初始化结果
#[derive(Debug)]
pub struct StorageInitResult {
    /// 当前使用的后端类型
    pub backend_type: StorageBackendType,
    /// 是否执行了迁移
    pub migrated: bool,
    /// 迁移的任务数量
    pub tasks_migrated: usize,
    /// 迁移的日志数量
    pub logs_migrated: usize,
}

/// 统一存储服务
///
/// 提供统一的存储接口，支持：
/// - 自动检测并迁移 JSON 数据
/// - 统一的任务和日志 CRUD 操作
/// - 运行态状态更新
pub struct UnifiedStorageService {
    backend: Box<dyn StorageBackend>,
    config: UnifiedStorageConfig,
}

impl UnifiedStorageService {
    /// 创建新的统一存储服务
    ///
    /// 会自动检测是否需要迁移，并根据配置执行迁移
    pub fn new() -> Result<Self> {
        Self::with_config(UnifiedStorageConfig::default())
    }

    /// 使用指定配置创建统一存储服务
    pub fn with_config(config: UnifiedStorageConfig) -> Result<Self> {
        match config.backend_type {
            StorageBackendType::Sqlite => {
                let sqlite_store = SqliteStore::new()?;
                Self::initialize_sqlite_backend(sqlite_store, &config)
            }
            StorageBackendType::Json => {
                // JSON 后端已弃用，但仍保留兼容性
                tracing::warn!("[UnifiedStorage] JSON 后端已弃用，建议迁移到 SQLite");
                Err(crate::error::AppError::ConfigError(
                    "JSON 后端已弃用，请使用 SQLite".to_string(),
                ))
            }
        }
    }

    /// 初始化 SQLite 后端
    fn initialize_sqlite_backend(
        sqlite_store: SqliteStore,
        config: &UnifiedStorageConfig,
    ) -> Result<Self> {
        // 检查是否需要迁移
        if config.auto_migrate {
            let migration_manager = MigrationManager::new()?;

            if migration_manager.needs_migration() {
                tracing::info!("[UnifiedStorage] 检测到 JSON 数据，开始自动迁移...");

                match migration_manager.migrate(&sqlite_store) {
                    Ok(result) => {
                        tracing::info!(
                            "[UnifiedStorage] 迁移完成: 任务 {} (失败 {}), 日志 {} (失败 {})",
                            result.tasks_migrated,
                            result.tasks_failed,
                            result.logs_migrated,
                            result.logs_failed
                        );

                        // 可选：清理 JSON 文件
                        if config.cleanup_after_migration {
                            if let Err(e) = migration_manager.cleanup_json_files() {
                                tracing::warn!("[UnifiedStorage] 清理 JSON 文件失败: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("[UnifiedStorage] 迁移失败: {}", e);
                        // 迁移失败不影响服务启动，使用空数据库
                    }
                }
            }
        }

        Ok(Self {
            backend: Box::new(sqlite_store),
            config: config.clone(),
        })
    }

    /// 获取当前后端类型
    pub fn backend_type(&self) -> StorageBackendType {
        self.backend.backend_type()
    }

    /// 获取存储配置
    pub fn config(&self) -> &UnifiedStorageConfig {
        &self.config
    }

    // ========================================================================
    // 任务操作
    // ========================================================================

    /// 获取所有任务
    pub fn get_all_tasks(&self) -> Result<Vec<ScheduledTask>> {
        self.backend.get_all_tasks()
    }

    /// 获取单个任务
    pub fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>> {
        self.backend.get_task(id)
    }

    /// 创建任务
    pub fn create_task(
        &self,
        params: CreateTaskParams,
        task_path: Option<String>,
    ) -> Result<ScheduledTask> {
        self.backend.create_task(params, task_path)
    }

    /// 更新任务
    pub fn update_task(&self, task: &ScheduledTask) -> Result<()> {
        self.backend.update_task(task)
    }

    /// 删除任务
    pub fn delete_task(&self, id: &str) -> Result<()> {
        self.backend.delete_task(id)
    }

    /// 获取待执行的任务
    pub fn get_pending_tasks(&self) -> Result<Vec<ScheduledTask>> {
        self.backend.get_pending_tasks()
    }

    /// 切换任务启用状态
    pub fn toggle_task(&self, id: &str, enabled: bool, next_run_at: Option<i64>) -> Result<()> {
        self.backend.toggle_task(id, enabled, next_run_at)
    }

    // ========================================================================
    // 任务运行态操作
    // ========================================================================

    /// 更新任务会话 ID
    pub fn update_conversation_session_id(
        &self,
        id: &str,
        session_id: Option<String>,
    ) -> Result<()> {
        self.backend.update_conversation_session_id(id, session_id)
    }

    /// 更新任务执行状态
    pub fn update_run_status(
        &self,
        id: &str,
        status: TaskStatus,
        increment_runs: bool,
    ) -> Result<()> {
        self.backend.update_run_status(id, status, increment_runs)
    }

    /// 更新任务上次执行结果类型
    pub fn update_last_run_outcome(&self, id: &str, outcome: ExecutionOutcome) -> Result<()> {
        self.backend.update_last_run_outcome(id, outcome)
    }

    /// 更新下次执行时间
    pub fn update_next_run_at(&self, id: &str, next_run_at: Option<i64>) -> Result<()> {
        self.backend.update_next_run_at(id, next_run_at)
    }

    /// 设置订阅
    pub fn set_subscription(&self, id: &str, context_id: Option<&str>) -> Result<()> {
        self.backend.set_subscription(id, context_id)
    }

    /// 更新重试状态
    pub fn update_retry_status(
        &self,
        id: &str,
        max_retries: u32,
        interval_secs: i64,
    ) -> Result<bool> {
        self.backend.update_retry_status(id, max_retries, interval_secs)
    }

    /// 重置重试计数
    pub fn reset_retry_count(&self, id: &str) -> Result<()> {
        self.backend.reset_retry_count(id)
    }

    /// 重置任务会话
    pub fn reset_session(&self, id: &str) -> Result<()> {
        self.backend.reset_session(id)
    }

    /// 更新任务阻塞状态
    pub fn update_blocked_status(
        &self,
        id: &str,
        blocked: bool,
        reason: Option<String>,
    ) -> Result<()> {
        self.backend.update_blocked_status(id, blocked, reason)
    }

    /// 更新任务当前阶段
    pub fn update_current_phase(&self, id: &str, phase: &str) -> Result<()> {
        self.backend.update_current_phase(id, phase)
    }

    /// 更新最近有效进展时间
    pub fn update_last_effective_progress(&self, id: &str) -> Result<()> {
        self.backend.update_last_effective_progress(id)
    }

    /// 更新连续无进展计数
    pub fn update_consecutive_no_progress(&self, id: &str) -> Result<u32> {
        self.backend.update_consecutive_no_progress(id)
    }

    // ========================================================================
    // 日志操作
    // ========================================================================

    /// 创建日志记录
    pub fn create_log(
        &self,
        task_id: &str,
        task_name: &str,
        prompt: &str,
        engine_id: &str,
    ) -> Result<TaskLog> {
        self.backend.create_log(task_id, task_name, prompt, engine_id)
    }

    /// 更新日志（完成时）
    #[allow(clippy::too_many_arguments)]
    pub fn update_log_complete(
        &self,
        log_id: &str,
        session_id: Option<String>,
        output: Option<String>,
        error: Option<String>,
        thinking_summary: Option<String>,
        tool_call_count: u32,
        token_count: Option<u32>,
    ) -> Result<()> {
        self.backend.update_log_complete(
            log_id,
            session_id,
            output,
            error,
            thinking_summary,
            tool_call_count,
            token_count,
        )
    }

    /// 获取任务日志
    pub fn get_task_logs(&self, task_id: &str) -> Result<Vec<TaskLog>> {
        self.backend.get_task_logs(task_id)
    }

    /// 获取所有日志
    pub fn get_all_logs(&self, limit: Option<usize>) -> Result<Vec<TaskLog>> {
        self.backend.get_all_logs(limit)
    }

    /// 分页获取日志
    pub fn get_logs_paginated(
        &self,
        task_id: Option<&str>,
        page: u32,
        page_size: u32,
    ) -> Result<PaginatedLogs> {
        self.backend.get_logs_paginated(task_id, page, page_size)
    }

    /// 删除单条日志
    pub fn delete_log(&self, log_id: &str) -> Result<bool> {
        self.backend.delete_log(log_id)
    }

    /// 清理指定任务的所有日志
    pub fn clear_task_logs(&self, task_id: &str) -> Result<usize> {
        self.backend.clear_task_logs(task_id)
    }

    /// 清理过期日志
    pub fn cleanup_expired_logs(&self, retention_days: u32) -> Result<usize> {
        self.backend.cleanup_expired_logs(retention_days)
    }

    // ========================================================================
    // 配置操作
    // ========================================================================

    /// 获取日志保留配置
    pub fn get_retention_config(&self) -> Result<LogRetentionConfig> {
        self.backend.get_retention_config()
    }

    /// 更新日志保留配置
    pub fn update_retention_config(&self, config: &LogRetentionConfig) -> Result<()> {
        self.backend.update_retention_config(config)
    }

    // ========================================================================
    // 统计与诊断
    // ========================================================================

    /// 获取任务数量
    pub fn task_count(&self) -> Result<usize> {
        self.backend.task_count()
    }

    /// 获取日志数量
    pub fn log_count(&self) -> Result<usize> {
        self.backend.log_count()
    }

    // ========================================================================
    // 迁移相关
    // ========================================================================

    /// 检查是否需要迁移
    pub fn check_migration_needed(&self) -> bool {
        if self.backend_type() != StorageBackendType::Sqlite {
            return false;
        }

        let migration_manager = match MigrationManager::new() {
            Ok(m) => m,
            Err(_) => return false,
        };

        migration_manager.needs_migration()
    }

    /// 获取迁移状态
    pub fn get_migration_status(&self) -> Option<crate::services::scheduler::MigrationStatus> {
        let migration_manager = MigrationManager::new().ok()?;
        migration_manager.get_migration_status()
    }
}

impl Default for UnifiedStorageService {
    fn default() -> Self {
        Self::new().expect("Failed to create UnifiedStorageService")
    }
}
