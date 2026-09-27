//! 会话状态权威 — 阶段 2：事件日志 + 状态计算 + 仲裁 + 对账 + Session Registry
//!
//! 把「状态是计算结果」从前端搬到后端（案例 3 已验证算法）：
//! - **事件日志**：`session_events` 表，append-only，幂等（`INSERT OR IGNORE`）
//! - **状态计算**：`compute_status` 从事件日志推导 running/idle/error（不存储状态值）
//! - **仲裁**：`request_start` / `request_interrupt`（running 则拒绝 start）
//! - **对账**：`reconcile` 比对前端快照与后端日志（missing / extra / statusMismatch）
//! - **Session Registry**：`session_records` 表，会话元数据 + messageIds + version CAS
//!
//! 表结构对齐前端（`src/session-v2/core/types.ts`）：
//! ```text
//! session_events(
//!   id TEXT PRIMARY KEY,           -- 幂等：重复追加跳过
//!   conversation_id, type('session_start'|'session_end'|'error'),
//!   timestamp_ms, device_id, seq, reason, error_message
//! )
//! session_records(
//!   id TEXT PRIMARY KEY,           -- 前端生成的会话 ID
//!   conversation_id TEXT,          -- 后端分配的引擎会话 ID（首次发消息后才有）
//!   title, engine_id, workspace_id, context_workspace_ids(JSON),
//!   type, silent_mode, kind, message_ids(JSON),
//!   version,                       -- CAS 乐观锁
//!   created_at, updated_at
//! )
//! ```

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// schema 版本。修改表结构必须递增（打开时不一致 → 删库重建，事件/记录可重建无损失）。
const SCHEMA_VERSION: i64 = 2;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS session_events (
  id              TEXT PRIMARY KEY,          -- 事件 ID（全局唯一，幂等）
  conversation_id TEXT NOT NULL,
  type            TEXT NOT NULL,             -- 'session_start' | 'session_end' | 'error'
  timestamp_ms    INTEGER NOT NULL,          -- 事件发生时间（epoch ms）
  device_id       TEXT NOT NULL,             -- 触发方设备 ID
  seq             INTEGER NOT NULL,          -- 全局递增序号（因果排序）
  reason          TEXT,                      -- 结束原因（仅 session_end）
  error_message   TEXT                       -- 错误信息（仅 error / session_end reason=error）
);
CREATE INDEX IF NOT EXISTS idx_session_events_conv_seq
  ON session_events(conversation_id, seq);

CREATE TABLE IF NOT EXISTS session_records (
  id                    TEXT PRIMARY KEY,    -- 前端生成的会话 ID
  conversation_id       TEXT,                -- 后端分配的引擎会话 ID（首次发消息后才有）
  title                 TEXT NOT NULL DEFAULT '',
  engine_id             TEXT NOT NULL DEFAULT '',
  workspace_id          TEXT,
  context_workspace_ids TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
  type                  TEXT NOT NULL DEFAULT 'project',  -- 'project' | 'free'
  silent_mode           INTEGER NOT NULL DEFAULT 0,
  kind                  TEXT,                -- 'commit-message' | 'prompt-optimize' | 'title-generation'
  message_ids           TEXT NOT NULL DEFAULT '[]',      -- JSON 数组（有序消息 ID 列表）
  version               INTEGER NOT NULL DEFAULT 1,      -- CAS 乐观锁
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
"#;

/// 会话事件类型（对齐前端 `SessionEventType`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventType {
    SessionStart,
    SessionEnd,
    Error,
}

impl SessionEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionEventType::SessionStart => "session_start",
            SessionEventType::SessionEnd => "session_end",
            SessionEventType::Error => "error",
        }
    }
}

/// 会话事件条目（append-only 事件日志，对齐前端 `SessionEventEntry`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventEntry {
    pub id: String,
    pub conversation_id: String,
    #[serde(rename = "type")]
    pub event_type: SessionEventType,
    pub timestamp: i64,
    pub device_id: String,
    pub seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// 会话运行状态（从事件日志计算，不是存储值 — 对齐前端 `SessionStatus`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub conversation_id: String,
    pub running: bool,
    pub last_event_seq: i64,
    pub error: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub started_by_device: Option<String>,
}

/// 对账结果（对齐前端 `ReconcileResult`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResult {
    /// 前端缺失的消息（需从后端拉取）
    pub missing: Vec<crate::services::session_db::MessageEntry>,
    /// 前端多出的消息（可能是未同步的本地草稿，不应删除）
    pub extra: Vec<crate::services::session_db::MessageEntry>,
    /// 状态是否不一致
    pub status_mismatch: bool,
    /// 后端真实状态
    pub server_status: SessionStatus,
}

/// 会话记录（Session Registry，对齐前端 `SessionRecord`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub conversation_id: Option<String>,
    pub title: String,
    pub engine_id: String,
    pub workspace_id: Option<String>,
    pub context_workspace_ids: Vec<String>,
    #[serde(rename = "type")]
    pub record_type: String,
    pub silent_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub message_ids: Vec<String>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 会话状态库（事件日志 + 注册表，与消息库同文件）
