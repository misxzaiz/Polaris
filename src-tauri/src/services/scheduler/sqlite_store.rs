//! SQLite 存储层
//!
//! 使用 SQLite 替代 JSON 文件存储任务和日志数据
//! 支持更高效的查询和更可靠的数据持久化

use crate::error::{AppError, Result};
use crate::models::scheduler::{
    CreateTaskParams, ScheduledTask, TaskLog, TaskStatus, TriggerType,
    LogRetentionConfig, PaginatedLogs,
};
use crate::services::scheduler::ExecutionOutcome;
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use std::path::PathBuf;
use chrono::Utc;

/// SQLite 连接池类型别名
type SqlitePool = Pool<SqliteConnectionManager>;

/// SQLite 存储服务
pub struct SqliteStore {
    pool: SqlitePool,
    db_path: PathBuf,
}

impl SqliteStore {
    /// 创建新的 SQLite 存储服务
    pub fn new() -> Result<Self> {
        let store_dir = dirs::config_dir()
            .ok_or_else(|| AppError::ConfigError("无法获取配置目录".to_string()))?
            .join("claude-code-pro");

        // 确保目录存在
        std::fs::create_dir_all(&store_dir)?;

        let db_path = store_dir.join("scheduler.db");
        
        // 创建连接池
        let manager = SqliteConnectionManager::file(&db_path);
        let pool = Pool::new(manager)
            .map_err(|e| AppError::ConfigError(format!("无法创建数据库连接池: {}", e)))?;

        let store = Self { pool, db_path };
        
        // 初始化数据库 schema
        store.initialize_schema()?;

        Ok(store)
    }

    /// 获取数据库连接
    fn get_conn(&self) -> Result<PooledConnection<SqliteConnectionManager>> {
        self.pool.get()
            .map_err(|e| AppError::ConfigError(format!("无法获取数据库连接: {}", e)))
    }

    /// 初始化数据库 schema
    fn initialize_schema(&self) -> Result<()> {
        let conn = self.get_conn()?;

        // 启用外键约束
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;

        // 创建任务定义表
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                trigger_type TEXT NOT NULL,
                trigger_value TEXT NOT NULL,
                engine_id TEXT NOT NULL,
                prompt TEXT NOT NULL,
                work_dir TEXT,
                group_name TEXT,
                description TEXT,
                task_path TEXT,
                mission TEXT,
                max_runs INTEGER,
                reuse_session INTEGER NOT NULL DEFAULT 0,
                continue_immediately INTEGER NOT NULL DEFAULT 0,
                max_continuous_runs INTEGER,
                run_in_terminal INTEGER NOT NULL DEFAULT 0,
                template_id TEXT,
                template_param_values TEXT,
                max_retries INTEGER,
                retry_interval TEXT,
                notify_on_complete INTEGER NOT NULL DEFAULT 1,
                timeout_minutes INTEGER,
                user_supplement TEXT,
                task_template TEXT,
                memory_template TEXT,
                tasks_template TEXT,
                runs_template TEXT,
                supplement_template TEXT,
                protocol_version INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_enabled ON tasks(enabled);
            CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at) WHERE enabled = 1;
            CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_name);
            "#,
        )?;

        // 创建任务运行态表
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_runtime (
                task_id TEXT PRIMARY KEY,
                current_runs INTEGER NOT NULL DEFAULT 0,
                conversation_session_id TEXT,
                session_last_used_at INTEGER,
                last_run_at INTEGER,
                last_run_status TEXT,
                last_run_outcome TEXT,
                next_run_at INTEGER,
                subscribed_context_id TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                blocked INTEGER NOT NULL DEFAULT 0,
                blocked_reason TEXT,
                current_phase TEXT,
                last_effective_progress_at INTEGER,
                consecutive_no_progress_count INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_runtime_next_run ON task_runtime(next_run_at);
            "#,
        )?;

        // 创建执行日志表
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS logs (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                task_name TEXT NOT NULL,
                engine_id TEXT NOT NULL,
                session_id TEXT,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                duration_ms INTEGER,
                status TEXT NOT NULL,
                prompt TEXT NOT NULL,
                output TEXT,
                error TEXT,
                thinking_summary TEXT,
                tool_call_count INTEGER NOT NULL DEFAULT 0,
                token_count INTEGER,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id);
            CREATE INDEX IF NOT EXISTS idx_logs_started_at ON logs(started_at);
            CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status);
            "#,
        )?;

        // 创建日志保留配置表
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS log_retention_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                retention_days INTEGER NOT NULL DEFAULT 30,
                max_logs_per_task INTEGER NOT NULL DEFAULT 100,
                auto_cleanup_enabled INTEGER NOT NULL DEFAULT 1,
                auto_cleanup_interval_hours INTEGER NOT NULL DEFAULT 24,
                last_cleanup_at INTEGER
            );

            -- 插入默认配置
            INSERT OR IGNORE INTO log_retention_config (id) VALUES (1);
            "#,
        )?;

        // 创建迁移版本表
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY
            );

            INSERT OR IGNORE INTO schema_version (version) VALUES (1);
            "#,
        )?;

        tracing::info!("[SqliteStore] 数据库 schema 初始化完成: {:?}", self.db_path);
        Ok(())
    }

    /// 获取数据库路径
    pub fn db_path(&self) -> &PathBuf {
        &self.db_path
    }

    /// 检查数据库是否存在
    pub fn database_exists(&self) -> bool {
        self.db_path.exists()
    }

    /// 获取任务数量
    pub fn task_count(&self) -> Result<usize> {
        let conn = self.get_conn()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tasks",
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    /// 获取日志数量
    pub fn log_count(&self) -> Result<usize> {
        let conn = self.get_conn()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM logs",
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }
}

