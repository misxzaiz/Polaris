//! 会话状态命令层 — 阶段 2：状态查询 + 仲裁 + 对账 + Session Registry
//!
//! 把 `services::session_state::SessionStateDb` 暴露给前端：
//! - `session_get_status`：从事件日志计算 running/idle/error（案例 3 算法落 Rust）
//! - `session_request_start` / `session_request_interrupt`：仲裁 + 能力检查
//! - `session_reconcile`：对账命令（前端快照 ↔ 后端日志）
//! - `session_register` / `session_get` / `session_list` / `session_append_message`
//!   / `session_update_metadata` / `session_delete`：Session Registry
//!
//! 数据路径：`<DataRoot>/session-v2/state.db`（独立文件）。
//!
//! 根因修复（2026-10-24，审计 2.1）：本库曾与消息库共用同一 `messages.db`，
//! 但两者 SCHEMA_VERSION 不同（session_db=1 / session_state=2），各自按
//! `PRAGMA user_version` 判版本、不符即删库重建——启动/每轮聊天打开 state 库
//! 会把 user_version 覆写为 2，下次重启消息库开库即整库清空。拆分独立文件后
//! 两个 schema 版本钥匙互不干扰。旧 messages.db 内的 state 表数据不迁移
//! （本就被反复清空，无保留价值）。
//!
//! 旧业务路径（router_dispatch_stream / ai_chat_capability）零改动，影子运行原则。
//!
//! inner 实现同时供 Tauri command 与 Web IPC 桥调用（对齐 session_messages 模式）。

use std::sync::{Arc, Mutex};

use crate::error::Result;
use crate::services::data_root::data_root;
use crate::services::session_db::MessageEntry;
use crate::services::session_state::{
    SessionEventEntry, SessionEventType, SessionProjection, SessionRecord, SessionStateDb,
    SessionStatus,
};

/// 会话状态库全局单例（懒初始化）
static SESSION_STATE_DB: Mutex<Option<Arc<SessionStateDb>>> = Mutex::new(None);

