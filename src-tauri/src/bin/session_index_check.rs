//! session_index 独立冒烟验证（非测试 harness，绕开 tauri test 加载问题）
//!
//! 用法：cargo run --bin session_index_check
//! 验证 S1 会话投影（sessions_index）：
//! - register / list / list_after（workspace 分桶 + seq 增量）
//! - delete（幂等 + seq 推进）
//! - 事件流自动驱动投影状态（session_start → running / end → idle / error）
//! - try_start 事务占位后投影 running
//! - 幂等 upsert（重复 register 覆盖标题，seq 递增，不产生重复行）
//! - 无 conversation 的会话状态为 none

use std::path::PathBuf;

use polaris_lib::services::session_state::{
    SessionEventEntry, SessionEventType, SessionRecord, SessionStateDb,
};

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

fn make_event(
    id: &str,
    conv: &str,
    event_type: SessionEventType,
    ts: i64,
    device_id: &str,
    seq: i64,
) -> SessionEventEntry {
    SessionEventEntry {
        id: id.into(),
        conversation_id: conv.into(),
        event_type,
        timestamp: ts,
        device_id: device_id.into(),
        seq,
        reason: None,
        error_message: None,
    }
}

fn main() {
    let mut path = PathBuf::from(std::env::temp_dir());
    path.push(format!("polaris-session-index-check-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    let db = SessionStateDb::open(&path.join("check.db")).expect("打开状态库");

    // 1. register + list（workspace 分桶）
    db.create_record(&make_record("S1", Some("conv-1"))).unwrap();
    db.create_record(&make_record("S2", Some("conv-2"))).unwrap();
    let p1 = db.register_index("ws-A", &make_record("S1", Some("conv-1"))).unwrap();
    let p2 = db.register_index("ws-A", &make_record("S2", Some("conv-2"))).unwrap();
    assert_eq!(p1.workspace_key, "ws-A");
    assert_eq!(p1.session_id, "S1");
    assert_eq!(p1.status, "idle");
    assert_eq!(p1.seq, 1);
    assert_eq!(p2.seq, 2);
    assert!(db.register_index("ws-B", &make_record("S3", Some("conv-3"))).is_ok());

    let (list_a, last_a) = db.list_index("ws-A").unwrap();
    assert_eq!(list_a.len(), 2);
    assert_eq!(last_a, 3); // ws-B 的 S3 register 也推进全局 seq
    let (list_b, _) = db.list_index("ws-B").unwrap();
    assert_eq!(list_b.len(), 1);
    // 跨桶不可见
    assert!(!list_a.iter().any(|p| p.session_id == "S3"));
    println!("[ok] register + list + workspace 分桶");

    // 2. list_after（seq 增量）
    let after = db.list_index_after("ws-A", 1).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].session_id, "S2");
    println!("[ok] list_after seq 增量");

    // 3. 事件驱动状态：start → running
    db.append_event(&make_event("E1", "conv-1", SessionEventType::SessionStart, 1000, "dev-A", 1))
        .unwrap();
    let cur = db.list_index("ws-A").unwrap().0;
    assert_eq!(cur.iter().find(|p| p.session_id == "S1").unwrap().status, "running");
    assert_eq!(
        cur.iter().find(|p| p.session_id == "S1").unwrap().started_by_device.as_deref(),
        Some("dev-A")
    );
    // S2 不受影响
    assert_eq!(cur.iter().find(|p| p.session_id == "S2").unwrap().status, "idle");
    println!("[ok] 事件 → 投影 running（仅目标会话）");

    // 4. end → idle
    db.append_event(&make_event("E2", "conv-1", SessionEventType::SessionEnd, 2000, "dev-A", 2))
        .unwrap();
    let cur = db.list_index("ws-A").unwrap().0;
    assert_eq!(cur.iter().find(|p| p.session_id == "S1").unwrap().status, "idle");
    println!("[ok] 事件 → 投影 idle");

    // 5. error → error（无 error_message 也应兜底为 error，避免投影回退 idle）
    db.append_event(&make_event("E3", "conv-1", SessionEventType::Error, 3000, "dev-A", 3))
        .unwrap();
    let cur = db.list_index("ws-A").unwrap().0;
    let row = cur.iter().find(|p| p.session_id == "S1").unwrap();
    assert_eq!(row.status, "error");
    assert!(row.last_error.is_some()); // 兜底错误信息
    println!("[ok] 事件 → 投影 error（无 message 兜底）");

    // 5b. error 后跟正常 session_end → 配对完成，投影回到 idle（错误不残留）
    db.append_event(&make_event("E4", "conv-1", SessionEventType::SessionEnd, 3500, "dev-A", 4))
        .unwrap();
    let cur = db.list_index("ws-A").unwrap().0;
    let row = cur.iter().find(|p| p.session_id == "S1").unwrap();
    assert_eq!(row.status, "idle");
    assert!(row.last_error.is_none());
    println!("[ok] error 后正常 end → 投影回 idle，错误清除");

    // 6. try_start 事务占位 → running；重复 try_start 拒绝，状态保持
    let reason = db.try_start_conversation("conv-2", "dev-B", 4000).unwrap();
    assert!(reason.is_none());
    let cur = db.list_index("ws-A").unwrap().0;
    assert_eq!(cur.iter().find(|p| p.session_id == "S2").unwrap().status, "running");
    let reason2 = db.try_start_conversation("conv-2", "dev-C", 5000).unwrap();
    assert!(reason2.is_some());
    let cur = db.list_index("ws-A").unwrap().0;
    assert_eq!(cur.iter().find(|p| p.session_id == "S2").unwrap().status, "running");
    println!("[ok] try_start 仲裁 → 投影 running，重复拒绝");

    // 7. 幂等 upsert：重复 register 覆盖标题、seq 递增、不重复行
    let mut rec = make_record("S1", Some("conv-1"));
    rec.title = "改名".into();
    let rep = db.register_index("ws-A", &rec).unwrap();
    assert_eq!(rep.title, "改名");
    let (list_a, _) = db.list_index("ws-A").unwrap();
    assert_eq!(list_a.len(), 2);
    assert_eq!(list_a.iter().find(|p| p.session_id == "S1").unwrap().title, "改名");
    assert!(list_a.iter().find(|p| p.session_id == "S1").unwrap().seq > 1);
    println!("[ok] 幂等 upsert（覆盖 + seq 递增 + 无重复行）");

    // 8. delete（幂等；当前实现无墓碑——删除即消失，seq 计数回落 MAX+1）
    let del_seq = db.delete_index_entry("ws-A", "S1").unwrap();
    let (list_a, last) = db.list_index("ws-A").unwrap();
    assert_eq!(list_a.len(), 1);
    assert!(!list_a.iter().any(|p| p.session_id == "S1"));
    assert!(del_seq > last); // 删除分配了 seq 但未落墓碑，计数回落
    db.delete_index_entry("ws-A", "S1").unwrap(); // 幂等
    println!("[ok] delete 幂等（无墓碑：行消失、seq 计数回落）");

    // 9. 无 conversation → status none
    db.create_record(&make_record("S0", None)).unwrap();
    let p0 = db.register_index("ws-A", &make_record("S0", None)).unwrap();
    assert_eq!(p0.status, "none");
    assert!(p0.conversation_id.is_none());
    println!("[ok] 无 conversation → status none");

    // 10. 重复打开（幂等补建 schema，不升版本）：open 两次不丢数据
    let db2 = SessionStateDb::open(&path.join("check.db")).expect("重复打开");
    let (list_a2, _) = db2.list_index("ws-A").unwrap();
    assert!(list_a2.iter().any(|p| p.session_id == "S2"));
    println!("[ok] 重复打开 → schema 幂等、投影保留");

    let _ = std::fs::remove_dir_all(&path);
    println!("\n✅ session_index_check 全部通过");
}