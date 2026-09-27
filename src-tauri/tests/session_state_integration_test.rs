//! 阶段 4 批次 4：dispatch 链路附加 session_events 写入 — 集成测试
//!
//! 验证 `session_event_append_with_seq_inner`（自动分配 seq + 幂等）与
//! `session_get_status_inner`（状态从事件日志推导）的后端权威链路。
//! 与 lib 单测等价，但通过独立测试 exe 运行（绕开 Windows 下 lib 测试
//! exe 的 ENTRYPOINT_NOT_FOUND 环境问题）。

use polaris_lib::commands::session_state_commands::{
    session_event_append_with_seq_inner,
    session_event_read_inner,
    session_get_status_inner,
};
use polaris_lib::services::session_state::{SessionEventEntry, SessionEventType};

/// 每个测试用唯一临时目录作为 DataRoot（session_state db 与消息库同文件）。
/// env 变量 `POLARIS_DATA_ROOT` 由 data_root() 读取（见 services/data_root.rs）。
fn setup_temp_data_root(tag: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let tmp = std::env::temp_dir().join(format!(
        "polaris-it-session-state-{}-{}",
        tag,
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    // data_root() 是 OnceLock；同一测试进程内首个设置生效，后续测试沿用同一根目录
    unsafe { std::env::set_var("POLARIS_DATA_ROOT", &tmp) };
    tmp
}

fn make_event(id: &str, conv: &str, event_type: SessionEventType, ts: i64) -> SessionEventEntry {
    SessionEventEntry {
        id: id.into(),
        conversation_id: conv.into(),
        event_type,
        timestamp: ts,
        device_id: "dev-test".into(),
        seq: 0, // 占位：由底层 next_seq 分配
        reason: None,
        error_message: None,
    }
}

#[test]
fn append_with_seq_auto_assigns_and_status_derives() {
    setup_temp_data_root("append");
    // 注：测试进程内 data_root 为 OnceLock（多测试共享同一 db 文件），
    // 全局 seq 跨会话递增——只断言本会话事件的相对 seq，不断言绝对值。
    let conv = "conv-append";
    // start（无 end）→ running
    let e1 = make_event("E1", conv, SessionEventType::SessionStart, 1000);
    assert!(session_event_append_with_seq_inner(&e1).unwrap(), "追加 start 事件应成功");

    let s1 = session_get_status_inner(conv.into()).unwrap();
    assert!(s1.running, "只有 session_start → 应为 running");

    // end → idle
    let e2 = make_event("E2", conv, SessionEventType::SessionEnd, 2000);
    assert!(session_event_append_with_seq_inner(&e2).unwrap());

    let s2 = session_get_status_inner(conv.into()).unwrap();
    assert!(!s2.running, "start+end → 应为 idle");
    assert!(s2.last_event_seq > s1.last_event_seq, "end 事件 seq 应大于 start 事件 seq");

    // 幂等：相同 id 重复追加跳过（seq 不再增长）
    let before = session_event_read_inner(conv.into()).unwrap().len();
    assert!(!session_event_append_with_seq_inner(&e1).unwrap());
    let after = session_event_read_inner(conv.into()).unwrap().len();
    assert_eq!(before, after, "重复追加相同 id 应跳过");
}

#[test]
fn dispatch_write_start_and_aborted_end_pairing() {
    setup_temp_data_root("dispatch");
    // 模拟 dispatch 链路：start → interrupt(aborted end)
    let conv = "dispatch-1";
    let e1 = make_event("D1", conv, SessionEventType::SessionStart, 1000);
    let e2 = make_event("D2", conv, SessionEventType::SessionEnd, 2000);
    // 注：append_with_seq 对 reason 透传；interrupt 场景由 ai_chat_core 传 aborted
    let mut e2_aborted = e2.clone();
    e2_aborted.reason = Some("aborted".to_string());
    assert!(session_event_append_with_seq_inner(&e1).unwrap(), "追加 start 事件应成功");
    assert!(session_event_append_with_seq_inner(&e2_aborted).unwrap(), "追加 end(aborted) 事件应成功");

    let events = session_event_read_inner(conv.into()).unwrap();
    assert_eq!(events.len(), 2);
    assert!(events[0].seq < events[1].seq, "start 事件 seq 应小于 end 事件 seq");
    assert_eq!(events[1].reason.as_deref(), Some("aborted"));

    // 配对结束 → idle（中断不会残留 running）
    let s = session_get_status_inner(conv.into()).unwrap();
    assert!(!s.running);
}
