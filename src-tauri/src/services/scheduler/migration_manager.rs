//! 存储迁移管理器
//!
//! 负责检测 JSON 数据文件并自动迁移到 SQLite
//! 迁移完成后备份原始 JSON 文件

use crate::error::{AppError, Result};
use crate::models::scheduler::{LogRetentionConfig, LogStore, ScheduledTask, TaskLog, TaskStore};
use crate::services::scheduler::sqlite_store::{MigrationResult, SqliteStore};
use std::path::PathBuf;

/// 迁移状态
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MigrationStatus {
    /// 是否已迁移
    pub migrated: bool,
    /// 迁移时间
    pub migrated_at: Option<i64>,
    /// 迁移的任务数量
    pub tasks_count: usize,
    /// 迁移的日志数量
    pub logs_count: usize,
    /// JSON 备份路径
    pub backup_path: Option<String>,
}

/// 迁移管理器
pub struct MigrationManager {
    /// 配置目录
    config_dir: PathBuf,
    /// 任务 JSON 文件路径
    tasks_json_path: PathBuf,
    /// 日志 JSON 文件路径
    logs_json_path: PathBuf,
    /// 迁移状态文件路径
    migration_status_path: PathBuf,
}

impl MigrationManager {
    /// 创建新的迁移管理器
    pub fn new() -> Result<Self> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| AppError::ConfigError("无法获取配置目录".to_string()))?
            .join("claude-code-pro");

        Ok(Self {
            tasks_json_path: config_dir.join("scheduler_tasks.json"),
            logs_json_path: config_dir.join("scheduler_logs.json"),
            migration_status_path: config_dir.join("migration_status.json"),
            config_dir,
        })
    }

    /// 检查是否需要迁移
    ///
    /// 条件：
    /// 1. 存在 JSON 数据文件（任务或日志）
    /// 2. 没有迁移状态记录
    pub fn needs_migration(&self) -> bool {
        // 如果已有迁移状态，不需要再迁移
        if self.migration_status_path.exists() {
            return false;
        }

        // 检查是否存在 JSON 数据
        self.tasks_json_path.exists() || self.logs_json_path.exists()
    }

    /// 获取迁移状态
    pub fn get_migration_status(&self) -> Option<MigrationStatus> {
        if !self.migration_status_path.exists() {
            return None;
        }

        let content = std::fs::read_to_string(&self.migration_status_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// 执行迁移
    ///
    /// 返回迁移结果
    pub fn migrate(&self, sqlite_store: &SqliteStore) -> Result<MigrationResult> {
        // 加载 JSON 数据
        let tasks = self.load_tasks()?;
        let logs = self.load_logs()?;
        let retention_config = self.load_retention_config()?;

        tracing::info!(
            "[Migration] 开始迁移: {} 个任务, {} 条日志",
            tasks.len(),
            logs.len()
        );

        // 执行迁移
        let result = sqlite_store.migrate_from_json(tasks.clone(), logs.clone(), &retention_config)?;

        // 备份 JSON 文件
        let backup_path = self.backup_json_files()?;

        // 记录迁移状态
        let status = MigrationStatus {
            migrated: true,
            migrated_at: Some(chrono::Utc::now().timestamp()),
            tasks_count: tasks.len(),
            logs_count: logs.len(),
            backup_path: Some(backup_path.to_string_lossy().to_string()),
        };

        self.save_migration_status(&status)?;

        tracing::info!(
            "[Migration] 迁移完成: 任务 {} (失败 {}), 日志 {} (失败 {})",
            result.tasks_migrated,
            result.tasks_failed,
            result.logs_migrated,
            result.logs_failed
        );

        Ok(result)
    }

    /// 加载任务数据
    fn load_tasks(&self) -> Result<Vec<ScheduledTask>> {
        if !self.tasks_json_path.exists() {
            return Ok(Vec::new());
        }

        let content = std::fs::read_to_string(&self.tasks_json_path)?;
        let store: TaskStore = serde_json::from_str(&content).unwrap_or_default();
        Ok(store.tasks)
    }

    /// 加载日志数据
    fn load_logs(&self) -> Result<Vec<TaskLog>> {
        if !self.logs_json_path.exists() {
            return Ok(Vec::new());
        }

        let content = std::fs::read_to_string(&self.logs_json_path)?;
        let store: LogStore = serde_json::from_str(&content).unwrap_or_default();

        // 合并所有日志
        let mut all_logs: Vec<TaskLog> = store.all_logs;
        for logs in store.logs.values() {
            for log in logs {
                // 避免重复（all_logs 可能已经包含）
                if !all_logs.iter().any(|l| l.id == log.id) {
                    all_logs.push(log.clone());
                }
            }
        }

        Ok(all_logs)
    }

    /// 加载日志保留配置
    fn load_retention_config(&self) -> Result<LogRetentionConfig> {
        if !self.logs_json_path.exists() {
            return Ok(LogRetentionConfig::default());
        }

        let content = std::fs::read_to_string(&self.logs_json_path)?;
        let store: LogStore = serde_json::from_str(&content).unwrap_or_default();
        Ok(store.retention_config)
    }

    /// 备份 JSON 文件
    fn backup_json_files(&self) -> Result<PathBuf> {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_dir = self.config_dir.join("migrations").join(timestamp.to_string());

        std::fs::create_dir_all(&backup_dir)?;

        // 备份任务文件
        if self.tasks_json_path.exists() {
            let backup_path = backup_dir.join("scheduler_tasks.json");
            std::fs::copy(&self.tasks_json_path, &backup_path)?;
            tracing::info!("[Migration] 已备份任务文件: {:?}", backup_path);
        }

        // 备份日志文件
        if self.logs_json_path.exists() {
            let backup_path = backup_dir.join("scheduler_logs.json");
            std::fs::copy(&self.logs_json_path, &backup_path)?;
            tracing::info!("[Migration] 已备份日志文件: {:?}", backup_path);
        }

        Ok(backup_dir)
    }

    /// 保存迁移状态
    fn save_migration_status(&self, status: &MigrationStatus) -> Result<()> {
        let content = serde_json::to_string_pretty(status)?;
        std::fs::write(&self.migration_status_path, content)?;
        Ok(())
    }

    /// 清理旧的 JSON 文件（迁移成功后可选调用）
    pub fn cleanup_json_files(&self) -> Result<()> {
        // 重命名而不是删除，确保安全
        if self.tasks_json_path.exists() {
            let renamed = self.tasks_json_path.with_extension("json.migrated");
            std::fs::rename(&self.tasks_json_path, &renamed)?;
            tracing::info!("[Migration] 已重命名任务文件: {:?}", renamed);
        }

        if self.logs_json_path.exists() {
            let renamed = self.logs_json_path.with_extension("json.migrated");
            std::fs::rename(&self.logs_json_path, &renamed)?;
            tracing::info!("[Migration] 已重命名日志文件: {:?}", renamed);
        }

        Ok(())
    }
}