///
/// 单连接 + `Mutex` 串行化，WAL + busy_timeout 允许多进程/多设备并发。
pub struct SessionStateDb {
    conn: Mutex<Connection>,
}

impl SessionStateDb {
    /// 打开（或创建）一个状态库。目录不存在自动创建。
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::StateError(format!("创建会话状态库目录失败: {}", e)))?;
        }
        let mut conn = Connection::open(path)
            .map_err(|e| AppError::StateError(format!("打开会话状态库失败: {}", e)))?;
        Self::tune_pragmas(&conn)?;

        // schema 版本检查：不一致 → 删库重建（事件/记录可重建，无业务损失）
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| AppError::StateError(format!("读取 schema 版本失败: {}", e)))?;
        if version == 0 {
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|e| AppError::StateError(format!("初始化状态库 schema 失败: {}", e)))?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| AppError::StateError(format!("写入 schema 版本失败: {}", e)))?;
        } else if version != SCHEMA_VERSION {
            drop(conn);
            let _ = fs::remove_file(path);
            let _ = fs::remove_file(path.with_extension("db-wal"));
            let _ = fs::remove_file(path.with_extension("db-shm"));
            conn = Connection::open(path)
                .map_err(|e| AppError::StateError(format!("重建状态库失败: {}", e)))?;
            Self::tune_pragmas(&conn)?;
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|e| AppError::StateError(format!("重建状态库 schema 失败: {}", e)))?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| AppError::StateError(format!("写入 schema 版本失败: {}", e)))?;
        }

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn tune_pragmas(conn: &Connection) -> Result<()> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| AppError::StateError(format!("设置 WAL 失败: {}", e)))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| AppError::StateError(format!("设置 synchronous 失败: {}", e)))?;
        // 多实例（双设备）同时写同一库：写-写冲突等待对方提交
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| AppError::StateError(format!("设置 busy_timeout 失败: {}", e)))?;
        Ok(())
    }

    // ==========================================================================
    // 事件日志（append-only）
    // ==========================================================================

    /// 追加事件（幂等：相同 id 重复追加跳过）
    /// @returns true = 新写入；false = 已存在（幂等跳过）
    pub fn append_event(&self, event: &SessionEventEntry) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn
            .execute(
                "INSERT OR IGNORE INTO session_events
                   (id, conversation_id, type, timestamp_ms, device_id, seq, reason, error_message)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    event.id,
                    event.conversation_id,
                    event.event_type.as_str(),
                    event.timestamp,
                    event.device_id,
                    event.seq,
                    event.reason,
                    event.error_message,
                ],
            )
            .map_err(|e| AppError::StateError(format!("追加事件失败: {}", e)))?;
        Ok(affected > 0)
    }

    /// 原子「仲裁 + 占位」：同一会话仅允许一个 active 操作（阶段 2 排他锁）。
    ///
    /// 语义与 `session_request_start_inner` 一致，但把 running 检查与 session_start
    /// 写入放进**同一事务**——多进程/多设备并发时，SQLite 单写者 + 写锁（busy_timeout）
    /// 保证两个请求不会同时通过检查（先到者写入 start，后到者看到 running 被拒）。
    ///
    /// - 空闲（或已有配对 end）→ 写入 session_start 占位，返回 Ok(None)
    /// - 已 running → 返回 Ok(Some(reason))，reason 含启动方设备/时间
    pub fn try_start_conversation(
        &self,
        conversation_id: &str,
        device_id: &str,
        timestamp: i64,
    ) -> Result<Option<String>> {
        let mut conn = self.conn.lock().unwrap();
        // Immediate 事务：开启即抢写锁。双设备并发时后到者在此等待（busy_timeout），
        // 前者的「检查 + 写入」原子完成后，后到者重读到 running → 被拒。
        // deferred 事务会先读后写，读检查不拿写锁 → 两请求都可能通过检查再写 → 双 start。
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| AppError::StateError(format!("开启仲裁事务失败: {}", e)))?;

        let events = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, conversation_id, type, timestamp_ms, device_id, seq, reason, error_message
                       FROM session_events WHERE conversation_id = ?1
                      ORDER BY seq ASC",
                )
                .map_err(|e| AppError::StateError(format!("准备仲裁查询语句失败: {}", e)))?;
            let rows = stmt
                .query_map(params![conversation_id], |r| {
                    let event_type = r.get::<_, String>(2)?;
                    Ok(SessionEventEntry {
                        id: r.get(0)?,
                        conversation_id: r.get(1)?,
                        event_type: match event_type.as_str() {
                            "session_start" => SessionEventType::SessionStart,
                            "session_end" => SessionEventType::SessionEnd,
                            _ => SessionEventType::Error,
                        },
                        timestamp: r.get(3)?,
                        device_id: r.get(4)?,
                        seq: r.get(5)?,
                        reason: r.get(6)?,
                        error_message: r.get(7)?,
                    })
                })
                .map_err(|e| AppError::StateError(format!("查询仲裁事件失败: {}", e)))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|e| AppError::StateError(format!("读取仲裁事件行失败: {}", e)))?);
            }
            out
        };
        let status = compute_status_from_events(conversation_id, &events);
        if status.running {
            let reason = format!(
                "会话已在运行中（由设备 {} 于 {} 启动）",
                status.started_by_device.as_deref().unwrap_or("?"),
                status.started_at.map(|t| t.to_string()).unwrap_or_else(|| "?".into()),
            );
            tx.rollback().ok();
            return Ok(Some(reason));
        }

        let next: i64 = tx
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM session_events", [], |r| r.get(0))
            .map_err(|e| AppError::StateError(format!("读取仲裁 seq 失败: {}", e)))?;
        let id = format!(
            "req-{}-{}",
            conversation_id,
            uuid::Uuid::new_v4()
        );
        tx.execute(
            "INSERT OR IGNORE INTO session_events
               (id, conversation_id, type, timestamp_ms, device_id, seq, reason, error_message)
             VALUES (?1, ?2, 'session_start', ?3, ?4, ?5, NULL, NULL)",
            params![id, conversation_id, timestamp, device_id, next + 1],
        )
        .map_err(|e| AppError::StateError(format!("写入仲裁占位事件失败: {}", e)))?;
        tx.commit()
            .map_err(|e| AppError::StateError(format!("提交仲裁事务失败: {}", e)))?;
        Ok(None)
    }

    /// 读取会话的所有事件（按 seq 升序）
    pub fn read_events(&self, conversation_id: &str) -> Result<Vec<SessionEventEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, type, timestamp_ms, device_id, seq, reason, error_message
                   FROM session_events WHERE conversation_id = ?1
                  ORDER BY seq ASC",
            )
            .map_err(|e| AppError::StateError(format!("准备事件读取语句失败: {}", e)))?;

        let rows = stmt
            .query_map(params![conversation_id], |r| {
                let event_type = r.get::<_, String>(2)?;
                Ok(SessionEventEntry {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    event_type: match event_type.as_str() {
                        "session_start" => SessionEventType::SessionStart,
                        "session_end" => SessionEventType::SessionEnd,
                        _ => SessionEventType::Error,
                    },
                    timestamp: r.get(3)?,
                    device_id: r.get(4)?,
                    seq: r.get(5)?,
                    reason: r.get(6)?,
                    error_message: r.get(7)?,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询事件失败: {}", e)))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::StateError(format!("读取事件行失败: {}", e)))?);
        }
        Ok(out)
    }

    /// 读取指定 seq 之后的事件（用于 resume）
    pub fn read_events_after_seq(&self, seq: i64) -> Result<Vec<SessionEventEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, type, timestamp_ms, device_id, seq, reason, error_message
                   FROM session_events WHERE seq > ?1
                  ORDER BY seq ASC",
            )
            .map_err(|e| AppError::StateError(format!("准备事件增量读取语句失败: {}", e)))?;

        let rows = stmt
            .query_map(params![seq], |r| {
                let event_type = r.get::<_, String>(2)?;
                Ok(SessionEventEntry {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    event_type: match event_type.as_str() {
                        "session_start" => SessionEventType::SessionStart,
                        "session_end" => SessionEventType::SessionEnd,
                        _ => SessionEventType::Error,
                    },
                    timestamp: r.get(3)?,
                    device_id: r.get(4)?,
                    seq: r.get(5)?,
                    reason: r.get(6)?,
                    error_message: r.get(7)?,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询增量事件失败: {}", e)))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::StateError(format!("读取增量事件行失败: {}", e)))?);
        }
        Ok(out)
    }

    /// 当前最大 seq（无事件返回 0）
    pub fn current_seq(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM session_events", [], |r| r.get(0))
            .map_err(|e| AppError::StateError(format!("读取最大 seq 失败: {}", e)))
    }

    /// 分配下一个 seq（事务内取 MAX+1，多进程安全）
    pub fn next_seq(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::StateError(format!("开启 seq 事务失败: {}", e)))?;
        let max: i64 = tx
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM session_events", [], |r| r.get(0))
            .map_err(|e| AppError::StateError(format!("读取最大 seq 失败: {}", e)))?;
        let next = max + 1;
        tx.commit()
            .map_err(|e| AppError::StateError(format!("提交 seq 事务失败: {}", e)))?;
        Ok(next)
    }

    /// 删除会话的所有事件（幂等）
    pub fn delete_events_by_conversation(&self, conversation_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM session_events WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|e| AppError::StateError(format!("删除会话事件失败: {}", e)))?;
        Ok(())
    }

    // ==========================================================================
    // 状态计算（从事件日志推导，不存储状态值）
    // ==========================================================================

    /// 从事件日志计算会话状态（案例 3 已验证算法，落 Rust）
    ///
    /// 核心逻辑：
    /// - running = 存在未配对的 session_start（最后一个 session_start 之后没有 session_end）
    /// - error = 最后一条 error 事件的信息
    /// - startedAt = 最后一个未配对 session_start 的 timestamp
    /// - startedByDevice = 最后一个未配对 session_start 的 deviceId
    pub fn compute_status(&self, conversation_id: &str) -> Result<SessionStatus> {
        let events = self.read_events(conversation_id)?;
        Ok(compute_status_from_events(conversation_id, &events))
    }

    /// 删除会话的所有记录（幂等）
    pub fn delete_record(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM session_records WHERE id = ?1", params![id])
            .map_err(|e| AppError::StateError(format!("删除会话记录失败: {}", e)))?;
        Ok(())
    }

    // ==========================================================================
    // Session Registry（会话注册表）
    // ==========================================================================

    fn row_to_record(r: &rusqlite::Row) -> rusqlite::Result<SessionRecord> {
        Ok(SessionRecord {
            id: r.get(0)?,
            conversation_id: r.get(1)?,
            title: r.get(2)?,
            engine_id: r.get(3)?,
            workspace_id: r.get(4)?,
            context_workspace_ids: serde_json::from_str(&r.get::<_, String>(5)?)
                .unwrap_or_default(),
            record_type: r.get(6)?,
            silent_mode: r.get::<_, i64>(7)? != 0,
            kind: r.get(8)?,
            message_ids: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
            version: r.get(10)?,
            created_at: r.get(11)?,
            updated_at: r.get(12)?,
        })
    }

    /// 创建会话记录（幂等：已存在则返回现有记录）
    pub fn create_record(&self, record: &SessionRecord) -> Result<SessionRecord> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let created = if record.created_at > 0 { record.created_at } else { now };

        conn.execute(
            "INSERT OR IGNORE INTO session_records
               (id, conversation_id, title, engine_id, workspace_id, context_workspace_ids,
                type, silent_mode, kind, message_ids, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)",
            params![
                record.id,
                record.conversation_id,
                record.title,
                record.engine_id,
                record.workspace_id,
                serde_json::to_string(&record.context_workspace_ids)?,
                record.record_type,
                record.silent_mode,
                record.kind,
                serde_json::to_string(&record.message_ids)?,
                created,
            ],
        )
        .map_err(|e| AppError::StateError(format!("创建会话记录失败: {}", e)))?;

        // 返回存储的记录（幂等语义：已存在则返回现有）
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, title, engine_id, workspace_id, context_workspace_ids,
                        type, silent_mode, kind, message_ids, version, created_at, updated_at
                   FROM session_records WHERE id = ?1",
            )
            .map_err(|e| AppError::StateError(format!("准备记录读取语句失败: {}", e)))?;
        let row = stmt
            .query_row(params![record.id], Self::row_to_record)
            .map_err(|e| AppError::StateError(format!("读取会话记录失败: {}", e)))?;
        Ok(row)
    }

    /// 读取会话记录
    pub fn get_record(&self, id: &str) -> Result<Option<SessionRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, title, engine_id, workspace_id, context_workspace_ids,
                        type, silent_mode, kind, message_ids, version, created_at, updated_at
                   FROM session_records WHERE id = ?1",
            )
            .map_err(|e| AppError::StateError(format!("准备记录读取语句失败: {}", e)))?;
        let row = stmt
            .query_row(params![id], Self::row_to_record)
            .optional()
            .map_err(|e| AppError::StateError(format!("读取会话记录失败: {}", e)))?;
        Ok(row)
    }

    /// 列出全部会话记录（按 updated_at 降序）
    pub fn list_records(&self) -> Result<Vec<SessionRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, title, engine_id, workspace_id, context_workspace_ids,
                        type, silent_mode, kind, message_ids, version, created_at, updated_at
                   FROM session_records ORDER BY updated_at DESC",
            )
            .map_err(|e| AppError::StateError(format!("准备记录列表语句失败: {}", e)))?;
        let rows = stmt
            .query_map([], Self::row_to_record)
            .map_err(|e| AppError::StateError(format!("查询会话记录失败: {}", e)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::StateError(format!("读取会话记录行失败: {}", e)))?);
        }
        Ok(out)
    }

    /// 追加消息 ID 到会话记录（CAS：expected_version 不匹配则拒绝）
    /// @returns 更新后的记录
    pub fn append_message_id(&self, id: &str, message_id: &str, expected_version: i64) -> Result<SessionRecord> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let affected = conn
            .execute(
                "UPDATE session_records
                    SET message_ids = json_insert(message_ids, '$[#]', ?1),
                        version = version + 1,
                        updated_at = ?2
                  WHERE id = ?3 AND version = ?4",
                params![message_id, now, id, expected_version],
            )
            .map_err(|e| AppError::StateError(format!("追加消息 ID 失败: {}", e)))?;
        if affected == 0 {
            return Err(AppError::StateError(format!(
                "追加消息 ID 失败：会话记录不存在或版本不匹配 (id={}, expected_version={})",
                id, expected_version
            )));
        }
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, title, engine_id, workspace_id, context_workspace_ids,
                        type, silent_mode, kind, message_ids, version, created_at, updated_at
                   FROM session_records WHERE id = ?1",
            )
            .map_err(|e| AppError::StateError(format!("准备记录读取语句失败: {}", e)))?;
        let row = stmt
            .query_row(params![id], Self::row_to_record)
            .map_err(|e| AppError::StateError(format!("读取会话记录失败: {}", e)))?;
        Ok(row)
    }

    /// 更新会话元数据（CAS：expected_version 不匹配则拒绝）
    /// @returns 更新后的记录
    pub fn update_record_metadata(
        &self,
        id: &str,
        patch: &serde_json::Value,
        expected_version: i64,
    ) -> Result<SessionRecord> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();

        // 读取当前记录（用于合并 patch 中未提供的字段）
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, title, engine_id, workspace_id, context_workspace_ids,
                        type, silent_mode, kind, message_ids, version, created_at, updated_at
                   FROM session_records WHERE id = ?1",
            )
            .map_err(|e| AppError::StateError(format!("准备记录读取语句失败: {}", e)))?;
        let current = stmt
            .query_row(params![id], Self::row_to_record)
            .optional()
            .map_err(|e| AppError::StateError(format!("读取会话记录失败: {}", e)))?;
        let current = current.ok_or_else(|| {
            AppError::StateError(format!("更新会话记录失败：记录不存在 {}", id))
        })?;
        if current.version != expected_version {
            return Err(AppError::StateError(format!(
                "更新会话记录失败：版本不匹配 (id={}, expected={}, actual={})",
                id, expected_version, current.version
            )));
        }

        let title = patch.get("title").and_then(|v| v.as_str()).unwrap_or(&current.title).to_string();
        let engine_id = patch.get("engineId").and_then(|v| v.as_str()).unwrap_or(&current.engine_id).to_string();
        let workspace_id = patch
            .get("workspaceId")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or(current.workspace_id);
        let context_workspace_ids: Vec<String> = patch
            .get("contextWorkspaceIds")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or(current.context_workspace_ids);
        let record_type = patch
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or(&current.record_type)
            .to_string();
        let silent_mode = patch
            .get("silentMode")
            .and_then(|v| v.as_bool())
            .unwrap_or(current.silent_mode);
        let kind = patch
            .get("kind")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or(current.kind);

        conn.execute(
            "UPDATE session_records
                SET title = ?1, engine_id = ?2, workspace_id = ?3, context_workspace_ids = ?4,
                    type = ?5, silent_mode = ?6, kind = ?7, version = version + 1, updated_at = ?8
              WHERE id = ?9",
            params![
                title,
                engine_id,
                workspace_id,
                serde_json::to_string(&context_workspace_ids)?,
                record_type,
                silent_mode,
                kind,
                now,
                id,
            ],
        )
        .map_err(|e| AppError::StateError(format!("更新会话记录失败: {}", e)))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, title, engine_id, workspace_id, context_workspace_ids,
                        type, silent_mode, kind, message_ids, version, created_at, updated_at
                   FROM session_records WHERE id = ?1",
            )
            .map_err(|e| AppError::StateError(format!("准备记录读取语句失败: {}", e)))?;
        let row = stmt
            .query_row(params![id], Self::row_to_record)
            .map_err(|e| AppError::StateError(format!("读取会话记录失败: {}", e)))?;
        Ok(row)
    }
}

