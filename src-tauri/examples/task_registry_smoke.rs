//! 后台任务注册表冒烟验证（独立 example，不依赖 lib test）
//!
//! 验证：spawn 后台任务 → 状态流转 → 日志落盘 → kill 进程树。
//! 运行：cargo run --features tauri-app --example task_registry_smoke

use std::time::Duration;

use polaris_lib::services::TaskRegistry;

#[tokio::main]
async fn main() {
    let tmp = std::env::temp_dir().join("polaris_task_registry_smoke");
    let _ = std::fs::remove_dir_all(&tmp);
    let registry = TaskRegistry::new(tmp.clone(), 30);

    // 1. 后台启动一个写日志后自然结束的任务
    let info = registry
        .spawn_task("s1", "echo hello-background; echo stage2; exit 0", None, &[], None)
        .await
        .unwrap();
    println!("spawned: taskId={} pid={} status={}", info.task_id, info.pid, info.status);
    assert_eq!(info.status, "running");

    // 2. 轮询到 done
    let mut status = String::new();
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let t = registry.task_info(&info.task_id).await.unwrap();
        status = t.status.clone();
        if status != "running" {
            println!("status after wait: {} (logTail={:?})", status, t.log_tail);
            break;
        }
    }
    assert_eq!(status, "done", "任务应自然结束为 done");

    // 3. 后台启动一个长任务并 kill
    let info2 = registry
        .spawn_task("s1", "python -c \"import time; time.sleep(9999)\"", None, &[], None)
        .await
        .unwrap();
    assert_eq!(info2.status, "running");
    let killed = registry.kill_task(&info2.task_id).await.unwrap();
    println!("kill result: {}", killed);
    let t2 = registry.task_info(&info2.task_id).await.unwrap();
    println!("status after kill: {}", t2.status);
    assert_eq!(t2.status, "killed", "kill 后状态应为 killed");

    // 4. 会话清理
    let info3 = registry
        .spawn_task("s2", "python -c \"import time; time.sleep(9999)\"", None, &[], None)
        .await
        .unwrap();
    registry.cleanup_session("s2").await;
    let t3 = registry.task_info(&info3.task_id).await.unwrap();
    println!("session-cleanup status: {}", t3.status);
    assert_eq!(t3.status, "killed", "会话清理后任务应为 killed");

    // 5. 列表过滤
    let all = registry.list_tasks(None, None).await;
    let running = registry.list_tasks(None, Some("running")).await;
    println!("total={} running={}", all.len(), running.len());

    let _ = std::fs::remove_dir_all(&tmp);
    println!("SMOKE OK");
}
