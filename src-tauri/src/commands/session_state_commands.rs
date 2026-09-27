//! 会话状态命令层 — 阶段 2：状态查询 + 仲裁 + 对账 + Session Registry
//!
//! 把 `services::session_state::SessionStateDb` 暴露给前端：
//! - `session_get_status`：从事件日志计算 running/idle/error（案例 3 算法落 Rust）
//! - `session_request_start` / `session_request_interrupt`：仲裁 + 能力检查
//! - `session_reconcile`：对账命令（前端快照 ↔ 后端日志）
//! - `session_register` / `session_get` / `session_list` / `session_append_message`
//!   / `session_update_metadata` / `session_delete`：Session Registry
//!
//! 数据路径与消息库同文件：`<DataRoot>/session-v2/messages.db`。
//! 旧业务路径（router_dispatch_stream / ai_chat_capability）零改动，影子运行原则。
//!
//! inner 实现同时供 Tauri command 与 Web IPC 桥调用（对齐 session_messages 模式）。

use std::sync::{Arc, Mutex};

use crate::error::Result;
use crate::services::data_root::data_root;
use crate::services::session_db::MessageEntry;
use crate::services::session_state::{
    SessionEventEntry, SessionRecord, SessionStateDb, SessionStatus,
};

/// 会话状态库全局单例（懒初始化，与消息库同文件）
static SESSION_STATE_DB: Mutex<Option<Arc<SessionStateDb>>> = Mutex::new(None);

/// 状态库文件路径（与消息库同文件，便于跨表事务）
fn state_db_path() -> std::path::PathBuf {
    data_root().root().join("session-v2").join("messages.db")
}

/// 获取（或懒初始化）状态库实例
fn db() -> Result<Arc<SessionStateDb>> {
    let mut guard = SESSION_STATE_DB
        .lock()
        .map_err(|e| crate::error::AppError::StateError(format!("锁会话状态库失败: {}", e)))?;
    if guard.is_none() {
        let path = state_db_path();
        tracing::info!("[SessionState] 初始化状态库: {}", path.display());
        *guard = Some(Arc::new(SessionStateDb::open(&path)?));
    }
    Ok(guard.as_ref().unwrap().clone())
}

// ============================================================================
// inner 实现（共享给 IPC dispatch）
// ============================================================================

// ── 状态查询 ──────────────────────────────────────────────────────────────

/// 查询会话状态（从事件日志计算）
pub fn session_get_status_inner(conversation_id: String) -> Result<SessionStatus> {
    db()?.compute_status(&conversation_id)
}

// ── 仲裁 ──────────────────────────────────────────────────────────────────

/// 请求开始（仲裁：已 running 则拒绝）
pub fn session_request_start_inner(
    conversation_id: String,
    _device_id: String,
) -> Result<serde_json::Value> {
    let status = db()?.compute_status(&conversation_id)?;
    if status.running {
        return Ok(serde_json::json!({
            "ok": false,
            "reason": format!(
                "会话已在运行中（由设备 {} 于 {} 启动）",
                status.started_by_device.as_deref().unwrap_or("?"),
                status.started_at.map(|t| t.to_string()).unwrap_or_else(|| "?".into()),
            ),
        }));
    }
    // 仲裁通过：实际 start 由调用方执行（追加 session_start 事件）
    Ok(serde_json::json!({ "ok": true }))
}

/// 请求中断（能力检查：当前实现任何设备都可中断）
pub fn session_request_interrupt_inner(
    conversation_id: String,
    _device_id: String,
) -> Result<serde_json::Value> {
    let status = db()?.compute_status(&conversation_id)?;
    if !status.running {
        return Ok(serde_json::json!({ "ok": false, "reason": "会话未在运行中" }));
    }
    Ok(serde_json::json!({ "ok": true }))
}

// ── 事件写入（供影子接入探测与调试用） ────────────────────────────────────

/// 追加会话事件（幂等）
pub fn session_event_append_inner(event: SessionEventEntry) -> Result<bool> {
    db()?.append_event(&event)
}

/// 读取会话的所有事件（按 seq 升序）
pub fn session_event_read_inner(conversation_id: String) -> Result<Vec<SessionEventEntry>> {
    db()?.read_events(&conversation_id)
}

/// 读取指定 seq 之后的事件（用于 resume）
pub fn session_event_read_after_seq_inner(seq: i64) -> Result<Vec<SessionEventEntry>> {
    db()?.read_events_after_seq(seq)
}