/// 状态库文件路径（独立于消息库 messages.db，见模块注释根因说明）
fn state_db_path() -> std::path::PathBuf {
    data_root().root().join("session-v2").join("state.db")
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

/// 事务化「仲裁 + 占位」（阶段 2 排他锁，cap.ai.chat dispatch 入口强制接入）。
///
/// 与 `session_request_start_inner` 的区别：running 检查与 session_start 占位写入
/// 在同一事务内完成，多设备并发时先到者胜出，杜绝「都通过检查后再各自写入」的
/// 竞态窗口。返回 `Ok(None)` = 已占位成功；`Ok(Some(reason))` = 会话已 running 被拒。
pub fn session_try_start_inner(
    conversation_id: &str,
    device_id: &str,
) -> Result<Option<String>> {
    db()?.try_start_conversation(conversation_id, device_id, chrono::Utc::now().timestamp_millis())
}

/// 请求开始（仲裁：已 running 则拒绝。纯检查，不写入占位——由调用方决定）
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

/// 启动恢复（B2.c，审计 3.4）：把事件日志中「有 session_start 无 session_end」
/// 的会话补一条 session_end（reason=interrupted）。
///
/// 根因：running = 有 start 无 end（`compute_status`）；后端被强杀后这些会话
/// 在权威状态里永久 running——后续所有 continue 被 try_start「会话已在运行中」
/// 拒绝，除非用户恰好点一次停止。启动时统一落定。
/// @returns 落定的会话数
pub fn recover_unpaired_running_inner() -> Result<usize> {
    let ids = db()?.running_conversation_ids()?;
    let mut recovered = 0usize;
    for cid in ids {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let event = SessionEventEntry {
            id: format!("core-recover-session-end-{}", uuid::Uuid::new_v4()),
            conversation_id: cid.clone(),
            event_type: SessionEventType::SessionEnd,
            timestamp: ts,
            device_id: "core".to_string(),
            seq: 0, // 占位；由 append_with_seq 在事务内分配
            reason: Some("interrupted: backend restarted while session running".to_string()),
            error_message: None,
        };
        match session_event_append_with_seq_inner(&event) {
            Ok(true) => {
                tracing::info!("[SessionState] 启动落定残留 running 会话: {}", cid);
                recovered += 1;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!("[SessionState] 落定 running 会话失败 {}: {}", cid, e),
        }
    }
    Ok(recovered)
}

/// 追加会话事件（自动分配 seq，事务一致）— 阶段 4 批次 4 dispatch 链路附加写入用。
///
/// 与 `session_event_append_inner` 的区别：调用方不预分配 seq，由底层
/// `next_seq` 在事务内取 MAX+1（多进程安全）。事件 id 由调用方生成（幂等键）。
pub fn session_event_append_with_seq_inner(event: &SessionEventEntry) -> Result<bool> {
    let db = db()?;
    if event.seq <= 0 {
        // 调用方未指定 seq（占位 0）：底层分配
        let mut ev = event.clone();
        ev.seq = db.next_seq()?;
        db.append_event(&ev)
    } else {
        db.append_event(event)
    }
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

// ── 会话投影（sessions_index，workspace 级权威列表）────────────────────────

/// 注册（upsert）一个会话到投影。幂等；返回写入后的投影条目。
/// 这是「新建会话 → 前端同步投影」的唯一入口。
pub fn session_index_register_inner(
    workspace_key: String,
    record: SessionRecord,
) -> Result<SessionProjection> {
    db()?.register_index(&workspace_key, &record)
}

/// 读取某 workspace 的全量投影快照（附带当前最大 seq，供订阅/轮询起点）。
pub fn session_index_list_inner(
    workspace_key: String,
) -> Result<(Vec<SessionProjection>, i64)> {
    db()?.list_index(&workspace_key)
}

/// 读取某 workspace 在 after_seq 之后的投影增量（gap repair / 轮询数据源）。
pub fn session_index_list_after_inner(
    workspace_key: String,
    after_seq: i64,
) -> Result<Vec<SessionProjection>> {
    db()?.list_index_after(&workspace_key, after_seq)
}

/// 删除投影条目（幂等；不删 session_records，仅从 workspace 列表移除）。
pub fn session_index_delete_inner(workspace_key: String, session_id: String) -> Result<()> {
    db()?.delete_index_entry(&workspace_key, &session_id)?;
    Ok(())
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

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_index_register(
    workspace_key: String,
    record: SessionRecord,
) -> Result<SessionProjection> {
    session_index_register_inner(workspace_key, record)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_index_list(workspace_key: String) -> Result<(Vec<SessionProjection>, i64)> {
    session_index_list_inner(workspace_key)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_index_list_after(
    workspace_key: String,
    after_seq: i64,
) -> Result<Vec<SessionProjection>> {
    session_index_list_after_inner(workspace_key, after_seq)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn session_index_delete(workspace_key: String, session_id: String) -> Result<()> {
    session_index_delete_inner(workspace_key, session_id)
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
        // 两库拆分独立文件（对齐生产路径）：同文件会因 user_version 1 vs 2 互删，
        // 测试同样会复现「先开 state 库再开消息库 → state 表被清」的竞态。
        let state_path = tmp.join("state.db");
        let message_path = tmp.join("messages.db");

        *SESSION_STATE_DB.lock().unwrap() = Some(Arc::new(SessionStateDb::open(&state_path).unwrap()));
        crate::commands::session_messages::set_test_db_for_testing(SessionMessageDb::open(&message_path).unwrap());
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

    #[test]
    fn append_with_seq_auto_assigns_increasing_seq() {
        setup_temp_db();
        // 调用方不指定 seq（占位 0）→ 底层自动分配递增 seq
        let mut e1 = make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, 0);
        let mut e2 = make_event("E2", "conv-1", SessionEventType::SessionEnd, 2000, 0);
        assert!(session_event_append_with_seq_inner(&e1).unwrap());
        assert!(session_event_append_with_seq_inner(&e2).unwrap());

        let events = session_event_read_inner("conv-1".into()).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[1].seq, 2);

        // 状态推导：start+end → idle
        let s = session_get_status_inner("conv-1".into()).unwrap();
        assert!(!s.running);
        assert_eq!(s.last_event_seq, 2);

        // 幂等：相同 id 重复追加跳过
        assert!(!session_event_append_with_seq_inner(&e1).unwrap());
        // 指定 seq 的调用直接透传
        e1.seq = 99;
        assert!(session_event_append_with_seq_inner(&e1).unwrap());
        let r = session_event_read_inner("conv-1".into()).unwrap();
        assert!(r.iter().any(|ev| ev.seq == 99));
    }
}
