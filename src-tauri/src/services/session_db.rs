//! 会话消息 SQLite 存储 — 阶段 1：Append-Only Message Log
//!
//! 验证假设 1 的后端侧（规划 `04` 案例 1 层 2）：
//! - **幂等 append**：`INSERT OR IGNORE`，同 `(id, version)` 重复写入不报错不重复
//! - **修订链**：`revise` 追加新版本，旧版本保留（消息不可变）
//! - **并发安全**：WAL + `busy_timeout` + 单连接 `Mutex` 串行化，两线程并发写不丢失
//!
//! 表结构对齐前端 `MessageEntry`（`src/session-v2/core/types.ts`）：
//! ```text
//! session_messages(
//!   id, conversation_id, role, timestamp_ms, device_id,
//!   content(JSON), version, parent_version,
//!   PRIMARY KEY (id, version)   -- 版本链在同一主键下
//! )
//! ```
//!
//! `read` 语义与 `InMemoryMessageLog` 一致：按 `conversation_id` 读取每消息**最新版本**，
//! 按 `timestamp_ms` 升序，支持 `after_timestamp` 增量与 `limit` 分页。

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// schema 版本。修改表结构必须递增（打开时不一致 → 删库重建，消息日志可重建无损失）。
const SCHEMA_VERSION: i64 = 1;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS session_messages (
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,          -- 'user' | 'assistant' | 'system'
  timestamp_ms    INTEGER NOT NULL,       -- 创建方时间戳（epoch ms），用于因果序
  device_id       TEXT NOT NULL,          -- 创建方设备标识
  content         TEXT NOT NULL,          -- 完整消息内容 JSON
  version         INTEGER NOT NULL DEFAULT 1,
  parent_version  INTEGER,                -- 修订前版本号（链式修订）
  PRIMARY KEY (id, version)               -- 幂等：同 id+version 重复插入跳过
);
CREATE INDEX IF NOT EXISTS idx_session_messages_conv
  ON session_messages(conversation_id, timestamp_ms);
"#;

/// 消息条目（对齐前端 `MessageEntry`，camelCase 透传）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageEntry {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub timestamp: i64,
    pub device_id: String,
    pub content: serde_json::Value,
    pub version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_version: Option<i64>,
}

/// 会话消息库
///
/// 单连接 + `Mutex` 串行化（Phase 0/1 足够；写放大低，瓶颈在流式高频 revise，
/// 但每次 revise 是单行 INSERT，量级为毫秒内）。WAL 允许多进程/多设备读写并发。
pub struct SessionMessageDb {
    conn: Mutex<Connection>,
}