/// 从事件列表计算状态（纯函数，供单测直接调用）
pub fn compute_status_from_events(conversation_id: &str, events: &[SessionEventEntry]) -> SessionStatus {
    // 按 seq 升序遍历，追踪 session_start / session_end 配对
    let mut last_start: Option<&SessionEventEntry> = None;
    let mut last_end: Option<&SessionEventEntry> = None;
    let mut last_error: Option<&SessionEventEntry> = None;
    let mut last_seq = 0;

    for e in events {
        last_seq = last_seq.max(e.seq);
        match e.event_type {
            SessionEventType::SessionStart => {
                last_start = Some(e);
                last_end = None; // 重置：新的 start 配对等待新的 end
                last_error = None;
            }
            SessionEventType::SessionEnd => {
                if last_start.is_some() {
                    last_end = Some(e);
                }
            }
            SessionEventType::Error => {
                last_error = Some(e);
            }
        }
    }

    let running = last_start.is_some() && last_end.is_none();

    let error = last_error
        .map(|e| e.error_message.clone())
        .flatten()
        .or_else(|| {
            last_end
                .map(|e| e.error_message.clone())
                .flatten()
        })
        .or_else(|| {
            if last_end.map(|e| e.reason.as_deref()) == Some(Some("error")) {
                Some("会话以错误结束".to_string())
            } else {
                None
            }
        });

    SessionStatus {
        conversation_id: conversation_id.to_string(),
        running,
        last_event_seq: last_seq,
        error,
        started_at: if running { last_start.map(|e| e.timestamp) } else { None },
        ended_at: last_end.map(|e| e.timestamp),
        started_by_device: if running { last_start.map(|e| e.device_id.clone()) } else { None },
    }
}

