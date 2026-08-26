//! 代理层用量记录器
//!
//! 在代理转发 API 响应时拦截 usage 数据，写入独立 SQLite 表。
//! 覆盖所有经过代理的请求路径（UI 会话 / 调度任务 / 任何 CLI 客户端）。
//!
//! 数据模型：
//! ```sql
//! usage_logs (
//!   id              INTEGER PRIMARY KEY AUTOINCREMENT,
//!   model           TEXT NOT NULL,       -- 模型名（如 claude-sonnet-4-5）
//!   request_model   TEXT,                -- 请求侧模型名（中转站别名）
//!   engine_id       TEXT,                -- 引擎标识（claude/codex/simple-ai/pi）
//!   input_tokens    INTEGER NOT NULL DEFAULT 0,
//!   output_tokens   INTEGER NOT NULL DEFAULT 0,
//!   cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
//!   cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
//!   latency_ms      INTEGER NOT NULL DEFAULT 0,
//!   status_code     INTEGER NOT NULL DEFAULT 200,
//!   is_streaming    INTEGER NOT NULL DEFAULT 0,
//!   created_at      INTEGER NOT NULL     -- Unix 时间戳
//! );
//! ```

use crate::error::AppError;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 全局单例，供代理 handler 在没有 AppState 引用时记录用量
static USAGE_DB: OnceLock<UsageDb> = OnceLock::new();

// ============================================================================
// 单条用量记录
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogEntry {
    pub id: i64,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub latency_ms: i64,
    pub status_code: i64,
    pub is_streaming: bool,
    pub created_at: i64,
}