impl SessionMessageDb {
    /// 打开（或创建）一个消息库。目录不存在自动创建。
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::StateError(format!("创建消息库目录失败: {}", e)))?;
        }
        let mut conn = Connection::open(path)
            .map_err(|e| AppError::StateError(format!("打开会话消息库失败: {}", e)))?;
        Self::tune_pragmas(&conn)?;

        // schema 版本检查：不一致 → 删库重建（消息日志可重建，无业务损失）
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| AppError::StateError(format!("读取 schema 版本失败: {}", e)))?;
        if version == 0 {
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|e| AppError::StateError(format!("初始化消息库 schema 失败: {}", e)))?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| AppError::StateError(format!("写入 schema 版本失败: {}", e)))?;
        } else if version != SCHEMA_VERSION {
            drop(conn);
            let _ = fs::remove_file(path);
            let _ = fs::remove_file(path.with_extension("db-wal"));
            let _ = fs::remove_file(path.with_extension("db-shm"));
            conn = Connection::open(path)
                .map_err(|e| AppError::StateError(format!("重建消息库失败: {}", e)))?;
            Self::tune_pragmas(&conn)?;
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|e| AppError::StateError(format!("重建消息库 schema 失败: {}", e)))?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| AppError::StateError(format!("写入 schema 版本失败: {}", e)))?;
        }

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn tune_pragmas(conn: &Connection) -> Result<()> {
        // busy_timeout 必须先于 journal_mode=WAL 设置：WAL 切换需独占锁，
        // 多连接/多进程并发首次 open（双设备冷启动）时后到者靠 busy 等待
        // 拿锁（否则直接报 database is locked）。
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| AppError::StateError(format!("设置 busy_timeout 失败: {}", e)))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| AppError::StateError(format!("设置 WAL 失败: {}", e)))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| AppError::StateError(format!("设置 synchronous 失败: {}", e)))?;
        Ok(())
    }

    /// 追加消息（幂等：同 `(id, version)` 重复追加跳过）
    /// @returns true = 新写入；false = 已存在（幂等跳过）
    pub fn append(&self, entry: &MessageEntry) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn
            .execute(
                "INSERT OR IGNORE INTO session_messages
                   (id, conversation_id, role, timestamp_ms, device_id, content, version, parent_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    entry.id,
                    entry.conversation_id,
                    entry.role,
                    entry.timestamp,
                    entry.device_id,
                    serde_json::to_string(&entry.content)?,
                    entry.version,
                    entry.parent_version,
                ],
            )
            .map_err(|e| AppError::StateError(format!("追加消息失败: {}", e)))?;
        Ok(affected > 0)
    }

    /// 修订消息（追加新版本，旧版本保留）
    /// @returns 新版本号
    pub fn revise(&self, id: &str, new_content: serde_json::Value) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::StateError(format!("开启修订事务失败: {}", e)))?;

        // 读取最新版本（同 id 中 version 最大）
        let latest: Option<(i64, i64, String, String, String)> = tx
            .query_row(
                "SELECT version, timestamp_ms, conversation_id, role, device_id
                   FROM session_messages WHERE id = ?1
                   ORDER BY version DESC LIMIT 1",
                params![id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| AppError::StateError(format!("读取消息最新版本失败: {}", e)))?;

        let (version, timestamp, conversation_id, role, device_id) = latest
            .ok_or_else(|| AppError::StateError(format!("修订失败：消息不存在 {}", id)))?;
        let new_version = version + 1;

        tx.execute(
            "INSERT INTO session_messages
               (id, conversation_id, role, timestamp_ms, device_id, content, version, parent_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                conversation_id,
                role,
                timestamp,
                device_id,
                serde_json::to_string(&new_content)?,
                new_version,
                version,
            ],
        )
        .map_err(|e| AppError::StateError(format!("写入修订失败: {}", e)))?;

        tx.commit()
            .map_err(|e| AppError::StateError(format!("提交修订失败: {}", e)))?;
        Ok(new_version)
    }

    /// 读取会话消息（每消息最新版本，按 timestamp 升序）
    pub fn read(
        &self,
        conversation_id: &str,
        after_timestamp: Option<i64>,
        limit: Option<i64>,
    ) -> Result<Vec<MessageEntry>> {
        let conn = self.conn.lock().unwrap();
        // LIMIT 传 -1 表示不限制（SQLite 语义）
        let limit = limit.unwrap_or(-1);
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.conversation_id, m.role, m.timestamp_ms, m.device_id,
                        m.content, m.version, m.parent_version
                   FROM session_messages m
                   JOIN (SELECT id, MAX(version) AS v FROM session_messages
                          WHERE conversation_id = ?1 GROUP BY id) t
                     ON m.id = t.id AND m.version = t.v
                  WHERE m.conversation_id = ?1
                    AND (?2 IS NULL OR m.timestamp_ms > ?2)
                  ORDER BY m.timestamp_ms ASC
                  LIMIT ?3",
            )
            .map_err(|e| AppError::StateError(format!("准备读取语句失败: {}", e)))?;

        let rows = stmt
            .query_map(params![conversation_id, after_timestamp, limit], |r| {
                Ok(MessageEntry {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    role: r.get(2)?,
                    timestamp: r.get(3)?,
                    device_id: r.get(4)?,
                    content: serde_json::from_str(&r.get::<_, String>(5)?)
                        .unwrap_or(serde_json::Value::Null),
                    version: r.get(6)?,
                    parent_version: r.get(7)?,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询消息失败: {}", e)))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::StateError(format!("读取消息行失败: {}", e)))?);
        }
        Ok(out)
    }

    /// 读取消息完整修订历史（按 version 升序）
    pub fn read_history(&self, id: &str) -> Result<Vec<MessageEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, role, timestamp_ms, device_id,
                        content, version, parent_version
                   FROM session_messages WHERE id = ?1
                  ORDER BY version ASC",
            )
            .map_err(|e| AppError::StateError(format!("准备历史读取语句失败: {}", e)))?;

        let rows = stmt
            .query_map(params![id], |r| {
                Ok(MessageEntry {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    role: r.get(2)?,
                    timestamp: r.get(3)?,
                    device_id: r.get(4)?,
                    content: serde_json::from_str(&r.get::<_, String>(5)?)
                        .unwrap_or(serde_json::Value::Null),
                    version: r.get(6)?,
                    parent_version: r.get(7)?,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询修订历史失败: {}", e)))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::StateError(format!("读取修订行失败: {}", e)))?);
        }
        Ok(out)
    }

    /// 读取消息最新版本
    pub fn get_latest(&self, id: &str) -> Result<Option<MessageEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, role, timestamp_ms, device_id,
                        content, version, parent_version
                   FROM session_messages WHERE id = ?1
                  ORDER BY version DESC LIMIT 1",
            )
            .map_err(|e| AppError::StateError(format!("准备最新版本读取语句失败: {}", e)))?;

        let mut rows = stmt
            .query_map(params![id], |r| {
                Ok(MessageEntry {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    role: r.get(2)?,
                    timestamp: r.get(3)?,
                    device_id: r.get(4)?,
                    content: serde_json::from_str(&r.get::<_, String>(5)?)
                        .unwrap_or(serde_json::Value::Null),
                    version: r.get(6)?,
                    parent_version: r.get(7)?,
                })
            })
            .map_err(|e| AppError::StateError(format!("查询最新版本失败: {}", e)))?;

        rows.next()
            .map(|r| r.map_err(|e| AppError::StateError(format!("读取最新版本行失败: {}", e))))
            .transpose()
    }

    /// 删除会话的所有消息（幂等）
    pub fn delete_by_conversation(&self, conversation_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM session_messages WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|e| AppError::StateError(format!("删除会话消息失败: {}", e)))?;
        Ok(())
    }

    /// 当前消息总数（测试辅助 + 审计）
    pub fn count(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM session_messages", [], |r| r.get(0))
            .map_err(|e| AppError::StateError(format!("统计消息失败: {}", e)))
    }

    /// 某会话消息数（测试辅助）
    pub fn conversation_count(&self, conversation_id: &str) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM session_messages WHERE conversation_id = ?1",
            params![conversation_id],
            |r| r.get(0),
        )
        .map_err(|e| AppError::StateError(format!("统计会话消息失败: {}", e)))
    }
}

