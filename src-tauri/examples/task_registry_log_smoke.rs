//! 日志读取冒烟：后台任务写大量输出 → read_log_tail 应返回尾部
use std::time::Duration;
use polaris_lib::services::TaskRegistry;

#[tokio::main]
async fn main() {
    let tmp = std::env::temp_dir().join("polaris_task_registry_log_smoke");
    let _ = std::fs::remove_dir_all(&tmp);
    let registry = TaskRegistry::new(tmp.clone(), 30);
    // 输出 50 行带序号
    let info = registry
        .spawn_task("s1", "for i in $(seq 1 50); do echo \"line-$i\"; done; sleep 0.5", None, &[], None)
        .await
        .unwrap();
    // 等 done
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if registry.task_info(&info.task_id).await.unwrap().status != "running" { break; }
    }
    let t = registry.task_info(&info.task_id).await.unwrap();
    println!("status={}", t.status);
    println!("logTail lines: {}", t.log_tail.lines().count());
    println!("first line of tail: {:?}", t.log_tail.lines().next());
    println!("last line of tail: {:?}", t.log_tail.lines().last());
    assert!(t.log_tail.contains("line-50"), "尾部应含最后一行 line-50");
    let _ = std::fs::remove_dir_all(&tmp);
    println!("LOG SMOKE OK");
}
