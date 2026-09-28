//! cap.http 独立冒烟验证（非测试 harness，绕开 tauri test 加载问题）
//!
//! 用法：cargo run --bin cap_http_check
//! 验证 HttpCapability 的：ping、SSRF 校验、真实 GET/POST 转发、二进制 base64。

use polaris_lib::contracts::{Capability as _, CapabilityId, Context, PermissionRequest, PermissionVerdict, PluginId, Source, Storage, Value};
use polaris_lib::services::router::HttpCapability;

/// 最小上下文：cap.http 不读 ctx，占位满足 trait
struct Ctx;
impl Context for Ctx {
    fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> { Err("n/a".into()) }
    fn storage(&self) -> Result<&dyn Storage, String> { Err("n/a".into()) }
    fn check_permission(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> { Ok(PermissionVerdict::Allow) }
    fn source(&self) -> &Source { static S: Source = Source::Bootstrap; &S }
    fn caller_id(&self) -> &PluginId { static P: std::sync::LazyLock<PluginId> = std::sync::LazyLock::new(|| PluginId("cap.http".into())); &P }
    fn plugin_config(&self) -> Result<Value, String> { Ok(Value::Null) }
}

fn main() {
    // 验证「无 tokio 运行时」路径（bus_mcp_server / polaris-mcp bus 独立进程场景）：
    // block_on_async 应自建一次性 runtime 兜底，而非报错。
    {
        let cap = HttpCapability;
        let ctx = Ctx;
        let r = cap
            .invoke(serde_json::json!({ "action": "ping" }), &ctx)
            .expect("无运行时 ping ok");
        assert_eq!(r["pong"], true);
        let r = cap
            .invoke(
                serde_json::json!({
                    "action": "request", "method": "GET",
                    "url": "https://jsonplaceholder.typicode.com/todos/2",
                    "timeoutMs": 10000
                }),
                &ctx,
            )
            .expect("无运行时 GET ok");
        println!("[noruntime] status={} ok={}", r["status"], r["ok"]);
    }

    // cap.http 的 block_on_async 需 tokio 多线程运行时 + worker 线程上下文
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build runtime");
    rt.block_on(run());
}

async fn run() {
    let cap = HttpCapability;
    let ctx = Ctx;

    // 1. ping
    let r = cap.invoke(serde_json::json!({"action": "ping"}), &ctx).expect("ping ok");
    println!("[ping]      => {r}");

    // 2. SSRF 校验（走 invoke 前校验，应报错）
    for bad in ["http://localhost:9860/x", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/x", "file:///etc/passwd"] {
        let r = cap.invoke(serde_json::json!({"action":"request","method":"GET","url":bad}), &ctx);
        println!("[ssrf]  {bad:<45} => {:?}", r.map(|_| "UNEXPECTED ALLOW".to_string()).unwrap_err());
    }

    // 3. 真实 GET
    let r = cap.invoke(serde_json::json!({
        "action":"request","method":"GET","url":"https://jsonplaceholder.typicode.com/todos/1","timeoutMs":10000
    }), &ctx).expect("GET ok");
    println!("[get]   status={} ok={} body={}", r["status"], r["ok"], r["body"]);

    // 4. 真实 POST（JSON body + Content-Type 自动补）
    let r = cap.invoke(serde_json::json!({
        "action":"request","method":"POST","url":"https://jsonplaceholder.typicode.com/posts",
        "body":"{\"title\":\"cap-http\",\"body\":\"t\",\"userId\":1}","bodyType":"json","timeoutMs":10000
    }), &ctx).expect("POST ok");
    println!("[post]  status={} ok={} body={}", r["status"], r["ok"], r["body"]);

    // 5. 二进制 base64（GitHub avatar，image/png）
    let r = cap.invoke(serde_json::json!({
        "action":"request","method":"GET","url":"https://github.com/identicons/apple.png","timeoutMs":10000
    }), &ctx).expect("bin ok");
    let is_b64 = r["isBase64"].as_bool().unwrap_or(false);
    let body = r["body"].as_str().unwrap_or("");
    println!("[bin]   status={} isBase64={} len={} ct={}", r["status"], is_b64, body.len(), r["contentType"]);

    println!("\n✓ cap.http 冒烟验证完成（若网络可用则以上均有真实响应）");
}