// ============================================================================
// 任务 CRUD 操作
// ============================================================================

impl SqliteStore {
    /// 获取所有任务
    pub fn get_all_tasks(&self) -> Result<Vec<ScheduledTask>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                t.id, t.name, t.enabled, t.trigger_type, t.trigger_value,
                t.engine_id, t.prompt, t.work_dir, t.group_name, t.description,
                t.task_path, t.mission, t.max_runs, t.reuse_session, t.continue_immediately,
                t.max_continuous_runs, t.run_in_terminal, t.template_id, t.template_param_values,
                t.max_retries, t.retry_interval, t.notify_on_complete, t.timeout_minutes,
                t.user_supplement, t.task_template, t.memory_template, t.tasks_template,
                t.runs_template, t.supplement_template, t.protocol_version,
                t.created_at, t.updated_at,
                tr.current_runs, tr.conversation_session_id, tr.session_last_used_at,
                tr.last_run_at, tr.last_run_status, tr.last_run_outcome, tr.next_run_at,
                tr.subscribed_context_id, tr.retry_count, tr.blocked, tr.blocked_reason,
                tr.current_phase, tr.last_effective_progress_at, tr.consecutive_no_progress_count
            FROM tasks t
            LEFT JOIN task_runtime tr ON t.id = tr.task_id
            ORDER BY t.created_at DESC
            "#,
        )?;

        let tasks = stmt.query_map([], |row| {
            Ok(Self::row_to_task(row))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(format!("查询任务失败: {}", e)))?;

        Ok(tasks)
    }

    /// 获取单个任务
    pub fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                t.id, t.name, t.enabled, t.trigger_type, t.trigger_value,
                t.engine_id, t.prompt, t.work_dir, t.group_name, t.description,
                t.task_path, t.mission, t.max_runs, t.reuse_session, t.continue_immediately,
                t.max_continuous_runs, t.run_in_terminal, t.template_id, t.template_param_values,
                t.max_retries, t.retry_interval, t.notify_on_complete, t.timeout_minutes,
                t.user_supplement, t.task_template, t.memory_template, t.tasks_template,
                t.runs_template, t.supplement_template, t.protocol_version,
                t.created_at, t.updated_at,
                tr.current_runs, tr.conversation_session_id, tr.session_last_used_at,
                tr.last_run_at, tr.last_run_status, tr.last_run_outcome, tr.next_run_at,
                tr.subscribed_context_id, tr.retry_count, tr.blocked, tr.blocked_reason,
                tr.current_phase, tr.last_effective_progress_at, tr.consecutive_no_progress_count
            FROM tasks t
            LEFT JOIN task_runtime tr ON t.id = tr.task_id
            WHERE t.id = ?
            "#,
        )?;

        let mut tasks = stmt.query_map([id], |row| {
            Ok(Self::row_to_task(row))
        })?;

        match tasks.next() {
            Some(task) => Ok(Some(task.map_err(|e| AppError::DatabaseError(format!("查询任务失败: {}", e)))?)),
            None => Ok(None),
        }
    }

    /// 将数据库行转换为 ScheduledTask
    fn row_to_task(row: &rusqlite::Row) -> ScheduledTask {
        // 辅助函数：获取 Option<i64> 并转换为 Option<u32>
        fn get_opt_u32(row: &rusqlite::Row, idx: usize) -> Option<u32> {
            row.get::<_, Option<i64>>(idx).ok().flatten().map(|v| v as u32)
        }

        // 辅助函数：获取 Option<String>
        fn get_opt_string(row: &rusqlite::Row, idx: usize) -> Option<String> {
            row.get::<_, Option<String>>(idx).ok().flatten()
        }

        // 辅助函数：获取 i64 并转换为 bool
        fn get_bool(row: &rusqlite::Row, idx: usize, default: bool) -> bool {
            row.get::<_, i64>(idx).map(|v| v != 0).unwrap_or(default)
        }

        ScheduledTask {
            id: row.get(0).unwrap_or_default(),
            name: row.get(1).unwrap_or_default(),
            enabled: get_bool(row, 2, false),
            trigger_type: Self::parse_trigger_type(&row.get::<_, String>(3).unwrap_or_default()),
            trigger_value: row.get(4).unwrap_or_default(),
            engine_id: row.get(5).unwrap_or_default(),
            prompt: row.get(6).unwrap_or_default(),
            work_dir: get_opt_string(row, 7),
            group: get_opt_string(row, 8),
            description: get_opt_string(row, 9),
            task_path: get_opt_string(row, 10),
            mission: get_opt_string(row, 11),
            max_runs: get_opt_u32(row, 12),
            reuse_session: get_bool(row, 13, false),
            continue_immediately: get_bool(row, 14, false),
            max_continuous_runs: get_opt_u32(row, 15),
            run_in_terminal: get_bool(row, 16, false),
            template_id: get_opt_string(row, 17),
            template_param_values: get_opt_string(row, 18)
                .and_then(|s| serde_json::from_str(&s).ok()),
            max_retries: get_opt_u32(row, 19),
            retry_interval: get_opt_string(row, 20),
            notify_on_complete: get_bool(row, 21, true),
            timeout_minutes: get_opt_u32(row, 22),
            user_supplement: get_opt_string(row, 23),
            task_template: get_opt_string(row, 24),
            memory_template: get_opt_string(row, 25),
            tasks_template: get_opt_string(row, 26),
            runs_template: get_opt_string(row, 27),
            supplement_template: get_opt_string(row, 28),
            protocol_version: get_opt_u32(row, 29),
            created_at: row.get(30).unwrap_or_default(),
            updated_at: row.get(31).unwrap_or_default(),
            // 运行态字段
            current_runs: row.get::<_, i64>(32).unwrap_or_default() as u32,
            conversation_session_id: get_opt_string(row, 33),
            session_last_used_at: row.get(34).ok(),
            last_run_at: row.get(35).ok(),
            last_run_status: get_opt_string(row, 36)
                .and_then(|s| Self::parse_task_status(&s)),
            last_run_outcome: get_opt_string(row, 37)
                .and_then(|s| Self::parse_execution_outcome(&s)),
            next_run_at: row.get(38).ok(),
            subscribed_context_id: get_opt_string(row, 39),
            retry_count: row.get::<_, i64>(40).unwrap_or_default() as u32,
            blocked: get_bool(row, 41, false),
            blocked_reason: get_opt_string(row, 42),
            current_phase: get_opt_string(row, 43),
            last_effective_progress_at: row.get(44).ok(),
            consecutive_no_progress_count: row.get::<_, i64>(45).unwrap_or_default() as u32,
        }
    }

    /// 解析触发类型
    fn parse_trigger_type(s: &str) -> TriggerType {
        match s.to_lowercase().as_str() {
            "once" => TriggerType::Once,
            "cron" => TriggerType::Cron,
            "interval" => TriggerType::Interval,
            _ => TriggerType::Once,
        }
    }

    /// 解析任务状态
    fn parse_task_status(s: &str) -> Option<TaskStatus> {
        match s.to_lowercase().as_str() {
            "running" => Some(TaskStatus::Running),
            "success" => Some(TaskStatus::Success),
            "failed" => Some(TaskStatus::Failed),
            _ => None,
        }
    }

    /// 解析执行结果类型
    fn parse_execution_outcome(s: &str) -> Option<ExecutionOutcome> {
        match s.to_lowercase().as_str() {
            "success_with_progress" => Some(ExecutionOutcome::SuccessWithProgress),
            "success_no_progress" => Some(ExecutionOutcome::SuccessNoProgress),
            "partial_success" => Some(ExecutionOutcome::PartialSuccess),
            "failed" => Some(ExecutionOutcome::Failed),
            "blocked" => Some(ExecutionOutcome::Blocked(String::new())),
            "consecutive_no_progress" => Some(ExecutionOutcome::ConsecutiveNoProgress(0)),
            _ => None,
        }
    }

    /// 创建任务
    pub fn create_task(&self, params: CreateTaskParams, task_path: Option<String>) -> Result<ScheduledTask> {
        let conn = self.get_conn()?;
        let now = Utc::now().timestamp();
        let id = uuid::Uuid::new_v4().to_string();

        let template_param_values = params.template_param_values.as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_default());

        // 插入任务定义
        conn.execute(
            r#"
            INSERT INTO tasks (
                id, name, enabled, trigger_type, trigger_value, engine_id, prompt,
                work_dir, group_name, description, task_path, mission, max_runs,
                reuse_session, continue_immediately, max_continuous_runs, run_in_terminal,
                template_id, template_param_values, max_retries, retry_interval,
                notify_on_complete, timeout_minutes, user_supplement, task_template,
                memory_template, tasks_template, runs_template, supplement_template,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)
            "#,
            params![
                id,
                params.name,
                params.enabled as i64,
                format!("{:?}", params.trigger_type).to_lowercase(),
                params.trigger_value,
                params.engine_id,
                params.prompt,
                params.work_dir,
                params.group,
                params.description,
                task_path,
                params.mission,
                params.max_runs.map(|v| v as i64),
                params.reuse_session as i64,
                params.continue_immediately as i64,
                params.max_continuous_runs.map(|v| v as i64),
                params.run_in_terminal as i64,
                params.template_id,
                template_param_values,
                params.max_retries.map(|v| v as i64),
                params.retry_interval,
                params.notify_on_complete as i64,
                params.timeout_minutes.map(|v| v as i64),
                params.user_supplement,
                params.task_template,
                params.memory_template,
                params.tasks_template,
                params.runs_template,
                params.supplement_template,
                now,
                now,
            ],
        )?;

        // 插入运行态
        conn.execute(
            r#"
            INSERT INTO task_runtime (task_id, current_runs, retry_count, blocked, consecutive_no_progress_count)
            VALUES (?1, 0, 0, 0, 0)
            "#,
            params![id],
        )?;

        // 计算下次执行时间
        let next_run_at = params.trigger_type.calculate_next_run(&params.trigger_value, now);
        if let Some(nra) = next_run_at {
            conn.execute(
                "UPDATE task_runtime SET next_run_at = ?1 WHERE task_id = ?2",
                params![nra, id],
            )?;
        }

        // 返回创建的任务
        self.get_task(&id)?.ok_or_else(|| AppError::DatabaseError("任务创建后未找到".to_string()))
    }

    /// 更新任务
    pub fn update_task(&self, task: &ScheduledTask) -> Result<()> {
        let conn = self.get_conn()?;
        let now = Utc::now().timestamp();

        let template_param_values = task.template_param_values.as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_default());

        // 更新任务定义
        conn.execute(
            r#"
            UPDATE tasks SET
                name = ?1, enabled = ?2, trigger_type = ?3, trigger_value = ?4,
                engine_id = ?5, prompt = ?6, work_dir = ?7, group_name = ?8,
                description = ?9, task_path = ?10, mission = ?11, max_runs = ?12,
                reuse_session = ?13, continue_immediately = ?14, max_continuous_runs = ?15,
                run_in_terminal = ?16, template_id = ?17, template_param_values = ?18,
                max_retries = ?19, retry_interval = ?20, notify_on_complete = ?21,
                timeout_minutes = ?22, user_supplement = ?23, task_template = ?24,
                memory_template = ?25, tasks_template = ?26, runs_template = ?27,
                supplement_template = ?28, protocol_version = ?29, updated_at = ?30
            WHERE id = ?31
            "#,
            params![
                task.name,
                task.enabled as i64,
                format!("{:?}", task.trigger_type).to_lowercase(),
                task.trigger_value,
                task.engine_id,
                task.prompt,
                task.work_dir,
                task.group,
                task.description,
                task.task_path,
                task.mission,
                task.max_runs.map(|v| v as i64),
                task.reuse_session as i64,
                task.continue_immediately as i64,
                task.max_continuous_runs.map(|v| v as i64),
                task.run_in_terminal as i64,
                task.template_id,
                template_param_values,
                task.max_retries.map(|v| v as i64),
                task.retry_interval,
                task.notify_on_complete as i64,
                task.timeout_minutes.map(|v| v as i64),
                task.user_supplement,
                task.task_template,
                task.memory_template,
                task.tasks_template,
                task.runs_template,
                task.supplement_template,
                task.protocol_version.map(|v| v as i64),
                now,
                task.id,
            ],
        )?;

        // 更新运行态
        conn.execute(
            r#"
            UPDATE task_runtime SET
                current_runs = ?1, conversation_session_id = ?2, session_last_used_at = ?3,
                last_run_at = ?4, last_run_status = ?5, last_run_outcome = ?6, next_run_at = ?7,
                subscribed_context_id = ?8, retry_count = ?9, blocked = ?10, blocked_reason = ?11,
                current_phase = ?12, last_effective_progress_at = ?13, consecutive_no_progress_count = ?14
            WHERE task_id = ?15
            "#,
            params![
                task.current_runs as i64,
                task.conversation_session_id,
                task.session_last_used_at,
                task.last_run_at,
                task.last_run_status.map(|s| format!("{:?}", s).to_lowercase()),
                task.last_run_outcome.as_ref().map(|o| format!("{:?}", o).to_lowercase().replace('_', "").replace("progress", "_progress")),
                task.next_run_at,
                task.subscribed_context_id,
                task.retry_count as i64,
                task.blocked as i64,
                task.blocked_reason,
                task.current_phase,
                task.last_effective_progress_at,
                task.consecutive_no_progress_count as i64,
                task.id,
            ],
        )?;

        Ok(())
    }

    /// 删除任务
    pub fn delete_task(&self, id: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 获取待执行的任务
    pub fn get_pending_tasks(&self) -> Result<Vec<ScheduledTask>> {
        let conn = self.get_conn()?;
        let now = Utc::now().timestamp();

        let mut stmt = conn.prepare(
            r#"
            SELECT 
                t.id, t.name, t.enabled, t.trigger_type, t.trigger_value,
                t.engine_id, t.prompt, t.work_dir, t.group_name, t.description,
                t.task_path, t.mission, t.max_runs, t.reuse_session, t.continue_immediately,
                t.max_continuous_runs, t.run_in_terminal, t.template_id, t.template_param_values,
                t.max_retries, t.retry_interval, t.notify_on_complete, t.timeout_minutes,
                t.user_supplement, t.task_template, t.memory_template, t.tasks_template,
                t.runs_template, t.supplement_template, t.protocol_version,
                t.created_at, t.updated_at,
                tr.current_runs, tr.conversation_session_id, tr.session_last_used_at,
                tr.last_run_at, tr.last_run_status, tr.last_run_outcome, tr.next_run_at,
                tr.subscribed_context_id, tr.retry_count, tr.blocked, tr.blocked_reason,
                tr.current_phase, tr.last_effective_progress_at, tr.consecutive_no_progress_count
            FROM tasks t
            JOIN task_runtime tr ON t.id = tr.task_id
            WHERE t.enabled = 1
            AND tr.next_run_at IS NOT NULL
            AND tr.next_run_at <= ?
            AND (t.max_runs IS NULL OR tr.current_runs < t.max_runs)
            ORDER BY tr.next_run_at ASC
            "#,
        )?;

        let tasks = stmt.query_map([now], |row| {
            Ok(Self::row_to_task(row))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(format!("查询待执行任务失败: {}", e)))?;

        Ok(tasks)
    }
}

// ============================================================================
// 日志 CRUD 操作
// ============================================================================

impl SqliteStore {
    /// 创建日志记录
    pub fn create_log(&self, task_id: &str, task_name: &str, prompt: &str, engine_id: &str) -> Result<TaskLog> {
        let conn = self.get_conn()?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();

        conn.execute(
            r#"
            INSERT INTO logs (id, task_id, task_name, engine_id, started_at, status, prompt, tool_call_count)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
            "#,
            params![
                id,
                task_id,
                task_name,
                engine_id,
                now,
                "running",
                prompt,
            ],
        )?;

        Ok(TaskLog {
            id,
            task_id: task_id.to_string(),
            task_name: task_name.to_string(),
            engine_id: engine_id.to_string(),
            session_id: None,
            started_at: now,
            finished_at: None,
            duration_ms: None,
            status: TaskStatus::Running,
            prompt: prompt.to_string(),
            output: None,
            error: None,
            thinking_summary: None,
            tool_call_count: 0,
            token_count: None,
        })
    }

    /// 更新日志（完成时）
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
        let conn = self.get_conn()?;
        
        let status = if error.is_some() { "failed" } else { "success" };
        let finished_at = Utc::now().timestamp();

        // 获取开始时间计算时长
        let started_at: Option<i64> = conn.query_row(
            "SELECT started_at FROM logs WHERE id = ?1",
            params![log_id],
            |row| row.get(0),
        ).ok();

        let duration_ms = started_at.map(|s| (finished_at - s) * 1000);

        // 截取输出
        let truncated_output = output.map(|o| {
            if o.len() > 2000 {
                format!("{}...\n[输出已截断，共 {} 字符]", 
                    &o[..o.char_indices().take(2000).last().map(|(i, _)| i).unwrap_or(0)], 
                    o.chars().count())
            } else {
                o
            }
        });

        // 截取思考摘要
        let truncated_thinking = thinking_summary.map(|t| {
            if t.len() > 500 {
                format!("{}...", &t[..t.char_indices().take(500).last().map(|(i, _)| i).unwrap_or(0)])
            } else {
                t
            }
        });

        conn.execute(
            r#"
            UPDATE logs SET
                session_id = ?1, finished_at = ?2, duration_ms = ?3, status = ?4,
                output = ?5, error = ?6, thinking_summary = ?7,
                tool_call_count = ?8, token_count = ?9
            WHERE id = ?10
            "#,
            params![
                session_id,
                finished_at,
                duration_ms,
                status,
                truncated_output,
                error,
                truncated_thinking,
                tool_call_count as i64,
                token_count.map(|v| v as i64),
                log_id,
            ],
        )?;

        Ok(())
    }

    /// 获取任务日志
    pub fn get_task_logs(&self, task_id: &str) -> Result<Vec<TaskLog>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, task_id, task_name, engine_id, session_id, started_at, finished_at,
                   duration_ms, status, prompt, output, error, thinking_summary,
                   tool_call_count, token_count
            FROM logs
            WHERE task_id = ?1
            ORDER BY started_at DESC
            "#,
        )?;

        let logs = stmt.query_map([task_id], |row| {
            Ok(TaskLog {
                id: row.get(0)?,
                task_id: row.get(1)?,
                task_name: row.get(2)?,
                engine_id: row.get(3)?,
                session_id: row.get(4)?,
                started_at: row.get(5)?,
                finished_at: row.get(6)?,
                duration_ms: row.get(7)?,
                status: Self::parse_task_status(&row.get::<_, String>(8).unwrap_or_default())
                    .unwrap_or(TaskStatus::Running),
                prompt: row.get(9)?,
                output: row.get(10)?,
                error: row.get(11)?,
                thinking_summary: row.get(12)?,
                tool_call_count: row.get::<_, i64>(13).unwrap_or_default() as u32,
                token_count: row.get::<_, Option<i64>>(14).ok().flatten().map(|v| v as u32),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(format!("查询日志失败: {}", e)))?;

        Ok(logs)
    }

    /// 获取所有日志
    pub fn get_all_logs(&self, limit: Option<usize>) -> Result<Vec<TaskLog>> {
        let conn = self.get_conn()?;
        let limit_clause = limit.map(|l| format!("LIMIT {}", l)).unwrap_or_default();

        let sql = format!(
            r#"
            SELECT id, task_id, task_name, engine_id, session_id, started_at, finished_at,
                   duration_ms, status, prompt, output, error, thinking_summary,
                   tool_call_count, token_count
            FROM logs
            ORDER BY started_at DESC
            {}
            "#,
            limit_clause
        );

        let mut stmt = conn.prepare(&sql)?;

        let logs = stmt.query_map([], |row| {
            Ok(TaskLog {
                id: row.get(0)?,
                task_id: row.get(1)?,
                task_name: row.get(2)?,
                engine_id: row.get(3)?,
                session_id: row.get(4)?,
                started_at: row.get(5)?,
                finished_at: row.get(6)?,
                duration_ms: row.get(7)?,
                status: Self::parse_task_status(&row.get::<_, String>(8).unwrap_or_default())
                    .unwrap_or(TaskStatus::Running),
                prompt: row.get(9)?,
                output: row.get(10)?,
                error: row.get(11)?,
                thinking_summary: row.get(12)?,
                tool_call_count: row.get::<_, i64>(13).unwrap_or_default() as u32,
                token_count: row.get::<_, Option<i64>>(14).ok().flatten().map(|v| v as u32),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(format!("查询日志失败: {}", e)))?;

        Ok(logs)
    }

    /// 分页获取日志
    pub fn get_logs_paginated(
        &self,
        task_id: Option<&str>,
        page: u32,
        page_size: u32,
    ) -> Result<PaginatedLogs> {
        let conn = self.get_conn()?;
        let page = page.max(1);
        let page_size = page_size.clamp(1, 100);
        let offset = (page - 1) * page_size;

        // 获取总数
        let total: i64 = if let Some(tid) = task_id {
            conn.query_row(
                "SELECT COUNT(*) FROM logs WHERE task_id = ?1",
                params![tid],
                |row| row.get(0),
            )?
        } else {
            conn.query_row("SELECT COUNT(*) FROM logs", [], |row| row.get(0))?
        };

        // 获取分页数据
        let sql = if let Some(tid) = task_id {
            format!(
                r#"
                SELECT id, task_id, task_name, engine_id, session_id, started_at, finished_at,
                       duration_ms, status, prompt, output, error, thinking_summary,
                       tool_call_count, token_count
                FROM logs
                WHERE task_id = ?
                ORDER BY started_at DESC
                LIMIT {} OFFSET {}
                "#,
                page_size, offset
            )
        } else {
            format!(
                r#"
                SELECT id, task_id, task_name, engine_id, session_id, started_at, finished_at,
                       duration_ms, status, prompt, output, error, thinking_summary,
                       tool_call_count, token_count
                FROM logs
                ORDER BY started_at DESC
                LIMIT {} OFFSET {}
                "#,
                page_size, offset
            )
        };

        let mut stmt = conn.prepare(&sql)?;

        let logs: Vec<TaskLog> = if let Some(tid) = task_id {
            stmt.query_map(params![tid], |row| {
                Ok(TaskLog {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    task_name: row.get(2)?,
                    engine_id: row.get(3)?,
                    session_id: row.get(4)?,
                    started_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    duration_ms: row.get(7)?,
                    status: Self::parse_task_status(&row.get::<_, String>(8).unwrap_or_default())
                        .unwrap_or(TaskStatus::Running),
                    prompt: row.get(9)?,
                    output: row.get(10)?,
                    error: row.get(11)?,
                    thinking_summary: row.get(12)?,
                    tool_call_count: row.get::<_, i64>(13).unwrap_or_default() as u32,
                    token_count: row.get::<_, Option<i64>>(14).ok().flatten().map(|v| v as u32),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([], |row| {
                Ok(TaskLog {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    task_name: row.get(2)?,
                    engine_id: row.get(3)?,
                    session_id: row.get(4)?,
                    started_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    duration_ms: row.get(7)?,
                    status: Self::parse_task_status(&row.get::<_, String>(8).unwrap_or_default())
                        .unwrap_or(TaskStatus::Running),
                    prompt: row.get(9)?,
                    output: row.get(10)?,
                    error: row.get(11)?,
                    thinking_summary: row.get(12)?,
                    tool_call_count: row.get::<_, i64>(13).unwrap_or_default() as u32,
                    token_count: row.get::<_, Option<i64>>(14).ok().flatten().map(|v| v as u32),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        };

        let total_pages = ((total as usize) + (page_size as usize) - 1) / (page_size as usize);

        Ok(PaginatedLogs {
            logs,
            total: total as usize,
            page,
            page_size,
            total_pages,
        })
    }

    /// 删除日志
    pub fn delete_log(&self, log_id: &str) -> Result<bool> {
        let conn = self.get_conn()?;
        let rows = conn.execute("DELETE FROM logs WHERE id = ?1", params![log_id])?;
        Ok(rows > 0)
    }

    /// 清理指定任务的所有日志
    pub fn clear_task_logs(&self, task_id: &str) -> Result<usize> {
        let conn = self.get_conn()?;
        let rows = conn.execute("DELETE FROM logs WHERE task_id = ?1", params![task_id])?;
        Ok(rows as usize)
    }

    /// 清理过期日志
    pub fn cleanup_expired_logs(&self, retention_days: u32) -> Result<usize> {
        if retention_days == 0 {
            return Ok(0);
        }

        let conn = self.get_conn()?;
        let cutoff_time = Utc::now().timestamp() - (retention_days as i64 * 24 * 60 * 60);

        let rows = conn.execute(
            "DELETE FROM logs WHERE started_at < ?1",
            params![cutoff_time],
        )?;

        // 更新清理时间
        conn.execute(
            "UPDATE log_retention_config SET last_cleanup_at = ?1 WHERE id = 1",
            params![Utc::now().timestamp()],
        )?;

        if rows > 0 {
            tracing::info!("[SqliteStore] 已清理 {} 条过期日志（保留 {} 天）", rows, retention_days);
        }

        Ok(rows as usize)
    }
}

// ============================================================================
// 运行态更新方法
// ============================================================================

impl SqliteStore {
    /// 更新任务会话 ID
    pub fn update_conversation_session_id(&self, id: &str, session_id: Option<String>) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET conversation_session_id = ?1, session_last_used_at = ?2 WHERE task_id = ?3",
            params![session_id, Utc::now().timestamp(), id],
        )?;
        Ok(())
    }

    /// 更新任务执行状态
    pub fn update_run_status(&self, id: &str, status: TaskStatus, increment_runs: bool) -> Result<()> {
        let conn = self.get_conn()?;
        let now = Utc::now().timestamp();

        if increment_runs {
            conn.execute(
                r#"
                UPDATE task_runtime SET
                    last_run_at = ?1,
                    last_run_status = ?2,
                    current_runs = current_runs + 1
                WHERE task_id = ?3
                "#,
                params![now, format!("{:?}", status).to_lowercase(), id],
            )?;
        } else {
            conn.execute(
                r#"
                UPDATE task_runtime SET
                    last_run_at = ?1,
                    last_run_status = ?2
                WHERE task_id = ?3
                "#,
                params![now, format!("{:?}", status).to_lowercase(), id],
            )?;
        }

        Ok(())
    }

    /// 更新任务上次执行结果类型
    pub fn update_last_run_outcome(&self, id: &str, outcome: ExecutionOutcome) -> Result<()> {
        let conn = self.get_conn()?;
        let outcome_str = match outcome {
            ExecutionOutcome::SuccessWithProgress => "success_with_progress",
            ExecutionOutcome::SuccessNoProgress => "success_no_progress",
            ExecutionOutcome::PartialSuccess => "partial_success",
            ExecutionOutcome::Failed => "failed",
            ExecutionOutcome::Blocked(_) => "blocked",
            ExecutionOutcome::ConsecutiveNoProgress(_) => "consecutive_no_progress",
        };
        conn.execute(
            "UPDATE task_runtime SET last_run_outcome = ?1 WHERE task_id = ?2",
            params![outcome_str, id],
        )?;
        Ok(())
    }

    /// 更新下次执行时间
    pub fn update_next_run_at(&self, id: &str, next_run_at: Option<i64>) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET next_run_at = ?1 WHERE task_id = ?2",
            params![next_run_at, id],
        )?;
        Ok(())
    }

    /// 切换任务启用状态
    pub fn toggle_task(&self, id: &str, enabled: bool, next_run_at: Option<i64>) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE tasks SET enabled = ?1 WHERE id = ?2",
            params![enabled as i64, id],
        )?;
        conn.execute(
            "UPDATE task_runtime SET next_run_at = ?1 WHERE task_id = ?2",
            params![next_run_at, id],
        )?;
        Ok(())
    }

    /// 重置任务会话
    pub fn reset_session(&self, id: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET conversation_session_id = NULL, session_last_used_at = NULL WHERE task_id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// 更新任务阻塞状态
    pub fn update_blocked_status(&self, id: &str, blocked: bool, reason: Option<String>) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET blocked = ?1, blocked_reason = ?2 WHERE task_id = ?3",
            params![blocked as i64, reason, id],
        )?;
        Ok(())
    }

    /// 更新任务当前阶段
    pub fn update_current_phase(&self, id: &str, phase: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET current_phase = ?1 WHERE task_id = ?2",
            params![phase, id],
        )?;
        Ok(())
    }

    /// 更新最近有效进展时间
    pub fn update_last_effective_progress(&self, id: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET last_effective_progress_at = ?1, consecutive_no_progress_count = 0 WHERE task_id = ?2",
            params![Utc::now().timestamp(), id],
        )?;
        Ok(())
    }

    /// 更新连续无进展计数
    pub fn update_consecutive_no_progress(&self, id: &str) -> Result<u32> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET consecutive_no_progress_count = consecutive_no_progress_count + 1 WHERE task_id = ?1",
            params![id],
        )?;

        let count: i64 = conn.query_row(
            "SELECT consecutive_no_progress_count FROM task_runtime WHERE task_id = ?1",
            params![id],
            |row| row.get(0),
        )?;

        Ok(count as u32)
    }

    /// 重置重试计数
    pub fn reset_retry_count(&self, id: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET retry_count = 0 WHERE task_id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// 更新重试状态
    pub fn update_retry_status(&self, id: &str, max_retries: u32, interval_secs: i64) -> Result<bool> {
        let conn = self.get_conn()?;

        // 获取当前重试计数
        let current_count: i64 = conn.query_row(
            "SELECT retry_count FROM task_runtime WHERE task_id = ?1",
            params![id],
            |row| row.get(0),
        )?;

        if current_count >= max_retries as i64 {
            return Ok(false);
        }

        let now = Utc::now().timestamp();
        let next_run_at = now + interval_secs;

        conn.execute(
            "UPDATE task_runtime SET retry_count = retry_count + 1, next_run_at = ?1 WHERE task_id = ?2",
            params![next_run_at, id],
        )?;

        Ok(true)
    }

    /// 设置订阅
    pub fn set_subscription(&self, id: &str, context_id: Option<&str>) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE task_runtime SET subscribed_context_id = ?1 WHERE task_id = ?2",
            params![context_id, id],
        )?;
        Ok(())
    }
}