/// 当前最大 seq（无事件返回 0）
pub fn session_event_current_seq_inner() -> Result<i64> {
    db()?.current_seq()
}

/// 删除会话的所有事件（幂等）
pub fn session_event_delete_by_conversation_inner(conversation_id: String) -> Result<()> {
    db()?.delete_events_by_conversation(&conversation_id)
}

// ── 对账 ──────────────────────────────────────────────────────────────────

/// 对账：比对前端快照与后端日志
///
/// @param conversation_id 会话 ID
/// @param client_messages 前端当前持有的消息列表（快照，camelCase 数组）
/// @param client_running 前端认为的 running 状态
pub fn session_reconcile_inner(
    conversation_id: String,
    client_messages: Vec<MessageEntry>,
    client_running: bool,
) -> Result<crate::services::session_state::ReconcileResult> {
    let msg_db = crate::commands::session_messages::db()?;
    let server_messages = msg_db.read(&conversation_id, None, None)?;
    let status = db()?.compute_status(&conversation_id)?;
    Ok(crate::services::session_state::reconcile(
        &server_messages,
        &client_messages,
        &status,
        client_running,
    ))
}

// ── Session Registry ──────────────────────────────────────────────────────

/// 创建会话记录（幂等）
pub fn session_register_inner(record: SessionRecord) -> Result<SessionRecord> {
    db()?.create_record(&record)
}

/// 读取会话记录
pub fn session_get_inner(id: String) -> Result<Option<SessionRecord>> {
    db()?.get_record(&id)
}

/// 列出全部会话记录
pub fn session_list_inner() -> Result<Vec<SessionRecord>> {
    db()?.list_records()
}

/// 追加消息 ID（CAS 乐观锁）
pub fn session_append_message_inner(
    id: String,
    message_id: String,
    expected_version: i64,
) -> Result<SessionRecord> {
    db()?.append_message_id(&id, &message_id, expected_version)
}

/// 更新会话元数据（CAS 乐观锁）
pub fn session_update_metadata_inner(
    id: String,
    patch: serde_json::Value,
    expected_version: i64,
) -> Result<SessionRecord> {
    db()?.update_record_metadata(&id, &patch, expected_version)
}

/// 删除会话记录（幂等）
pub fn session_delete_inner(id: String) -> Result<()> {
    db()?.delete_record(&id)
}

