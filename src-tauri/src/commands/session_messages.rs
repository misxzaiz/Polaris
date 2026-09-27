//! 会话消息 SQLite 命令层 — 阶段 1b
//!
//! 把 `services::session_db::SessionMessageDb`（阶段 1 核心库）暴露给前端：
//! - `message_append` / `message_revise` / `message_read` / `message_read_history`
//! - `message_get_latest` / `message_delete_by_conversation`
//!
//! 数据路径：`<DataRoot>/session-v2/messages.db`，与旧 `dialogs/*.jsonl` 完全隔离。
//! 旧业务路径（dialog_write/dialog_append）零改动，影子运行原则。
//!
//! inner 实现同时供 Tauri command 与 Web IPC 桥调用（对齐 dialog_storage 模式）。

use std::sync::{Arc, Mutex};

use crate::error::Result;
use crate::services::data_root::data_root;
use crate::services::session_db::{MessageEntry, SessionMessageDb};

/// 会话消息库全局单例（懒初始化）。
/// 单进程内共享同一连接（Mutex 串行化）；多设备各自进程打开同一文件，靠 SQLite
/// WAL + busy_timeout 保证并发安全（阶段 1 已验证）。
static SESSION_DB: Mutex<Option<Arc<SessionMessageDb>>> = Mutex::new(None);

/// 消息库文件路径（与 dialogs/ 隔离的独立目录）
fn messages_db_path() -> std::path::PathBuf {
    data_root().root().join("session-v2").join("messages.db")
}

/// 获取（或懒初始化）消息库实例
fn db() -> Result<Arc<SessionMessageDb>> {
    let mut guard = SESSION_DB
        .lock()
        .map_err(|e| crate::error::AppError::StateError(format!("锁会话消息库失败: {}", e)))?;
    if guard.is_none() {
        let path = messages_db_path();
        tracing::info!("[SessionMessages] 初始化消息库: {}", path.display());
        *guard = Some(Arc::new(SessionMessageDb::open(&path)?));
    }
    Ok(guard.as_ref().unwrap().clone())
}

// ============================================================================
// inner 实现（共享给 IPC dispatch）
// ============================================================================

pub fn message_append_inner(entry: MessageEntry) -> Result<bool> {
    db()?.append(&entry)
}

pub fn message_revise_inner(id: String, content: serde_json::Value) -> Result<i64> {
    db()?.revise(&id, content)
}

pub fn message_read_inner(
    conversation_id: String,
    after_timestamp: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<MessageEntry>> {
    db()?.read(&conversation_id, after_timestamp, limit)
}

pub fn message_read_history_inner(id: String) -> Result<Vec<MessageEntry>> {
    db()?.read_history(&id)
}

pub fn message_get_latest_inner(id: String) -> Result<Option<MessageEntry>> {
    db()?.get_latest(&id)
}

pub fn message_delete_by_conversation_inner(conversation_id: String) -> Result<()> {
    db()?.delete_by_conversation(&conversation_id)
}

// ============================================================================
// Tauri commands（桌面端）
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn message_append(entry: MessageEntry) -> Result<bool> {
    message_append_inner(entry)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn message_revise(id: String, content: serde_json::Value) -> Result<i64> {
    message_revise_inner(id, content)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn message_read(
    conversation_id: String,
    after_timestamp: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<MessageEntry>> {
    message_read_inner(conversation_id, after_timestamp, limit)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn message_read_history(id: String) -> Result<Vec<MessageEntry>> {
    message_read_history_inner(id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn message_get_latest(id: String) -> Result<Option<MessageEntry>> {
    message_get_latest_inner(id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn message_delete_by_conversation(conversation_id: String) -> Result<()> {
    message_delete_by_conversation_inner(conversation_id)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 重置全局单例，指向临时库（避免污染真实 DataRoot）
    fn setup_temp_db() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut name = "polaris-cmd-session-".to_string();
        name.push_str(&COUNTER.fetch_add(1, Ordering::SeqCst).to_string());
        let tmp = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("messages.db");
        *SESSION_DB.lock().unwrap() = Some(Arc::new(SessionMessageDb::open(&path).unwrap()));
        path
    }

    fn make_entry(id: &str, conv: &str, role: &str, ts: i64, content: serde_json::Value) -> MessageEntry {
        MessageEntry {
            id: id.into(),
            conversation_id: conv.into(),
            role: role.into(),
            timestamp: ts,
            device_id: "dev-test".into(),
            content,
            version: 1,
            parent_version: None,
        }
    }

    #[test]
    fn append_read_roundtrip_via_inner() {
        let _path = setup_temp_db();
        assert!(message_append_inner(make_entry("M1", "conv-1", "user", 1000, serde_json::json!({"text": "你好"}))).unwrap());
        assert!(message_append_inner(make_entry("M2", "conv-1", "assistant", 2000, serde_json::json!({"text": "回复"}))).unwrap());

        let msgs = message_read_inner("conv-1".into(), None, None).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content["text"], "你好");
        assert_eq!(msgs[1].content["text"], "回复");
    }

    #[test]
    fn append_is_idempotent_via_inner() {
        let _path = setup_temp_db();
        let entry = make_entry("M1", "conv-1", "user", 1000, serde_json::json!({}));
        assert!(message_append_inner(entry.clone()).unwrap());
        // 幂等：重复追加返回 false，不产生重复
        assert!(!message_append_inner(entry).unwrap());
        assert_eq!(message_read_inner("conv-1".into(), None, None).unwrap().len(), 1);
    }

    #[test]
    fn revise_then_read_latest_via_inner() {
        let _path = setup_temp_db();
        message_append_inner(make_entry("M1", "conv-1", "assistant", 1000, serde_json::json!({"text": "v1"}))).unwrap();
        let v2 = message_revise_inner("M1".into(), serde_json::json!({"text": "v2"})).unwrap();
        assert_eq!(v2, 2);

        let latest = message_get_latest_inner("M1".into()).unwrap().unwrap();
        assert_eq!(latest.version, 2);
        assert_eq!(latest.content["text"], "v2");

        let history = message_read_history_inner("M1".into()).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].version, 1);
        assert_eq!(history[1].version, 2);
    }

    #[test]
    fn read_with_after_timestamp_via_inner() {
        let _path = setup_temp_db();
        for (i, ts) in [1000, 2000, 3000].iter().enumerate() {
            message_append_inner(make_entry(&format!("M{}", i + 1), "conv-1", "user", *ts, serde_json::json!({}))).unwrap();
        }
        let after = message_read_inner("conv-1".into(), Some(1000), None).unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].timestamp, 2000);
    }

    #[test]
    fn delete_by_conversation_via_inner() {
        let _path = setup_temp_db();
        message_append_inner(make_entry("M1", "conv-a", "user", 1000, serde_json::json!({}))).unwrap();
        message_append_inner(make_entry("M2", "conv-b", "user", 2000, serde_json::json!({}))).unwrap();

        message_delete_by_conversation_inner("conv-a".into()).unwrap();

        assert_eq!(message_read_inner("conv-a".into(), None, None).unwrap().len(), 0);
        assert_eq!(message_read_inner("conv-b".into(), None, None).unwrap().len(), 1);
    }
}
