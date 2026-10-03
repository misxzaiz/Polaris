//! cap.bash 集成测试（通过公开 API 验证核心功能）
//!
//! 验证点：
//! 1. run 同步执行回显命令 → completed + 日志含输出
//! 2. run async + status/list 查询 → 能查到任务状态
//! 3. kill 后台任务 → 状态变 killed
//! 4. 会话过滤：sessionId 过滤生效
//! 5. 任务归宿主（TaskManager 单例），跨调用可查

use polaris_lib::contracts::{
    Capability, CapabilityId, Context, PermissionRequest, PermissionVerdict, PluginId, Source,
    Value,
};
use polaris_lib::services::router::BashCapability;
use serde_json::json;
use std::time::Duration;

/// 测试 Context：模拟某个 AI 会话（Source::Plugin{caller}）发起
struct TestCtx(Source);
impl Context for TestCtx {
    fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
        Err("not implemented".into())
    }
    fn storage(&self) -> Result<&dyn polaris_lib::contracts::Storage, String> {
        Err("not implemented".into())
    }
    fn check_permission(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> {
        Ok(PermissionVerdict::Allow)
    }
    fn source(&self) -> &Source {
        &self.0
    }
    fn caller_id(&self) -> &PluginId {
        static PID: PluginId = PluginId(String::new());
        &PID
    }
    fn plugin_config(&self) -> Result<Value, String> {
        Ok(json!({}))
    }
}

fn session_ctx(caller: &str) -> TestCtx {
    TestCtx(Source::Plugin {
        caller: PluginId(caller.into()),
    })
}

#[test]
fn run_echo_completes_sync() {
    let cap = BashCapability::new();
    let ctx = session_ctx("it-sync-1");
    let r = cap
        .invoke(
            json!({ "action": "run", "command": "echo hello cap.bash-it", "async": false }),
            &ctx,
        )
        .unwrap();
    assert_eq!(r["status"], "completed", "同步 run 应完成，resp={r}");
    assert_eq!(r["exitCode"], 0);
    let id = r["taskId"].as_str().unwrap().to_string();

    let log = cap
        .invoke(json!({ "action": "log", "taskId": id }), &ctx)
        .unwrap();
    let text = log["lines"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("hello cap.bash-it"), "日志应含输出，got: {text}");
}

#[test]
fn async_run_then_status_and_wait() {
    let cap = BashCapability::new();
    let ctx = session_ctx("it-async-1");
    let r = cap
        .invoke(
            json!({ "action": "run", "command": "echo async-ok", "async": true }),
            &ctx,
        )
        .unwrap();
    let id = r["taskId"].as_str().unwrap().to_string();
    // async run 立即返回，但极快命令可能在返回前已完成——接受 running 或 completed
    let first = r["status"].as_str().unwrap();
    assert!(
        first == "running" || first == "completed",
        "async run 应返回 running 或 completed，got: {first}"
    );

    // wait 等到完成
    let w = cap
        .invoke(json!({ "action": "wait", "taskId": id, "timeoutMs": 10000 }), &ctx)
        .unwrap();
    assert_eq!(w["status"], "completed", "wait 应等到完成，resp={w}");

    let st = cap
        .invoke(json!({ "action": "status", "taskId": id }), &ctx)
        .unwrap();
    assert_eq!(st["status"], "completed");
}

#[test]
fn kill_running_long_task() {
    let cap = BashCapability::new();
    let ctx = session_ctx("it-kill-1");
    // git bash / cmd / sh 都有 sleep；确保任务长跑以便在 running 态杀掉
    let cmd = if cfg!(windows) {
        "ping -n 30 127.0.0.1"
    } else {
        "sleep 30"
    };
    let r = cap
        .invoke(
            json!({ "action": "run", "command": cmd, "async": true, "timeoutMs": 120000 }),
            &ctx,
        )
        .unwrap();
    let id = r["taskId"].as_str().unwrap().to_string();

    // 等 pid 就绪且任务仍在 running（若命令意外快速完成则重试一次长命令）
    let mut ok = false;
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        let st = cap
            .invoke(json!({ "action": "status", "taskId": id }), &ctx)
            .unwrap();
        if st["status"] == "running" && st["pid"].as_u64().unwrap_or(0) != 0 {
            ok = true;
            break;
        }
    }
    assert!(ok, "任务应在 running 态且已 spawn，resp={r}");

    let k = cap
        .invoke(json!({ "action": "kill", "taskId": id }), &ctx)
        .unwrap();
    assert_eq!(k["killed"], true, "kill 应成功，resp={k}");
    let st = cap
        .invoke(json!({ "action": "status", "taskId": id }), &ctx)
        .unwrap();
    assert_eq!(st["status"], "killed", "任务状态应为 killed，resp={st}");
}

#[test]
fn list_filters_by_session_and_status() {
    let cap = BashCapability::new();
    let ctx_a = session_ctx("it-sess-a");
    let ctx_b = session_ctx("it-sess-b");

    let r1 = cap
        .invoke(json!({ "action": "run", "command": "echo a1", "async": true }), &ctx_a)
        .unwrap();
    let r2 = cap
        .invoke(json!({ "action": "run", "command": "echo b1", "async": true }), &ctx_b)
        .unwrap();
    let id1 = r1["taskId"].as_str().unwrap().to_string();
    let id2 = r2["taskId"].as_str().unwrap().to_string();

    // 等两条都完成
    for _ in 0..50 {
        let s1 = cap
            .invoke(json!({ "action": "status", "taskId": id1 }), &ctx_a)
            .unwrap();
        let s2 = cap
            .invoke(json!({ "action": "status", "taskId": id2 }), &ctx_a)
            .unwrap();
        if s1["status"] != "running" && s2["status"] != "running" {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let a = cap
        .invoke(json!({ "action": "list", "sessionId": "it-sess-a" }), &ctx_a)
        .unwrap();
    assert_eq!(a["tasks"].as_array().unwrap().len(), 1, "会话 A 应只有自己的任务");

    let done = cap
        .invoke(json!({ "action": "list", "status": "completed" }), &ctx_a)
        .unwrap();
    assert!(done["tasks"].as_array().unwrap().len() >= 2, "completed 应含两条");
}

#[test]
fn unknown_task_errors() {
    let cap = BashCapability::new();
    let ctx = session_ctx("it-err-1");
    let r = cap.invoke(json!({ "action": "status", "taskId": "t99999" }), &ctx);
    assert!(r.is_err());
}