// ============================================================================
// Tauri commands（桌面端）
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_get_status(conversation_id: String) -> Result<SessionStatus> {
    session_get_status_inner(conversation_id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_request_start(conversation_id: String, device_id: String) -> Result<serde_json::Value> {
    session_request_start_inner(conversation_id, device_id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_request_interrupt(
    conversation_id: String,
    device_id: String,
) -> Result<serde_json::Value> {
    session_request_interrupt_inner(conversation_id, device_id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_event_append(event: SessionEventEntry) -> Result<bool> {
    session_event_append_inner(event)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_event_read(conversation_id: String) -> Result<Vec<SessionEventEntry>> {
    session_event_read_inner(conversation_id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_event_read_after_seq(seq: i64) -> Result<Vec<SessionEventEntry>> {
    session_event_read_after_seq_inner(seq)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_event_current_seq() -> Result<i64> {
    session_event_current_seq_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_event_delete_by_conversation(conversation_id: String) -> Result<()> {
    session_event_delete_by_conversation_inner(conversation_id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_reconcile(
    conversation_id: String,
    client_messages: Vec<MessageEntry>,
    client_running: bool,
) -> Result<crate::services::session_state::ReconcileResult> {
    session_reconcile_inner(conversation_id, client_messages, client_running)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_register(record: SessionRecord) -> Result<SessionRecord> {
    session_register_inner(record)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_get(id: String) -> Result<Option<SessionRecord>> {
    session_get_inner(id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_list() -> Result<Vec<SessionRecord>> {
    session_list_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_append_message(
    id: String,
    message_id: String,
    expected_version: i64,
) -> Result<SessionRecord> {
    session_append_message_inner(id, message_id, expected_version)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_update_metadata(
    id: String,
    patch: serde_json::Value,
    expected_version: i64,
) -> Result<SessionRecord> {
    session_update_metadata_inner(id, patch, expected_version)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_delete(id: String) -> Result<()> {
    session_delete_inner(id)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::session_db::{MessageEntry, SessionMessageDb};
    use crate::services::session_state::SessionEventType;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// 重置全局单例，指向临时库（避免污染真实 DataRoot）
    fn setup_temp_db() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut name = "polaris-cmd-session-state-".to_string();
        name.push_str(&COUNTER.fetch_add(1, Ordering::SeqCst).to_string());
        let tmp = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("messages.db");

        // 状态库与消息库同一文件路径
        *SESSION_STATE_DB.lock().unwrap() = Some(Arc::new(SessionStateDb::open(&path).unwrap()));
        crate::commands::session_messages::set_test_db_for_testing(SessionMessageDb::open(&path).unwrap());
    }

    fn make_event(
        id: &str,
        conv: &str,
        event_type: SessionEventType,
        ts: i64,
        seq: i64,
    ) -> SessionEventEntry {
        SessionEventEntry {
            id: id.into(),
            conversation_id: conv.into(),
            event_type,
            timestamp: ts,
            device_id: "dev-test".into(),
            seq,
            reason: None,
            error_message: None,
        }
    }

    fn make_msg(id: &str, conv: &str, ts: i64) -> MessageEntry {
        MessageEntry {
            id: id.into(),
            conversation_id: conv.into(),
            role: "user".into(),
            timestamp: ts,
            device_id: "dev-test".into(),
            content: serde_json::json!({"text": "hi"}),
            version: 1,
            parent_version: None,
        }
    }

    #[test]
    fn get_status_no_events_is_idle() {
        setup_temp_db();
        let s = session_get_status_inner("conv-1".into()).unwrap();
        assert!(!s.running);
        assert_eq!(s.last_event_seq, 0);
    }

    #[test]
    fn request_start_arbitrates_running() {
        setup_temp_db();
        // 先造一个 running 会话（start 无 end）
        assert!(session_event_append_inner(make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, 1)).unwrap());

        // 请求 start → 被拒
        let r = session_request_start_inner("conv-1".into(), "dev-B".into()).unwrap();
        assert_eq!(r["ok"], false);
        assert!(r["reason"].as_str().unwrap().contains("已在运行中"));

        // 未 running 会话 → 通过
        let r2 = session_request_start_inner("conv-2".into(), "dev-B".into()).unwrap();
        assert_eq!(r2["ok"], true);
    }

    #[test]
    fn request_interrupt_requires_running() {
        setup_temp_db();
        // 未运行 → 拒绝
        let r = session_request_interrupt_inner("conv-1".into(), "dev-A".into()).unwrap();
        assert_eq!(r["ok"], false);

        // running → 通过
        assert!(session_event_append_inner(make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, 1)).unwrap());
        let r2 = session_request_interrupt_inner("conv-1".into(), "dev-B".into()).unwrap();
        assert_eq!(r2["ok"], true);
    }

    #[test]
    fn reconcile_via_inner() {
        setup_temp_db();
        // 后端有 M1
        let msg_db = crate::commands::session_messages::db().unwrap();
        msg_db.append(&make_msg("M1", "conv-1", 1000)).unwrap();

        // 前端持有 M2（多出的本地草稿）
        let client = vec![make_msg("M2", "conv-1", 2000)];
        let r = session_reconcile_inner("conv-1".into(), client, false).unwrap();
        assert_eq!(r.missing.len(), 1);
        assert_eq!(r.missing[0].id, "M1");
        assert_eq!(r.extra.len(), 1);
        assert_eq!(r.extra[0].id, "M2");
        assert!(!r.status_mismatch);
    }

    #[test]
    fn registry_via_inner() {
        setup_temp_db();
        let rec = SessionRecord {
            id: "S1".into(),
            conversation_id: Some("conv-1".into()),
            title: "t".into(),
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
        };
        let created = session_register_inner(rec).unwrap();
        assert_eq!(created.id, "S1");

        let got = session_get_inner("S1".into()).unwrap().unwrap();
        assert_eq!(got.conversation_id.as_deref(), Some("conv-1"));

        let appended = session_append_message_inner("S1".into(), "M1".into(), created.version).unwrap();
        assert_eq!(appended.message_ids, vec!["M1"]);

        let updated = session_update_metadata_inner(
            "S1".into(),
            serde_json::json!({"title": "新标题"}),
            appended.version,
        )
        .unwrap();
        assert_eq!(updated.title, "新标题");

        session_delete_inner("S1".into()).unwrap();
        assert!(session_get_inner("S1".into()).unwrap().is_none());
    }
}