// ============================================================================
// 层 2 验证：SQLite append-only Message Log
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// 每次唯一临时库，避免并发测试污染
    fn setup_db() -> (std::path::PathBuf, SessionMessageDb) {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut name = "polaris-session-db-".to_string();
        name.push_str(&COUNTER.fetch_add(1, Ordering::SeqCst).to_string());
        let tmp = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&tmp);
        let path = tmp.join("session.db");
        let db = SessionMessageDb::open(&path).unwrap();
        (tmp, db)
    }

    fn make_entry(
        id: &str,
        conversation_id: &str,
        role: &str,
        timestamp: i64,
        device_id: &str,
        content: serde_json::Value,
    ) -> MessageEntry {
        MessageEntry {
            id: id.into(),
            conversation_id: conversation_id.into(),
            role: role.into(),
            timestamp,
            device_id: device_id.into(),
            content,
            version: 1,
            parent_version: None,
        }
    }

    // ==========================================================================
    // 幂等 append
    // ==========================================================================

    #[test]
    fn append_then_read_roundtrip() {
        let (_tmp, db) = setup_db();
        db.append(&make_entry("M1", "conv-1", "user", 1000, "dev-A", serde_json::json!({"text": "你好"})))
            .unwrap();
        db.append(&make_entry("M2", "conv-1", "assistant", 2000, "dev-A", serde_json::json!({"text": "回复"})))
            .unwrap();

        let msgs = db.read("conv-1", None, None).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "M1");
        assert_eq!(msgs[0].content["text"], "你好");
        assert_eq!(msgs[1].id, "M2");
        assert_eq!(msgs[0].timestamp, 1000);
        assert_eq!(msgs[1].timestamp, 2000);
    }

    #[test]
    fn append_same_id_version_is_idempotent() {
        let (_tmp, db) = setup_db();
        let entry = make_entry("M1", "conv-1", "user", 1000, "dev-A", serde_json::json!({"text": "a"}));
        assert!(db.append(&entry).unwrap());
        // 相同 id+version 重复追加 → 幂等跳过
        assert!(!db.append(&entry).unwrap());

        assert_eq!(db.conversation_count("conv-1").unwrap(), 1);
        let msgs = db.read("conv-1", None, None).unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn two_threads_concurrent_append_no_loss() {
        let (_tmp, db) = setup_db();
        let db = std::sync::Arc::new(db);

        let mut handles = Vec::new();
        for device in ["A", "B"] {
            let db = db.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..100 {
                    let entry = make_entry(
                        &format!("{}-{}", device, i),
                        "conv-race",
                        "user",
                        1000 + i * 10,
                        &format!("dev-{}", device),
                        serde_json::json!({"seq": i}),
                    );
                    db.append(&entry).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        // 200 条全部写入，无丢失
        assert_eq!(db.conversation_count("conv-race").unwrap(), 200);
        let msgs = db.read("conv-race", None, None).unwrap();
        assert_eq!(msgs.len(), 200);

        // 无重复 id
        let mut ids: Vec<_> = msgs.iter().map(|m| m.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 200);

        // 按 timestamp 升序
        let timestamps: Vec<_> = msgs.iter().map(|m| m.timestamp).collect();
        let mut sorted = timestamps.clone();
        sorted.sort();
        assert_eq!(timestamps, sorted);
    }

    #[test]
    fn two_threads_concurrent_same_id_only_one_wins() {
        let (_tmp, db) = setup_db();
        let db = std::sync::Arc::new(db);

        let mut handles = Vec::new();
        for device in ["A", "B"] {
            let db = db.clone();
            handles.push(std::thread::spawn(move || {
                // 两设备同时写相同 id，不同内容
                let entry = make_entry(
                    "M1",
                    "conv-dup",
                    "user",
                    1000,
                    &format!("dev-{}", device),
                    serde_json::json!({"writer": device}),
                );
                db.append(&entry).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        // 只保留 1 条
        assert_eq!(db.conversation_count("conv-dup").unwrap(), 1);
        let msgs = db.read("conv-dup", None, None).unwrap();
        assert_eq!(msgs.len(), 1);
    }

    // ==========================================================================
    // 修订链
    // ==========================================================================

    #[test]
    fn revise_appends_new_version_old_kept() {
        let (_tmp, db) = setup_db();
        db.append(&make_entry("M1", "conv-1", "assistant", 1000, "dev-A", serde_json::json!({"text": "v1"})))
            .unwrap();

        let v2 = db.revise("M1", serde_json::json!({"text": "v2"})).unwrap();
        assert_eq!(v2, 2);
        let v3 = db.revise("M1", serde_json::json!({"text": "v3"})).unwrap();
        assert_eq!(v3, 3);

        // 修订历史完整（3 个版本）
        let history = db.read_history("M1").unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[0].version, 1);
        assert_eq!(history[2].version, 3);

        // read 返回最新版本（v3）
        let msgs = db.read("conv-1", None, None).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].version, 3);
        assert_eq!(msgs[0].content["text"], "v3");

        // 修订链引用正确
        assert_eq!(history[2].parent_version, Some(2));
    }

    #[test]
    fn revise_missing_message_errors() {
        let (_tmp, db) = setup_db();
        let err = db.revise("ghost", serde_json::json!({"text": "x"})).unwrap_err();
        assert!(err.to_string().contains("消息不存在"));
    }

    // ==========================================================================
    // read 选项
    // ==========================================================================

    #[test]
    fn read_with_after_timestamp() {
        let (_tmp, db) = setup_db();
        for (i, ts) in [1000, 2000, 3000, 4000].iter().enumerate() {
            db.append(&make_entry(
                &format!("M{}", i + 1),
                "conv-1",
                "user",
                *ts,
                "dev-A",
                serde_json::json!({}),
            ))
            .unwrap();
        }

        let after = db.read("conv-1", Some(2000), None).unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].timestamp, 3000);
        assert_eq!(after[1].timestamp, 4000);
    }

    #[test]
    fn read_with_limit() {
        let (_tmp, db) = setup_db();
        for (i, ts) in [1000, 2000, 3000, 4000].iter().enumerate() {
            db.append(&make_entry(
                &format!("M{}", i + 1),
                "conv-1",
                "user",
                *ts,
                "dev-A",
                serde_json::json!({}),
            ))
            .unwrap();
        }

        let limited = db.read("conv-1", None, Some(2)).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].timestamp, 1000);
        assert_eq!(limited[1].timestamp, 2000);
    }

    // ==========================================================================
    // 隔离与删除
    // ==========================================================================

    #[test]
    fn conversations_are_isolated() {
        let (_tmp, db) = setup_db();
        db.append(&make_entry("M1", "conv-a", "user", 1000, "dev-A", serde_json::json!({})))
            .unwrap();
        db.append(&make_entry("M2", "conv-b", "user", 2000, "dev-A", serde_json::json!({})))
            .unwrap();

        assert_eq!(db.read("conv-a", None, None).unwrap().len(), 1);
        assert_eq!(db.read("conv-b", None, None).unwrap().len(), 1);
        assert_eq!(db.read("conv-none", None, None).unwrap().len(), 0);
    }

    #[test]
    fn delete_by_conversation_only_target() {
        let (_tmp, db) = setup_db();
        db.append(&make_entry("M1", "conv-a", "user", 1000, "dev-A", serde_json::json!({})))
            .unwrap();
        db.append(&make_entry("M2", "conv-b", "user", 2000, "dev-A", serde_json::json!({})))
            .unwrap();

        db.delete_by_conversation("conv-a").unwrap();

        assert_eq!(db.read("conv-a", None, None).unwrap().len(), 0);
        assert_eq!(db.read("conv-b", None, None).unwrap().len(), 1);
    }

    #[test]
    fn get_latest_returns_newest_version() {
        let (_tmp, db) = setup_db();
        db.append(&make_entry("M1", "conv-1", "assistant", 1000, "dev-A", serde_json::json!({"text": "v1"})))
            .unwrap();
        db.revise("M1", serde_json::json!({"text": "v2"})).unwrap();

        let latest = db.get_latest("M1").unwrap().unwrap();
        assert_eq!(latest.version, 2);
        assert_eq!(latest.content["text"], "v2");

        // 不存在的消息 → None
        assert!(db.get_latest("ghost").unwrap().is_none());
    }
}
