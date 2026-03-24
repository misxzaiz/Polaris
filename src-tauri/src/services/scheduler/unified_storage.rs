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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::scheduler::{CreateTaskParams, LogRetentionConfig, TaskStatus, TriggerType};
    use tempfile::TempDir;

    /// 创建测试用的统一存储服务（使用临时目录）
    fn create_test_storage() -> (UnifiedStorageService, TempDir) {
        let temp_dir = TempDir::new().expect("无法创建临时目录");
        let db_path = temp_dir.path().join("test_scheduler.db");

        let sqlite_store = SqliteStore::with_path(db_path).expect("无法创建 SQLite 存储");

        let service = UnifiedStorageService {
            backend: Box::new(sqlite_store),
            config: UnifiedStorageConfig::default(),
        };

        (service, temp_dir)
    }

    /// 创建测试任务参数
    fn create_test_task_params(name: &str) -> CreateTaskParams {
        CreateTaskParams {
            name: name.to_string(),
            enabled: true,
            trigger_type: TriggerType::Interval,
            trigger_value: "3600".to_string(),
            engine_id: "claude".to_string(),
            prompt: "Test prompt".to_string(),
            work_dir: Some("/tmp".to_string()),
            group: Some("test-group".to_string()),
            description: None,
            mission: None,
            max_runs: None,
            reuse_session: false,
            continue_immediately: false,
            max_continuous_runs: None,
            run_in_terminal: false,
            template_id: None,
            template_param_values: None,
            max_retries: None,
            retry_interval: None,
            notify_on_complete: true,
            timeout_minutes: None,
            user_supplement: None,
            task_template: None,
            memory_template: None,
            tasks_template: None,
            runs_template: None,
            supplement_template: None,
        }
    }

    #[test]
    fn test_unified_storage_creation() {
        let (storage, _temp_dir) = create_test_storage();

        // 验证后端类型
        assert_eq!(storage.backend_type(), StorageBackendType::Sqlite);

        // 验证初始状态
        assert_eq!(storage.task_count().unwrap(), 0);
        assert_eq!(storage.log_count().unwrap(), 0);
    }

    #[test]
    fn test_unified_storage_config() {
        let config = UnifiedStorageConfig {
            backend_type: StorageBackendType::Sqlite,
            auto_migrate: false,
            cleanup_after_migration: true,
        };

        assert_eq!(config.backend_type, StorageBackendType::Sqlite);
        assert!(!config.auto_migrate);
        assert!(config.cleanup_after_migration);
    }

    #[test]
    fn test_unified_storage_default_config() {
        let config = UnifiedStorageConfig::default();

        assert_eq!(config.backend_type, StorageBackendType::Sqlite);
        assert!(config.auto_migrate);
        assert!(!config.cleanup_after_migration);
    }

    #[test]
    fn test_create_and_get_task() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Test Task");
        let task = storage.create_task(params, None).unwrap();

        // 验证任务已创建
        assert!(!task.id.is_empty());
        assert_eq!(task.name, "Test Task");
        assert!(task.enabled);

        // 获取任务
        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.name, "Test Task");
    }

    #[test]
    fn test_get_all_tasks() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建多个任务
        for i in 0..3 {
            let params = create_test_task_params(&format!("Task {}", i));
            storage.create_task(params, None).unwrap();
        }

        // 获取所有任务
        let tasks = storage.get_all_tasks().unwrap();
        assert_eq!(tasks.len(), 3);
    }

    #[test]
    fn test_update_task() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Original Name");
        let task = storage.create_task(params, None).unwrap();

        // 更新任务
        let mut updated = task.clone();
        updated.name = "Updated Name".to_string();
        updated.enabled = false;
        storage.update_task(&updated).unwrap();

        // 验证更新
        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.name, "Updated Name");
        assert!(!retrieved.enabled);
    }

    #[test]
    fn test_delete_task() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Task to Delete");
        let task = storage.create_task(params, None).unwrap();

        // 验证任务存在
        assert!(storage.get_task(&task.id).unwrap().is_some());

        // 删除任务
        storage.delete_task(&task.id).unwrap();

        // 验证任务已删除
        assert!(storage.get_task(&task.id).unwrap().is_none());
    }

    #[test]
    fn test_toggle_task() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Toggle Test");
        let task = storage.create_task(params, None).unwrap();

        // 禁用任务
        storage.toggle_task(&task.id, false, None).unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert!(!retrieved.enabled);

        // 启用任务
        storage.toggle_task(&task.id, true, Some(1700000000)).unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert!(retrieved.enabled);
        assert_eq!(retrieved.next_run_at, Some(1700000000));
    }

    #[test]
    fn test_session_management() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Session Test");
        let task = storage.create_task(params, None).unwrap();

        // 更新会话 ID
        storage
            .update_conversation_session_id(&task.id, Some("session-123".to_string()))
            .unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.conversation_session_id, Some("session-123".to_string()));

        // 重置会话
        storage.reset_session(&task.id).unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert!(retrieved.conversation_session_id.is_none());
    }

    #[test]
    fn test_run_status_update() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Run Status Test");
        let task = storage.create_task(params, None).unwrap();

        // 更新运行状态
        storage
            .update_run_status(&task.id, TaskStatus::Success, true)
            .unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.last_run_status, Some(TaskStatus::Success));
        assert_eq!(retrieved.current_runs, 1);

        // 再次更新
        storage
            .update_run_status(&task.id, TaskStatus::Failed, true)
            .unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.last_run_status, Some(TaskStatus::Failed));
        assert_eq!(retrieved.current_runs, 2);
    }

    #[test]
    fn test_blocked_status() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Blocked Test");
        let task = storage.create_task(params, None).unwrap();

        // 设置阻塞状态
        storage
            .update_blocked_status(&task.id, true, Some("Test reason".to_string()))
            .unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert!(retrieved.blocked);
        assert_eq!(retrieved.blocked_reason, Some("Test reason".to_string()));

        // 解除阻塞
        storage.update_blocked_status(&task.id, false, None).unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert!(!retrieved.blocked);
        assert!(retrieved.blocked_reason.is_none());
    }

    #[test]
    fn test_phase_update() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Phase Test");
        let task = storage.create_task(params, None).unwrap();

        // 更新阶段
        storage.update_current_phase(&task.id, "开发").unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.current_phase, Some("开发".to_string()));

        // 更新到测试阶段
        storage.update_current_phase(&task.id, "测试").unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.current_phase, Some("测试".to_string()));
    }

    #[test]
    fn test_consecutive_no_progress() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Progress Test");
        let task = storage.create_task(params, None).unwrap();

        // 更新连续无进展计数
        let count1 = storage.update_consecutive_no_progress(&task.id).unwrap();
        assert_eq!(count1, 1);

        let count2 = storage.update_consecutive_no_progress(&task.id).unwrap();
        assert_eq!(count2, 2);

        // 更新有效进展后重置
        storage.update_last_effective_progress(&task.id).unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.consecutive_no_progress_count, 0);
        assert!(retrieved.last_effective_progress_at.is_some());
    }

    #[test]
    fn test_log_creation_and_retrieval() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Log Test");
        let task = storage.create_task(params, None).unwrap();

        // 创建日志
        let log = storage
            .create_log(&task.id, &task.name, "Test prompt", &task.engine_id)
            .unwrap();

        assert!(!log.id.is_empty());
        assert_eq!(log.task_id, task.id);
        assert_eq!(log.status, TaskStatus::Running);

        // 完成日志
        storage
            .update_log_complete(
                &log.id,
                Some("session-456".to_string()),
                Some("Test output".to_string()),
                None,
                Some("Thinking...".to_string()),
                5,
                Some(1000),
            )
            .unwrap();

        // 获取日志
        let logs = storage.get_task_logs(&task.id).unwrap();
        assert_eq!(logs.len(), 1);

        let retrieved_log = &logs[0];
        assert_eq!(retrieved_log.session_id, Some("session-456".to_string()));
        assert_eq!(retrieved_log.status, TaskStatus::Success);
        assert_eq!(retrieved_log.tool_call_count, 5);
    }

    #[test]
    fn test_log_pagination() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Pagination Test");
        let task = storage.create_task(params, None).unwrap();

        // 创建多条日志
        for i in 0..15 {
            let log = storage
                .create_log(&task.id, &task.name, &format!("Prompt {}", i), &task.engine_id)
                .unwrap();
            storage
                .update_log_complete(&log.id, None, Some(format!("Output {}", i)), None, None, 0, None)
                .unwrap();
        }

        // 分页获取
        let page1 = storage.get_logs_paginated(Some(&task.id), 1, 5).unwrap();
        assert_eq!(page1.logs.len(), 5);
        assert_eq!(page1.page, 1);
        assert_eq!(page1.total, 15);
        assert_eq!(page1.total_pages, 3);

        let page2 = storage.get_logs_paginated(Some(&task.id), 2, 5).unwrap();
        assert_eq!(page2.logs.len(), 5);
        assert_eq!(page2.page, 2);
    }

    #[test]
    fn test_log_cleanup() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Cleanup Test");
        let task = storage.create_task(params, None).unwrap();

        // 创建日志
        let log = storage
            .create_log(&task.id, &task.name, "Test", &task.engine_id)
            .unwrap();
        storage
            .update_log_complete(&log.id, None, Some("Output".to_string()), None, None, 0, None)
            .unwrap();

        // 删除单条日志
        let deleted = storage.delete_log(&log.id).unwrap();
        assert!(deleted);

        let logs = storage.get_task_logs(&task.id).unwrap();
        assert_eq!(logs.len(), 0);

        // 创建更多日志
        for i in 0..3 {
            let log = storage
                .create_log(&task.id, &task.name, &format!("Test {}", i), &task.engine_id)
                .unwrap();
            storage
                .update_log_complete(&log.id, None, None, None, None, 0, None)
                .unwrap();
        }

        // 清理任务日志
        let cleared = storage.clear_task_logs(&task.id).unwrap();
        assert_eq!(cleared, 3);
    }

    #[test]
    fn test_retention_config() {
        let (storage, _temp_dir) = create_test_storage();

        // 获取默认配置
        let default_config = storage.get_retention_config().unwrap();
        assert_eq!(default_config.retention_days, 30);

        // 更新配置
        let new_config = LogRetentionConfig {
            retention_days: 60,
            max_logs_per_task: 200,
            auto_cleanup_enabled: true,
            auto_cleanup_interval_hours: 48,
        };
        storage.update_retention_config(&new_config).unwrap();

        // 验证更新
        let updated = storage.get_retention_config().unwrap();
        assert_eq!(updated.retention_days, 60);
        assert_eq!(updated.max_logs_per_task, 200);
    }

    #[test]
    fn test_subscription() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Subscription Test");
        let task = storage.create_task(params, None).unwrap();

        // 设置订阅
        storage
            .set_subscription(&task.id, Some("context-789"))
            .unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.subscribed_context_id, Some("context-789".to_string()));

        // 取消订阅
        storage.set_subscription(&task.id, None).unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert!(retrieved.subscribed_context_id.is_none());
    }

    #[test]
    fn test_retry_mechanism() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建任务
        let params = create_test_task_params("Retry Test");
        let mut task = storage.create_task(params, None).unwrap();

        // 设置最大重试次数
        task.max_retries = Some(3);
        storage.update_task(&task).unwrap();

        // 第一次重试
        let can_retry = storage.update_retry_status(&task.id, 3, 60).unwrap();
        assert!(can_retry);

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.retry_count, 1);

        // 第二次重试
        let can_retry = storage.update_retry_status(&task.id, 3, 60).unwrap();
        assert!(can_retry);

        // 第三次重试
        let can_retry = storage.update_retry_status(&task.id, 3, 60).unwrap();
        assert!(can_retry);

        // 超过重试次数
        let can_retry = storage.update_retry_status(&task.id, 3, 60).unwrap();
        assert!(!can_retry);

        // 重置重试计数
        storage.reset_retry_count(&task.id).unwrap();

        let retrieved = storage.get_task(&task.id).unwrap().unwrap();
        assert_eq!(retrieved.retry_count, 0);
    }

    #[test]
    fn test_task_count_and_log_count() {
        let (storage, _temp_dir) = create_test_storage();

        // 初始计数
        assert_eq!(storage.task_count().unwrap(), 0);
        assert_eq!(storage.log_count().unwrap(), 0);

        // 创建任务
        let params = create_test_task_params("Count Test");
        let task = storage.create_task(params, None).unwrap();

        assert_eq!(storage.task_count().unwrap(), 1);

        // 创建日志
        let log = storage
            .create_log(&task.id, &task.name, "Test", &task.engine_id)
            .unwrap();
        storage
            .update_log_complete(&log.id, None, None, None, None, 0, None)
            .unwrap();

        assert_eq!(storage.log_count().unwrap(), 1);
    }

    #[test]
    fn test_get_pending_tasks() {
        let (storage, _temp_dir) = create_test_storage();

        // 创建已启用任务
        let params1 = create_test_task_params("Enabled Task");
        let _task1 = storage.create_task(params1, None).unwrap();

        // 创建已禁用任务
        let params2 = create_test_task_params("Disabled Task");
        let task2 = storage.create_task(params2, None).unwrap();
        storage.toggle_task(&task2.id, false, None).unwrap();

        // 注意：待执行任务需要 next_run_at 在过去时间
        // 由于测试环境中 next_run_at 是自动计算的，这里主要测试查询逻辑
        let pending = storage.get_pending_tasks().unwrap();
        // 结果取决于 next_run_at 的计算，这里只验证方法可以正常调用
        assert!(pending.is_empty() || pending.len() <= 1);
    }

    #[test]
    fn test_check_migration_needed() {
        let (storage, _temp_dir) = create_test_storage();

        // 在测试环境中，没有 JSON 文件，所以不需要迁移
        let needs_migration = storage.check_migration_needed();
        assert!(!needs_migration);
    }

    #[test]
    fn test_full_workflow() {
        let (storage, _temp_dir) = create_test_storage();

        // 1. 创建任务
        let params = create_test_task_params("Full Workflow Test");
        let task = storage.create_task(params, None).unwrap();

        // 2. 启用任务并设置下次执行时间
        storage.toggle_task(&task.id, true, Some(1700000000)).unwrap();

        // 3. 创建执行日志
        let log = storage
            .create_log(&task.id, &task.name, "Initial prompt", &task.engine_id)
            .unwrap();

        // 4. 更新会话 ID
        storage
            .update_conversation_session_id(&task.id, Some("session-workflow".to_string()))
            .unwrap();

        // 5. 完成日志
        storage
            .update_log_complete(
                &log.id,
                Some("session-workflow".to_string()),
                Some("Task output".to_string()),
                None,
                Some("Analysis complete".to_string()),
                10,
                Some(5000),
            )
            .unwrap();

        // 6. 更新运行状态
        storage
            .update_run_status(&task.id, TaskStatus::Success, true)
            .unwrap();

        // 7. 验证最终状态
        let final_task = storage.get_task(&task.id).unwrap().unwrap();
        assert!(final_task.enabled);
        assert_eq!(final_task.current_runs, 1);
        assert_eq!(
            final_task.conversation_session_id,
            Some("session-workflow".to_string())
        );
        assert_eq!(final_task.last_run_status, Some(TaskStatus::Success));

        // 8. 验证日志
        let logs = storage.get_task_logs(&task.id).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].tool_call_count, 10);
    }
}