// ============================================================================
// JSON 迁移
// ============================================================================

impl SqliteStore {
    /// 从 JSON 文件迁移数据到 SQLite
    pub fn migrate_from_json(&self, tasks: Vec<ScheduledTask>, logs: Vec<TaskLog>, retention_config: &LogRetentionConfig) -> Result<MigrationResult> {
        let mut conn = self.get_conn()?;
        let mut result = MigrationResult::default();

        // 开始事务
        let tx = conn.transaction()?;

        // 迁移任务
        for task in &tasks {
            let template_param_values = task.template_param_values.as_ref()
                .map(|v| serde_json::to_string(v).unwrap_or_default());

            // 插入任务定义
            match tx.execute(
                r#"
                INSERT OR REPLACE INTO tasks (
                    id, name, enabled, trigger_type, trigger_value, engine_id, prompt,
                    work_dir, group_name, description, task_path, mission, max_runs,
                    reuse_session, continue_immediately, max_continuous_runs, run_in_terminal,
                    template_id, template_param_values, max_retries, retry_interval,
                    notify_on_complete, timeout_minutes, user_supplement, task_template,
                    memory_template, tasks_template, runs_template, supplement_template,
                    protocol_version, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32)
                "#,
                params![
                    task.id,
                    task.name,
                    task.enabled as i64,
                    format!("{:?}", task.trigger_type).to_lowercase(),
                    task.trigger_value,
                    task.engine_id,
                    task.prompt,
                    task.work_dir,
                    task.group,
                    task.description,
                    task.task_path,
                    task.mission,
                    task.max_runs.map(|v| v as i64),
                    task.reuse_session as i64,
                    task.continue_immediately as i64,
                    task.max_continuous_runs.map(|v| v as i64),
                    task.run_in_terminal as i64,
                    task.template_id,
                    template_param_values,
                    task.max_retries.map(|v| v as i64),
                    task.retry_interval,
                    task.notify_on_complete as i64,
                    task.timeout_minutes.map(|v| v as i64),
                    task.user_supplement,
                    task.task_template,
                    task.memory_template,
                    task.tasks_template,
                    task.runs_template,
                    task.supplement_template,
                    task.protocol_version.map(|v| v as i64),
                    task.created_at,
                    task.updated_at,
                ],
            ) {
                Ok(_) => result.tasks_migrated += 1,
                Err(e) => {
                    tracing::warn!("[Migration] 迁移任务失败 {}: {}", task.id, e);
                    result.tasks_failed += 1;
                }
            }

            // 插入运行态
            let _ = tx.execute(
                r#"
                INSERT OR REPLACE INTO task_runtime (
                    task_id, current_runs, conversation_session_id, session_last_used_at,
                    last_run_at, last_run_status, last_run_outcome, next_run_at,
                    subscribed_context_id, retry_count, blocked, blocked_reason,
                    current_phase, last_effective_progress_at, consecutive_no_progress_count
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                "#,
                params![
                    task.id,
                    task.current_runs as i64,
                    task.conversation_session_id,
                    task.session_last_used_at,
                    task.last_run_at,
                    task.last_run_status.map(|s| format!("{:?}", s).to_lowercase()),
                    task.last_run_outcome.as_ref().map(|o| format!("{:?}", o).to_lowercase().replace('_', "").replace("progress", "_progress")),
                    task.next_run_at,
                    task.subscribed_context_id,
                    task.retry_count as i64,
                    task.blocked as i64,
                    task.blocked_reason,
                    task.current_phase,
                    task.last_effective_progress_at,
                    task.consecutive_no_progress_count as i64,
                ],
            );
        }

        // 迁移日志
        for log in &logs {
            match tx.execute(
                r#"
                INSERT OR REPLACE INTO logs (
                    id, task_id, task_name, engine_id, session_id, started_at, finished_at,
                    duration_ms, status, prompt, output, error, thinking_summary,
                    tool_call_count, token_count
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                "#,
                params![
                    log.id,
                    log.task_id,
                    log.task_name,
                    log.engine_id,
                    log.session_id,
                    log.started_at,
                    log.finished_at,
                    log.duration_ms,
                    format!("{:?}", log.status).to_lowercase(),
                    log.prompt,
                    log.output,
                    log.error,
                    log.thinking_summary,
                    log.tool_call_count as i64,
                    log.token_count.map(|v| v as i64),
                ],
            ) {
                Ok(_) => result.logs_migrated += 1,
                Err(e) => {
                    tracing::warn!("[Migration] 迁移日志失败 {}: {}", log.id, e);
                    result.logs_failed += 1;
                }
            }
        }

        // 更新保留配置
        let _ = tx.execute(
            r#"
            UPDATE log_retention_config SET
                retention_days = ?1,
                max_logs_per_task = ?2,
                auto_cleanup_enabled = ?3,
                auto_cleanup_interval_hours = ?4
            WHERE id = 1
            "#,
            params![
                retention_config.retention_days as i64,
                retention_config.max_logs_per_task as i64,
                retention_config.auto_cleanup_enabled as i64,
                retention_config.auto_cleanup_interval_hours as i64,
            ],
        );

        // 提交事务
        tx.commit()?;

        tracing::info!(
            "[Migration] 迁移完成: 任务 {} (失败 {}), 日志 {} (失败 {})",
            result.tasks_migrated, result.tasks_failed,
            result.logs_migrated, result.logs_failed
        );

        Ok(result)
    }

    /// 获取日志保留配置
    pub fn get_retention_config(&self) -> Result<LogRetentionConfig> {
        let conn = self.get_conn()?;
        let config = conn.query_row(
            r#"
            SELECT retention_days, max_logs_per_task, auto_cleanup_enabled,
                   auto_cleanup_interval_hours
            FROM log_retention_config WHERE id = 1
            "#,
            [],
            |row| {
                Ok(LogRetentionConfig {
                    retention_days: row.get::<_, i64>(0)? as u32,
                    max_logs_per_task: row.get::<_, i64>(1)? as u32,
                    auto_cleanup_enabled: row.get::<_, i64>(2)? != 0,
                    auto_cleanup_interval_hours: row.get::<_, i64>(3)? as u32,
                })
            },
        )?;

        Ok(config)
    }

    /// 更新日志保留配置
    pub fn update_retention_config(&self, config: &LogRetentionConfig) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            r#"
            UPDATE log_retention_config SET
                retention_days = ?1,
                max_logs_per_task = ?2,
                auto_cleanup_enabled = ?3,
                auto_cleanup_interval_hours = ?4
            WHERE id = 1
            "#,
            params![
                config.retention_days as i64,
                config.max_logs_per_task as i64,
                config.auto_cleanup_enabled as i64,
                config.auto_cleanup_interval_hours as i64,
            ],
        )?;
        Ok(())
    }
}

/// 迁移结果
#[derive(Debug, Default)]
pub struct MigrationResult {
    pub tasks_migrated: usize,
    pub tasks_failed: usize,
    pub logs_migrated: usize,
    pub logs_failed: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sqlite_store_creation() {
        // 使用内存数据库测试
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::new(manager).unwrap();
        
        // 验证连接池创建成功
        assert!(pool.get().is_ok());
    }
}
