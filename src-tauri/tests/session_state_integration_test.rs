//! 阶段 4 批次 4：dispatch 链路附加 session_events 写入 — 集成测试
//!
//! 验证 `session_event_append_with_seq_inner`（自动分配 seq + 幂等）与
//! `session_get_status_inner`（状态从事件日志推导）的后端权威链路。
//! 阶段 5 扩展：对账（`session_reconcile_inner` 端到端、双设备恢复快照合并）
//! 与双设备并发矩阵（排他锁仲裁 + dispatch 双设备串联）。
//! 与 lib 单测等价，但通过独立测试 exe 运行（绕开 Windows 下 lib 测试
//! exe 的 ENTRYPOINT_NOT_FOUND 环境问题）。

use polaris_lib::commands::session_messages::message_append_inner;
use polaris_lib::commands::session_state_commands::{
    session_event_append_with_seq_inner,
    session_event_read_inner,
    session_get_status_inner,
    session_reconcile_inner,
};
use polaris_lib::services::session_db::MessageEntry;
use polaris_lib::services::session_state::{SessionEventEntry, SessionEventType};

/// 全局串行锁：本文件所有测试共享同一 data_root（OnceLock 首次 env 生效），
/// 并行 open 同一 messages.db 会触发 WAL 切换独占锁竞争（database is locked）。
/// 测试严格串行执行，消除该基建竞态（产品代码不受影响——生产只 open 一次）。
static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 固定进程级测试根目录（进程内唯一，测试间不删除）。
/// data_root() 是 OnceLock——首个 env 设置生效后固定；若每个测试各自
/// remove_dir_all 重建目录，会删除其他并行测试持有连接的 db 文件（database is locked）。
/// 所有测试 conversation_id 已唯一，共享一个持久目录互不污染。
static ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// 设置进程级 DataRoot（首次调用生效，返回根目录）。
fn setup_temp_data_root(_tag: &str) -> std::path::PathBuf {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = ROOT.get_or_init(|| {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "polaris-it-session-state-{}",
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        unsafe { std::env::set_var("POLARIS_DATA_ROOT", &dir) };
        dir
    });
    tmp.clone()
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

#[test]
fn exclusive_lock_rejects_second_active_start() {
    setup_temp_data_root("exclusive");
    // 场景：同一会话并发 continue（双设备 A/B 同时发消息）
    let conv = "exclusive-1";
    // A 先到：事务化仲裁 + 占位成功
    let a = polaris_lib::commands::session_state_commands::session_try_start_inner(
        conv,
        "device-A",
    )
    .unwrap();
    assert!(a.is_none(), "A 先到应占位成功（Ok(None)）");

    // B 后到：会话已 running → 拒绝（Ok(Some(reason))）
    let b = polaris_lib::commands::session_state_commands::session_try_start_inner(
        conv,
        "device-B",
    )
    .unwrap();
    assert!(b.is_some(), "B 后到应被拒绝（Ok(Some(reason))）");
    let reason = b.unwrap();
    assert!(
        reason.contains("device-A"),
        "拒绝原因应包含启动方设备，实际: {}",
        reason
    );

    // 事件日志应只有 A 的占位 start
    let events = session_event_read_inner(conv.into()).unwrap();
    assert_eq!(events.len(), 1, "只有 A 的占位 start 事件");
    assert_eq!(events[0].device_id, "device-A");

    // 配对 end 后恢复空闲 → 可再次占位（释放锁）
    let e_end = make_event("E-END", conv, SessionEventType::SessionEnd, 3000);
    assert!(session_event_append_with_seq_inner(&e_end).unwrap());
    let s = session_get_status_inner(conv.into()).unwrap();
    assert!(!s.running, "占位 start + end → idle，锁释放");

    let again = polaris_lib::commands::session_state_commands::session_try_start_inner(
        conv,
        "device-C",
    )
    .unwrap();
    assert!(again.is_none(), "idle 后再次占位应成功");
}

#[test]
fn exclusive_lock_sequential_rounds_serialize() {
    setup_temp_data_root("exclusive-seq");
    // 连续多轮：A 占位 → 配对 end → B 占位 → 配对 end → C 占位（严格串行）
    let conv = "exclusive-seq-1";
    for (i, device) in ["device-A", "device-B", "device-C"].iter().enumerate() {
        let got = polaris_lib::commands::session_state_commands::session_try_start_inner(
            conv,
            device,
        )
        .unwrap();
        assert!(got.is_none(), "第 {} 轮 {} 占位应成功，实际: {:?}", i, device, got);
        // 配对 end 释放
        let e_end = make_event(
            &format!("SEQ-END-{}", i),
            conv,
            SessionEventType::SessionEnd,
            1000 + i as i64 * 1000,
        );
        assert!(session_event_append_with_seq_inner(&e_end).unwrap());
    }
    let s = session_get_status_inner(conv.into()).unwrap();
    assert!(!s.running, "全部轮次配对结束后应为 idle");
}

#[test]
fn exclusive_lock_true_concurrent_race_single_winner() {
    setup_temp_data_root("exclusive-race");
    // 双设备并发矩阵核心场景：A/B 同时向同一会话发起 continue（同一进程内两线程，
    // 各自走 session_try_start_inner 事务）。SQLite 单写者 + 事务原子性保证：
    // 两个请求串行落库，后到者看到已 running → 拒绝。断言恰好一个成功。
    let conv = "exclusive-race-1";
    let conv = conv.to_string();

    let handles: Vec<_> = (0..8)
        .map(|i| {
            let conv = conv.clone();
            std::thread::spawn(move || {
                polaris_lib::commands::session_state_commands::session_try_start_inner(
                    &conv,
                    &format!("device-{}", i),
                )
                .unwrap()
            })
        })
        .collect();

    let results: Vec<Option<String>> = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect();

    let winners = results.iter().filter(|r| r.is_none()).count();
    assert_eq!(winners, 1, "并发仲裁应恰好一个成功，实际: {}", winners);
    // 其余全部拒绝，且拒绝原因含启动方设备
    for r in results.iter().filter(|r| r.is_some()) {
        assert!(
            r.as_ref().unwrap().contains("device-"),
            "拒绝原因应包含启动方设备，实际: {:?}",
            r
        );
    }

    // 事件日志恰好一个占位 start（多设备并发不产生多个 running 起点）
    let events = session_event_read_inner(conv.clone()).unwrap();
    let starts = events
        .iter()
        .filter(|e| e.event_type == SessionEventType::SessionStart)
        .count();
    assert_eq!(starts, 1, "并发下应恰好一条 session_start 占位");
}

#[test]
fn exclusive_lock_failure_compensation_releases_placeholder() {
    setup_temp_data_root("exclusive-comp");
    // 场景：continue 占位成功后引擎启动失败 → 占位 start 卡 running。
    // capability 层补偿写 session_end(error) → 锁释放，可再次占位。
    let conv = "exclusive-comp-1";
    // 占位成功
    let got = polaris_lib::commands::session_state_commands::session_try_start_inner(
        conv,
        "device-A",
    )
    .unwrap();
    assert!(got.is_none(), "首次占位应成功");

    // 模拟补偿：continue 失败 → append_session_event 写 session_end(error)
    // （capability 层真实调用路径，这里直接用等价命令层写入）
    let e_end = make_event("COMP-END", conv, SessionEventType::SessionEnd, 5000);
    let mut e_end = e_end;
    e_end.reason = Some("error".to_string());
    e_end.error_message = Some("CLI 不可用".to_string());
    assert!(session_event_append_with_seq_inner(&e_end).unwrap());

    let s = session_get_status_inner(conv.into()).unwrap();
    assert!(!s.running, "占位 + end(error) → idle，锁已释放");

    // 再次占位应成功（不残留 running）
    let again = polaris_lib::commands::session_state_commands::session_try_start_inner(
        conv,
        "device-B",
    )
    .unwrap();
    assert!(again.is_none(), "补偿后再次占位应成功");
}

#[test]
fn exclusive_lock_cross_connection_race_single_winner() {
    setup_temp_data_root("exclusive-xconn");
    // 双设备并发矩阵核心场景（跨连接版）：两个独立 SessionStateDb 连接指向同一
    // db 文件，各自线程内并发 try_start_conversation —— 模拟双进程/双设备。
    // SQLite 单写者 + 事务原子性 + busy_timeout：恰好一个赢家，无 running 分裂。
    let root = setup_temp_data_root("exclusive-xconn-2");
    let db_path = root.join("session-v2").join("messages.db");
    let conv = "exclusive-xconn-1".to_string();

    // 先由主线程完成一次 open（初始化 WAL / schema）。SQLite 的
    // `PRAGMA journal_mode=WAL` 切换需独占锁，多连接并发 open 会互相锁竞争；
    // 预热后再并发 open 只设相同 pragma（no-op），不再触发 WAL 切换锁。
    let _warm = polaris_lib::services::session_state::SessionStateDb::open(&db_path)
        .expect("预热连接打开失败");

    // 每个线程独立打开连接（模拟不同设备实例）
    let handles: Vec<_> = (0..6)
        .map(|i| {
            let db_path = db_path.clone();
            let conv = conv.clone();
            std::thread::spawn(move || {
                let db = polaris_lib::services::session_state::SessionStateDb::open(&db_path)
                    .expect("独立连接打开失败");
                db.try_start_conversation(&conv, &format!("device-{}", i), 1000)
                    .expect("try_start_conversation 失败")
            })
        })
        .collect();

    let results: Vec<Option<String>> = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect();

    let winners = results.iter().filter(|r| r.is_none()).count();
    assert_eq!(winners, 1, "跨连接并发仲裁应恰好一个成功，实际: {}", winners);
    let rejects = results.iter().filter(|r| r.is_some()).count();
    assert_eq!(rejects, 5, "其余 5 个应被拒绝，实际: {}", rejects);

    // 事件日志恰好一个占位 start
    let db = polaris_lib::services::session_state::SessionStateDb::open(&db_path).unwrap();
    let events = db.read_events(&conv).unwrap();
    let starts = events
        .iter()
        .filter(|e| e.event_type == SessionEventType::SessionStart)
        .count();
    assert_eq!(starts, 1, "跨连接并发下应恰好一条 session_start 占位");
}

#[test]
fn reconcile_via_command_layer_end_to_end() {
    setup_temp_data_root("reconcile-e2e");
    // 场景：设备 B 重启后本地快照落后于后端（缺 M1），且残留本地草稿 M3；
    // 设备 B 对账 → 后端补 M1、识别 M3 为 extra、running 状态与后端一致。
    let conv = "reconcile-e2e-1";

    // 后端权威：设备 A 已运行并产出 M1（占位 start + 消息 + 无 end）
    assert!(session_event_append_with_seq_inner(&make_event(
        "R-START",
        conv,
        SessionEventType::SessionStart,
        1000,
    ))
    .unwrap());
    assert!(message_append_inner(make_msg("E2E-M1", conv, 1500)).unwrap());

    // 设备 B 快照：只有本地草稿 M3（后端无此消息）
    let client = vec![make_msg("E2E-M3", conv, 3000)];
    let r = session_reconcile_inner(conv.into(), client, false).unwrap();

    // 对账结果：missing=backend M1（后端有、快照缺）、extra=M3（快照有、后端无）
    assert_eq!(r.missing.len(), 1, "应检出缺失的 M1，实际: {:?}", r.missing);
    assert_eq!(r.missing[0].id, "E2E-M1");
    assert_eq!(r.extra.len(), 1, "应检出多出的 M3，实际: {:?}", r.extra);
    assert_eq!(r.extra[0].id, "E2E-M3");
    // 设备 B 认为 idle，但后端 running（设备 A 会话进行中）→ 状态不一致需提示
    assert!(r.status_mismatch, "快照 running=false 与后端 running=true 应标记不一致");
    assert!(r.server_status.running);
    assert_eq!(r.server_status.started_by_device.as_deref(), Some("dev-test"));
}

#[test]
fn reconcile_two_devices_resume_merges_missing_only() {
    setup_temp_data_root("reconcile-resume");
    // 双设备恢复场景（阶段 5 验收核心）：设备 A 在设备 B 缺席期间产生 M1/M2，
    // 设备 B 重启恢复时快照持有旧 M0 + 本地新草稿 M3 → 对账只追加缺失，不丢本地。
    let conv = "reconcile-resume-1";
    assert!(message_append_inner(make_msg("RS-M1", conv, 1000)).unwrap());
    assert!(message_append_inner(make_msg("RS-M2", conv, 2000)).unwrap());

    let client = vec![make_msg("RS-M0", conv, 500), make_msg("RS-M3", conv, 3000)];
    let r = session_reconcile_inner(conv.into(), client, false).unwrap();

    assert_eq!(r.missing.len(), 2, "应检出 M1/M2 两条缺失");
    let missing_ids: Vec<&str> = r.missing.iter().map(|m| m.id.as_str()).collect();
    assert!(missing_ids.contains(&"RS-M1") && missing_ids.contains(&"RS-M2"));

    assert_eq!(r.extra.len(), 2, "M0/M3 均为后端无 → extra");
    assert!(!r.status_mismatch, "双方均 idle → 无状态不一致");
}

#[test]
fn dispatch_dual_device_continue_rejects_concurrent_active() {
    setup_temp_data_root("dispatch-dual");
    // 端到端串联：模拟 dispatch 链路（cap.ai.chat continue）双设备并发。
    // 排他锁（事务仲裁+占位）→ 恰好一个设备获准继续；被拒方对账仍能拉齐消息。
    let conv = "dispatch-dual-1";
    // 设备 A 通过 dispatch continue 通道获准占位（session_try_start_inner 即该通道核心）
    let a = polaris_lib::commands::session_state_commands::session_try_start_inner(
        conv,
        "device-A",
    )
    .unwrap();
    assert!(a.is_none(), "设备 A 先到应占位成功");

    // 设备 B 同一会话继续 → 排他拒绝（reason 含启动方）
    let b = polaris_lib::commands::session_state_commands::session_try_start_inner(
        conv,
        "device-B",
    )
    .unwrap();
    let reason = b.expect("设备 B 应被排他拒绝");
    assert!(reason.contains("device-A"), "拒绝原因应含启动方，实际: {}", reason);

    // 设备 A 在运行期间产出消息；设备 B 拉取后端消息后与本地快照对账（幂等合并）
    assert!(message_append_inner(make_msg("DD-A-M1", conv, 1000)).unwrap());
    let client_b = vec![make_msg("DD-B-draft", conv, 2000)];
    let r = session_reconcile_inner(conv.into(), client_b, false).unwrap();
    assert_eq!(r.missing.len(), 1, "设备 B 应拉齐 A-M1");
    assert_eq!(r.missing[0].id, "DD-A-M1");
    assert_eq!(r.extra.len(), 1, "设备 B 本地草稿应标记 extra");
    assert!(r.status_mismatch, "设备 B 认为 idle，后端仍 running（设备 A 占有）");

    // 设备 A 结束后锁释放，设备 B 可继续
    assert!(session_event_append_with_seq_inner(&make_event(
        "A-END",
        conv,
        SessionEventType::SessionEnd,
        3000,
    ))
    .unwrap());
    let c = polaris_lib::commands::session_state_commands::session_try_start_inner(
        conv,
        "device-B",
    )
    .unwrap();
    assert!(c.is_none(), "设备 A 结束后设备 B 应可继续（锁已释放）");
}