// ============================================================================
// 聚合查询结果
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_requests: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub total_cache_creation_tokens: i64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageStats {
    pub model: String,
    pub request_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsageStats {
    pub date: String,
    pub request_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_cost_usd: f64,
}

// ============================================================================
// 定价表（用于成本估算）
// ============================================================================

/// 每百万 token 成本（美元）。缺省值取自 Anthropic 官方定价。
const DEFAULT_INPUT_COST_PER_M: f64 = 3.0;
const DEFAULT_OUTPUT_COST_PER_M: f64 = 15.0;
const DEFAULT_CACHE_READ_COST_PER_M: f64 = 0.3;
const DEFAULT_CACHE_CREATION_COST_PER_M: f64 = 3.75;

/// 估算单次请求成本
fn estimate_cost(input: i64, output: i64, cache_read: i64, cache_creation: i64) -> f64 {
    let input_cost = input as f64 / 1_000_000.0 * DEFAULT_INPUT_COST_PER_M;
    let output_cost = output as f64 / 1_000_000.0 * DEFAULT_OUTPUT_COST_PER_M;
    let cache_read_cost = cache_read as f64 / 1_000_000.0 * DEFAULT_CACHE_READ_COST_PER_M;
    let cache_creation_cost = cache_creation as f64 / 1_000_000.0 * DEFAULT_CACHE_CREATION_COST_PER_M;
    input_cost + output_cost + cache_read_cost + cache_creation_cost
}

// ============================================================================
// 用量记录器
// ============================================================================

pub struct UsageDb {
    conn: Mutex<Connection>,
}

impl UsageDb {
    /// 创建或打开数据库
    pub fn open(db_path: PathBuf) -> Result<Self, AppError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::StateError(format!("创建用量目录失败: {}", e)))?;
        }
        let conn = Connection::open(&db_path)
            .map_err(|e| AppError::StateError(format!("打开用量数据库失败: {}", e)))?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS usage_logs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                model           TEXT NOT NULL,
                request_model   TEXT,
                input_tokens    INTEGER NOT NULL DEFAULT 0,
                output_tokens   INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                latency_ms      INTEGER NOT NULL DEFAULT 0,
                status_code     INTEGER NOT NULL DEFAULT 200,
                is_streaming    INTEGER NOT NULL DEFAULT 0,
                created_at      INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| AppError::StateError(format!("创建 usage_logs 表失败: {}", e)))?;

        // 索引：按时间查询
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at)",
            [],
        )
        .map_err(|e| AppError::StateError(format!("创建索引失败: {}", e)))?;

        // 索引：按模型查询
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON usage_logs(model)",
            [],
        )
        .map_err(|e| AppError::StateError(format!("创建模型索引失败: {}", e)))?;

        // 索引：按引擎查询
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_logs_engine ON usage_logs(engine_id)",
            [],
        );

        // 迁移：为旧表添加 engine_id 列（如果已存在则静默忽略）
        match conn.execute("ALTER TABLE usage_logs ADD COLUMN engine_id TEXT", []) {
            Ok(_) => tracing::info!("[UsageDb] 添加 engine_id 列成功"),
            Err(e) => {
                if !e.to_string().contains("duplicate column") {
                    tracing::warn!("[UsageDb] 添加 engine_id 列失败: {}", e);
                }
            }
        }

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 记录一次用量
    pub fn log_usage(
        &self,
        model: &str,
        request_model: Option<&str>,
        engine_id: Option<&str>,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
        latency_ms: i64,
        status_code: i64,
        is_streaming: bool,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| {
            AppError::StateError(format!("获取数据库锁失败: {}", e))
        })?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO usage_logs (model, request_model, engine_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, latency_ms, status_code, is_streaming, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                model,
                request_model,
                engine_id,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                latency_ms,
                status_code,
                is_streaming as i64,
                now,
            ],
        )
        .map_err(|e| AppError::StateError(format!("记录用量失败: {}", e)))?;
        Ok(())
    }

    /// 获取汇总统计
    pub fn get_summary(
        &self,
        start_date: Option<i64>,
        end_date: Option<i64>,
        model_filter: Option<&str>,
        engine_filter: Option<&str>,
    ) -> Result<UsageSummary, AppError> {
        let conn = self.conn.lock().map_err(|e| {
            AppError::StateError(format!("获取数据库锁失败: {}", e))
        })?;

        let (where_clause, param_values) = build_where_clause(start_date, end_date, model_filter, engine_filter);

        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_creation_tokens),0)
             FROM usage_logs{}",
            where_clause
        );

        let params: Vec<&dyn rusqlite::types::ToSql> = param_values
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();

        let result = conn
            .query_row(&sql, params.as_slice(), |row| {
                let total_requests: i64 = row.get(0)?;
                let total_input_tokens: i64 = row.get(1)?;
                let total_output_tokens: i64 = row.get(2)?;
                let total_cache_read_tokens: i64 = row.get(3)?;
                let total_cache_creation_tokens: i64 = row.get(4)?;
                let total_cost_usd = estimate_cost(
                    total_input_tokens,
                    total_output_tokens,
                    total_cache_read_tokens,
                    total_cache_creation_tokens,
                );
                Ok(UsageSummary {
                    total_requests,
                    total_input_tokens,
                    total_output_tokens,
                    total_cache_read_tokens,
                    total_cache_creation_tokens,
                    total_cost_usd,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询用量汇总失败: {}", e)))?;

        Ok(result)
    }

    /// 按模型分组统计
    pub fn get_model_stats(
        &self,
        start_date: Option<i64>,
        end_date: Option<i64>,
        engine_filter: Option<&str>,
    ) -> Result<Vec<ModelUsageStats>, AppError> {
        let conn = self.conn.lock().map_err(|e| {
            AppError::StateError(format!("获取数据库锁失败: {}", e))
        })?;

        let (where_clause, param_values) = build_where_clause(start_date, end_date, None, engine_filter);

        let sql = format!(
            "SELECT model, COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_creation_tokens),0)
             FROM usage_logs{}
             GROUP BY model
             ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC",
            where_clause
        );

        let params: Vec<&dyn rusqlite::types::ToSql> = param_values
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::StateError(format!("准备查询失败: {}", e)))?;

        let rows = stmt
            .query_map(params.as_slice(), |row| {
                let model: String = row.get(0)?;
                let request_count: i64 = row.get(1)?;
                let input_tokens: i64 = row.get(2)?;
                let output_tokens: i64 = row.get(3)?;
                let cache_read_tokens: i64 = row.get(4)?;
                let cache_creation_tokens: i64 = row.get(5)?;
                let total_cost_usd = estimate_cost(
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                );
                Ok(ModelUsageStats {
                    model,
                    request_count,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    total_cost_usd,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询模型统计失败: {}", e)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(
                row.map_err(|e| AppError::StateError(format!("读取模型统计行失败: {}", e)))?,
            );
        }
        Ok(result)
    }

    /// 按天统计趋势
    pub fn get_daily_trends(
        &self,
        start_date: Option<i64>,
        end_date: Option<i64>,
        model_filter: Option<&str>,
        engine_filter: Option<&str>,
    ) -> Result<Vec<DailyUsageStats>, AppError> {
        let conn = self.conn.lock().map_err(|e| {
            AppError::StateError(format!("获取数据库锁失败: {}", e))
        })?;

        let (where_clause, param_values) = build_where_clause(start_date, end_date, model_filter, engine_filter);

        // 按 LOCALTIME 分桶：created_at 是 UTC Unix 秒，DATE(ts,'unixepoch') 默认按 UTC 取日期，
        // UTC+8 下本地凌晨记录会落到前一个 UTC 日，导致"今天"查询出现"昨天"的桶。
        // 加 'localtime' 修饰让分桶对齐用户本地时区，与前端按本地时间解析出的筛选窗口一致。
        let sql = format!(
            "SELECT DATE(created_at, 'unixepoch', 'localtime') as day,
                    COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_creation_tokens),0)
             FROM usage_logs{}
             GROUP BY day
             ORDER BY day ASC",
            where_clause
        );

        let params: Vec<&dyn rusqlite::types::ToSql> = param_values
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::StateError(format!("准备趋势查询失败: {}", e)))?;

        let rows = stmt
            .query_map(params.as_slice(), |row| {
                let date: String = row.get(0)?;
                let request_count: i64 = row.get(1)?;
                let input_tokens: i64 = row.get(2)?;
                let output_tokens: i64 = row.get(3)?;
                let cache_read_tokens: i64 = row.get(4)?;
                let cache_creation_tokens: i64 = row.get(5)?;
                let total_cost_usd = estimate_cost(
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                );
                Ok(DailyUsageStats {
                    date,
                    request_count,
                    input_tokens,
                    output_tokens,
                    total_cost_usd,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询趋势失败: {}", e)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(
                row.map_err(|e| AppError::StateError(format!("读取趋势行失败: {}", e)))?,
            );
        }
        Ok(result)
    }

    /// 获取最近 N 条记录
    pub fn get_recent_logs(
        &self,
        limit: i64,
        offset: i64,
        start_date: Option<i64>,
        end_date: Option<i64>,
        model_filter: Option<&str>,
        engine_filter: Option<&str>,
    ) -> Result<Vec<UsageLogEntry>, AppError> {
        let conn = self.conn.lock().map_err(|e| {
            AppError::StateError(format!("获取数据库锁失败: {}", e))
        })?;

        let (where_clause, mut param_values) = build_where_clause(start_date, end_date, model_filter, engine_filter);
        param_values.push(Box::new(limit) as Box<dyn rusqlite::types::ToSql>);
        param_values.push(Box::new(offset) as Box<dyn rusqlite::types::ToSql>);

        let sql = format!(
            "SELECT id, model, request_model, engine_id, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens, latency_ms,
                    status_code, is_streaming, created_at
             FROM usage_logs{}
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?",
            where_clause
        );

        let params: Vec<&dyn rusqlite::types::ToSql> = param_values
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::StateError(format!("准备查询失败: {}", e)))?;

        let rows = stmt
            .query_map(params.as_slice(), |row| {
                Ok(UsageLogEntry {
                    id: row.get(0)?,
                    model: row.get(1)?,
                    request_model: row.get(2)?,
                    engine_id: row.get(3)?,
                    input_tokens: row.get(4)?,
                    output_tokens: row.get(5)?,
                    cache_read_tokens: row.get(6)?,
                    cache_creation_tokens: row.get(7)?,
                    latency_ms: row.get(8)?,
                    status_code: row.get(9)?,
                    is_streaming: row.get::<_, i64>(10)? != 0,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询记录失败: {}", e)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| AppError::StateError(format!("读取记录行失败: {}", e)))?);
        }
        Ok(result)
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 初始化全局单例（应用启动时调用）
pub fn init_usage_db(db: UsageDb) {
    let _ = USAGE_DB.set(db);
}

/// 获取全局单例引用
pub fn get_usage_db() -> Option<&'static UsageDb> {
    USAGE_DB.get()
}

/// 全局快捷记录用量（供代理 handler 调用，无需 AppState 引用）
pub fn record_usage(
    model: &str,
    request_model: Option<&str>,
    engine_id: Option<&str>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    latency_ms: i64,
    status_code: i64,
    is_streaming: bool,
) {
    if let Some(db) = USAGE_DB.get() {
        if let Err(e) = db.log_usage(
            model,
            request_model,
            engine_id,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            latency_ms,
            status_code,
            is_streaming,
        ) {
            tracing::warn!("[UsageDb] 记录用量失败: {}", e);
        } else {
            tracing::debug!(
                "[UsageDb] 记录用量成功: model={}, input={}, output={}",
                model, input_tokens, output_tokens
            );
        }
    } else {
        tracing::warn!(
            "[UsageDb] USAGE_DB 未初始化，跳过记录: model={}, input={}, output={}",
            model, input_tokens, output_tokens
        );
    }
}

/// 构建 WHERE 子句
fn build_where_clause(
    start_date: Option<i64>,
    end_date: Option<i64>,
    model_filter: Option<&str>,
    engine_filter: Option<&str>,
) -> (String, Vec<Box<dyn rusqlite::types::ToSql>>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(sd) = start_date {
        conditions.push("created_at >= ?".to_string());
        params.push(Box::new(sd));
    }
    if let Some(ed) = end_date {
        conditions.push("created_at <= ?".to_string());
        params.push(Box::new(ed));
    }
    if let Some(mf) = model_filter {
        conditions.push("model = ?".to_string());
        params.push(Box::new(mf.to_string()));
    }
    if let Some(ef) = engine_filter {
        conditions.push("engine_id = ?".to_string());
        params.push(Box::new(ef.to_string()));
    }

    if conditions.is_empty() {
        ("".to_string(), params)
    } else {
        (format!(" WHERE {}", conditions.join(" AND ")), params)
    }
}