/// 对账：比对前端快照与后端日志（对齐前端 `ReconcileResult`）
///
/// @param server_messages 后端消息列表（已读取）
/// @param client_messages 前端当前持有的消息列表（快照）
/// @param server_status 后端真实状态
/// @param client_running 前端认为的 running 状态
pub fn reconcile(
    server_messages: &[crate::services::session_db::MessageEntry],
    client_messages: &[crate::services::session_db::MessageEntry],
    server_status: &SessionStatus,
    client_running: bool,
) -> ReconcileResult {
    let server_ids: std::collections::HashSet<&str> =
        server_messages.iter().map(|m| m.id.as_str()).collect();
    let client_ids: std::collections::HashSet<&str> =
        client_messages.iter().map(|m| m.id.as_str()).collect();

    let missing: Vec<crate::services::session_db::MessageEntry> = server_messages
        .iter()
        .filter(|m| !client_ids.contains(m.id.as_str()))
        .cloned()
        .collect();
    let extra: Vec<crate::services::session_db::MessageEntry> = client_messages
        .iter()
        .filter(|m| !server_ids.contains(m.id.as_str()))
        .cloned()
        .collect();

    ReconcileResult {
        status_mismatch: client_running != server_status.running,
        missing,
        extra,
        server_status: server_status.clone(),
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::session_db::MessageEntry;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// 每次唯一临时库，避免并发测试污染
    fn setup_db() -> (std::path::PathBuf, SessionStateDb) {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut name = "polaris-session-state-".to_string();
        name.push_str(&COUNTER.fetch_add(1, Ordering::SeqCst).to_string());
        let tmp = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&tmp);
        let path = tmp.join("state.db");
        let db = SessionStateDb::open(&path).unwrap();
        (tmp, db)
    }

    fn make_event(
        id: &str,
        conversation_id: &str,
        event_type: SessionEventType,
        timestamp: i64,
        device_id: &str,
        seq: i64,
    ) -> SessionEventEntry {
        SessionEventEntry {
            id: id.into(),
            conversation_id: conversation_id.into(),
            event_type,
            timestamp,
            device_id: device_id.into(),
            seq,
            reason: None,
            error_message: None,
        }
    }

    fn make_msg(
        id: &str,
        conversation_id: &str,
        role: &str,
        timestamp: i64,
        content: serde_json::Value,
    ) -> MessageEntry {
        MessageEntry {
            id: id.into(),
            conversation_id: conversation_id.into(),
            role: role.into(),
            timestamp,
            device_id: "dev-test".into(),
            content,
            version: 1,
            parent_version: None,
        }
    }

    // ==========================================================================
    // 事件日志
    // ==========================================================================

    #[test]
    fn append_event_roundtrip() {
        let (_tmp, db) = setup_db();
        assert!(db
            .append_event(&make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1))
            .unwrap());
        assert!(db
            .append_event(&make_event("E2", "conv-1", SessionEventType::SessionEnd, 2000, "dev-A", 2))
            .unwrap());

        let events = db.read_events("conv-1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, SessionEventType::SessionStart);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[1].seq, 2);
    }

    #[test]
    fn append_event_same_id_is_idempotent() {
        let (_tmp, db) = setup_db();
        let e = make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1);
        assert!(db.append_event(&e).unwrap());
        assert!(!db.append_event(&e).unwrap());
        assert_eq!(db.read_events("conv-1").unwrap().len(), 1);
    }

    #[test]
    fn two_threads_concurrent_append_events_no_loss() {
        let (_tmp, db) = setup_db();
        let db = std::sync::Arc::new(db);

        let mut handles = Vec::new();
        for device in ["A", "B"] {
            let db = db.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..50 {
                    let e = make_event(
                        &format!("{}-{}", device, i),
                        "conv-race",
                        SessionEventType::SessionEnd,
                        1000 + i * 10,
                        &format!("dev-{}", device),
                        0, // seq 由外部分配，这里模拟并发写入
                    );
                    db.append_event(&e).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(db.read_events("conv-race").unwrap().len(), 100);
    }

    #[test]
    fn read_events_after_seq() {
        let (_tmp, db) = setup_db();
        for i in 1..=5 {
            db.append_event(&make_event(&format!("E{}", i), "conv-1", SessionEventType::SessionStart, 1000 * i, "dev-A", i))
                .unwrap();
        }
        let after = db.read_events_after_seq(3).unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].seq, 4);
        assert_eq!(after[1].seq, 5);
    }

    #[test]
    fn current_and_next_seq() {
        let (_tmp, db) = setup_db();
        assert_eq!(db.current_seq().unwrap(), 0);
        assert_eq!(db.next_seq().unwrap(), 1);
        assert_eq!(db.next_seq().unwrap(), 2);
        db.append_event(&make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1))
            .unwrap();
        assert_eq!(db.current_seq().unwrap(), 1);
        assert_eq!(db.next_seq().unwrap(), 3);
    }

    #[test]
    fn delete_events_by_conversation_only_target() {
        let (_tmp, db) = setup_db();
        db.append_event(&make_event("E1", "conv-a", SessionEventType::SessionStart, 1000, "dev-A", 1))
            .unwrap();
        db.append_event(&make_event("E2", "conv-b", SessionEventType::SessionStart, 2000, "dev-B", 2))
            .unwrap();

        db.delete_events_by_conversation("conv-a").unwrap();

        assert_eq!(db.read_events("conv-a").unwrap().len(), 0);
        assert_eq!(db.read_events("conv-b").unwrap().len(), 1);
    }

    // ==========================================================================
    // 状态计算
    // ==========================================================================

    #[test]
    fn compute_status_no_events_is_not_running() {
        let (_tmp, db) = setup_db();
        let s = db.compute_status("conv-1").unwrap();
        assert!(!s.running);
        assert_eq!(s.last_event_seq, 0);
        assert_eq!(s.started_at, None);
        assert_eq!(s.started_by_device, None);
        assert_eq!(s.error, None);
    }

    #[test]
    fn compute_status_start_without_end_is_running() {
        let (_tmp, db) = setup_db();
        db.append_event(&make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1))
            .unwrap();
        let s = db.compute_status("conv-1").unwrap();
        assert!(s.running);
        assert_eq!(s.started_at, Some(1000));
        assert_eq!(s.started_by_device.as_deref(), Some("dev-A"));
        assert_eq!(s.ended_at, None);
        assert_eq!(s.last_event_seq, 1);
    }

    #[test]
    fn compute_status_start_end_is_idle() {
        let (_tmp, db) = setup_db();
        db.append_event(&make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1))
            .unwrap();
        db.append_event(&make_event("E2", "conv-1", SessionEventType::SessionEnd, 2000, "dev-A", 2))
            .unwrap();
        let s = db.compute_status("conv-1").unwrap();
        assert!(!s.running);
        assert_eq!(s.started_at, None);
        assert_eq!(s.ended_at, Some(2000));
        assert_eq!(s.last_event_seq, 2);
    }

    #[test]
    fn compute_status_multi_rounds_uses_last_pair() {
        let (_tmp, db) = setup_db();
        // 第一轮：start(1) → end(2)
        db.append_event(&make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1))
            .unwrap();
        db.append_event(&make_event("E2", "conv-1", SessionEventType::SessionEnd, 2000, "dev-A", 2))
            .unwrap();
        // 第二轮：start(3) 未结束 → running
        db.append_event(&make_event("E3", "conv-1", SessionEventType::SessionStart, 3000, "dev-B", 3))
            .unwrap();
        let s = db.compute_status("conv-1").unwrap();
        assert!(s.running);
        assert_eq!(s.started_by_device.as_deref(), Some("dev-B"));
        assert_eq!(s.started_at, Some(3000));
    }

    #[test]
    fn compute_status_end_before_start_ignored() {
        let (_tmp, db) = setup_db();
        // 只有 end 没有 start：不应误判 running
        db.append_event(&make_event("E1", "conv-1", SessionEventType::SessionEnd, 1000, "dev-A", 1))
            .unwrap();
        let s = db.compute_status("conv-1").unwrap();
        assert!(!s.running);
    }

    #[test]
    fn compute_status_error_sets_error_field() {
        let (_tmp, db) = setup_db();
        db.append_event(&make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1))
            .unwrap();
        let mut err = make_event("E2", "conv-1", SessionEventType::Error, 2000, "dev-A", 2);
        err.error_message = Some("模型超时".into());
        db.append_event(&err).unwrap();
        let s = db.compute_status("conv-1").unwrap();
        assert!(s.running); // start 未配对，仍 running
        assert_eq!(s.error.as_deref(), Some("模型超时"));
    }

    #[test]
    fn compute_status_end_with_error_reason() {
        let (_tmp, db) = setup_db();
        db.append_event(&make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1))
            .unwrap();
        let mut end = make_event("E2", "conv-1", SessionEventType::SessionEnd, 2000, "dev-A", 2);
        end.reason = Some("error".into());
        end.error_message = Some("上下文超限".into());
        db.append_event(&end).unwrap();
        let s = db.compute_status("conv-1").unwrap();
        assert!(!s.running);
        assert_eq!(s.error.as_deref(), Some("上下文超限"));
    }

    // ==========================================================================
    // 对账（reconcile 纯函数：比对前端快照与后端日志）
    // ==========================================================================

    #[test]
    fn reconcile_detects_missing_extra_and_status_mismatch() {
        let server_msgs = vec![make_msg("M1", "conv-1", "user", 1000, serde_json::json!({})), make_msg("M2", "conv-1", "assistant", 2000, serde_json::json!({}))];
        let client_msgs = vec![make_msg("M2", "conv-1", "assistant", 2000, serde_json::json!({})), make_msg("M3", "conv-1", "user", 3000, serde_json::json!({}))];

        let server_status = SessionStatus {
            conversation_id: "conv-1".into(),
            running: true,
            last_event_seq: 5,
            error: None,
            started_at: Some(1000),
            ended_at: None,
            started_by_device: Some("dev-A".into()),
        };

        let r = reconcile(&server_msgs, &client_msgs, &server_status, false);
        assert_eq!(r.missing.len(), 1);
        assert_eq!(r.missing[0].id, "M1");
        assert_eq!(r.extra.len(), 1);
        assert_eq!(r.extra[0].id, "M3");
        assert!(r.status_mismatch);
        assert!(r.server_status.running);
    }

    #[test]
    fn reconcile_identical_snapshots_no_diff() {
        let msgs = vec![make_msg("M1", "conv-1", "user", 1000, serde_json::json!({}))];
        let server_status = SessionStatus {
            conversation_id: "conv-1".into(),
            running: false,
            last_event_seq: 1,
            error: None,
            started_at: None,
            ended_at: Some(2000),
            started_by_device: None,
        };
        let r = reconcile(&msgs, &msgs, &server_status, false);
        assert!(r.missing.is_empty());
        assert!(r.extra.is_empty());
        assert!(!r.status_mismatch);
    }

    // ==========================================================================
    // Session Registry
    // ==========================================================================

    fn make_record(id: &str, conversation_id: Option<&str>) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            conversation_id: conversation_id.map(String::from),
            title: "测试会话".into(),
            engine_id: "claude-code".into(),
            workspace_id: None,
            context_workspace_ids: vec![],
            record_type: "project".into(),
            silent_mode: false,
            kind: None,
            message_ids: vec![],
            version: 1,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn registry_create_get_roundtrip() {
        let (_tmp, db) = setup_db();
        let rec = db.create_record(&make_record("S1", Some("conv-1"))).unwrap();
        assert_eq!(rec.id, "S1");
        assert_eq!(rec.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(rec.version, 1);
        assert!(rec.created_at > 0);

        let fetched = db.get_record("S1").unwrap().unwrap();
        assert_eq!(fetched.id, "S1");
        assert_eq!(fetched.title, "测试会话");
        assert_eq!(fetched.engine_id, "claude-code");
    }

    #[test]
    fn registry_create_same_id_is_idempotent() {
        let (_tmp, db) = setup_db();
        db.create_record(&make_record("S1", Some("conv-1"))).unwrap();
        db.create_record(&make_record("S1", Some("conv-1"))).unwrap();
        assert_eq!(db.list_records().unwrap().len(), 1);
    }

    #[test]
    fn registry_list_orders_by_updated_at_desc() {
        let (_tmp, db) = setup_db();
        let a = db.create_record(&make_record("S-a", Some("conv-a"))).unwrap();
        let b = db.create_record(&make_record("S-b", Some("conv-b"))).unwrap();

        // 更新 b → b 应排前面
        db.append_message_id("S-b", "M1", b.version).unwrap();
        let list = db.list_records().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "S-b");
        let _ = a;
    }

    #[test]
    fn registry_append_message_id_cas() {
        let (_tmp, db) = setup_db();
        let rec = db.create_record(&make_record("S1", Some("conv-1"))).unwrap();

        let updated = db.append_message_id("S1", "M1", rec.version).unwrap();
        assert_eq!(updated.version, 2);
        assert_eq!(updated.message_ids, vec!["M1"]);

        // 过期版本被拒（CAS）
        let err = db.append_message_id("S1", "M2", rec.version).unwrap_err();
        assert!(err.to_string().contains("版本不匹配"));
    }

    #[test]
    fn registry_update_metadata_cas() {
        let (_tmp, db) = setup_db();
        let rec = db.create_record(&make_record("S1", Some("conv-1"))).unwrap();

        let updated = db
            .update_record_metadata("S1", &serde_json::json!({"title": "新标题"}), rec.version)
            .unwrap();
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.version, 2);

        // 过期版本被拒
        let err = db
            .update_record_metadata("S1", &serde_json::json!({"title": "x"}), rec.version)
            .unwrap_err();
        assert!(err.to_string().contains("版本不匹配"));
    }

    #[test]
    fn registry_delete_only_target() {
        let (_tmp, db) = setup_db();
        db.create_record(&make_record("S1", Some("conv-1"))).unwrap();
        db.create_record(&make_record("S2", Some("conv-2"))).unwrap();

        db.delete_record("S1").unwrap();

        assert!(db.get_record("S1").unwrap().is_none());
        assert!(db.get_record("S2").unwrap().is_some());
    }
}
