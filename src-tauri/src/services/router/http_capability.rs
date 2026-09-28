//! cap.http —— 通用 HTTP 转发能力（cap.http 契约）
//!
//! 定位：宿主级通用转发，替代插件各自启动的 node 代理服务（如 relay-devkit 的
//! server.js / __proxy）。插件面板（主窗口 webview，Source::Bootstrap）与 AI
//! （Source::Plugin，经 bus_dispatch 白名单）都经 RouterBus 统一 dispatch 触达。
//!
//! # 解决的问题
//!
//! 浏览器 fetch 受三重限制，插件面板直连目标 API 不可靠：
//! - CORS：目标未授权时响应被浏览器拦截
//! - 混合内容：HTTPS 页面 fetch HTTP 目标被直接拒绝
//! - 禁发头：Cookie / User-Agent / Referer / Authorization 等 forbidden headers
//!   被浏览器静默剥离，发出必失败（目标常返回登录失效/403）
//!
//! 本能力把请求改道宿主 Rust reqwest 转发：不受浏览器限制，头可完整注入，
//! 与 cURL 原生客户端发送等效。这正是 relay-devkit 代理的价值点。
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `request` `{ "action": "request", "method": "GET", "url": "...",
//!                 "headers": { k: v }, "body": "<raw>", "bodyType": "json|text|form|binary",
//!                 "timeoutMs": 15000 }`
//!                 → `{ "status": 200, "statusText": "OK", "ok": true,
//!                      "contentType": "...", "headers": {k: v},
//!                      "body": "<text 原文 | base64>", "isBase64": false,
//!                      "url": "...", "timeMs": 123 }`
//! - `ping`   `{ "action": "ping" }` → `{ "pong": true }`（连通性/权限冒烟用）
//!
//! # 二进制响应
//!
//! JSON 无法携带原始字节，二进制内容（image/*、octet-stream 等）经 base64 编码
//! 返回，`isBase64: true` 标记，前端解码后构造 blobUrl。
//!
//! # 安全（SSRF 防御）
//!
//! `validate_target` 拒绝向以下目标发起转发，防服务端请求伪造：
//! - localhost / 127.0.0.0/8 / ::1 / 0.0.0.0
//! - 云元数据 169.254.169.254（AWS/GCP/Azure 凭证）
//! - RFC1918 私网段（10/8、172.16/12、192.168/16）
//! - `.local` / `.internal` 内部域名后缀
//! - `file:` / `gopher:` 等非 http(s) 协议
//!
//! 补充防线：`validate_host_candidates` 对 DNS 解析结果逐一校验（防域名级
//! DNS-rebinding——域名合法但解析到内网）。
//!
//! 注：仅作为兜底；面板（Bootstrap）走主窗口调用、AI 走 Plugin source，
//! 均非 Remote 匿名通道。Web/移动端若放开 cap.http 白名单，本校验是第一道闸。

use crate::contracts::{Capability, CapabilityId, Context, Value};
use base64::Engine as _;
use std::net::ToSocketAddrs;

const CAP_ID: &str = "cap.http";

/// 二进制响应最大字节（超出按错误处理，防内存滥用）
const MAX_BINARY_BYTES: usize = 32 * 1024 * 1024;

/// 请求默认超时（毫秒）
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

/// cap.http —— 通用 HTTP 转发能力（无状态，无依赖注入）
pub struct HttpCapability;

impl HttpCapability {
    /// 包装：async 转发核驱动（双路径）
    ///
    /// - 主进程（Tauri 命令 / dispatch）：`Handle::try_current()` 命中 → 复用现成
    ///   runtime（`block_in_place` 要求 worker 线程；Tauri 命令均在 worker 内执行）
    /// - 独立进程（bus_mcp_server / polaris-mcp bus 等无主 runtime 的 stdio 循环）：
    ///   `try_current` 失败 → 自建一次性 multi-thread runtime `block_on`。
    ///   单次转发成本（建 runtime）在微秒级，对 request 级调用可忽略。
    fn block_on_async<F>(f: F) -> Result<Value, String>
    where
        F: std::future::Future<Output = Result<Value, String>>,
    {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            return tokio::task::block_in_place(move || handle.block_on(f));
        }
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("cap.http 运行时构建失败: {e}"))?;
        rt.block_on(f)
    }

    /// SSRF 校验：目标 URL 必须可转发。
    ///
    /// 校验点：
    /// 1. 协议必须 http/https
    /// 2. 主机必须是合法域名/IP，且非保留网段/元数据/内部后缀
    fn validate_target(url: &str) -> Result<(), String> {
        let parsed = reqwest::Url::parse(url)
            .map_err(|e| format!("URL 解析失败: {e}"))?;
        match parsed.scheme() {
            "http" | "https" => {}
            other => return Err(format!("cap.http 仅支持 http/https，收到 {other:?}")),
        }
        let host = parsed.host_str().unwrap_or_default();
        if host.is_empty() {
            return Err("URL 缺少 host".into());
        }
        // 内部域名后缀
        let lower = host.to_ascii_lowercase();
        for suffix in [".local", ".internal", ".localhost"] {
            if lower == suffix.trim_start_matches('.') || lower.ends_with(suffix) {
                return Err(format!("内部域名不可转发: {host}"));
            }
        }
        // 解析所有候选 IP（含 DNS-rebinding 场景的每个结果）
        if let Ok(addrs) = dns_lookup(host) {
            for ip in addrs {
                Self::validate_ip(&ip, host)?;
            }
        } else if !is_domain_like(host) {
            // 非域名（裸 IP）且 DNS 解析失败 → 走 IP 字面量校验
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                Self::validate_ip(&ip, host)?;
            }
        }
        Ok(())
    }

    /// 校验单个 IP 是否为目标可转发地址
    fn validate_ip(ip: &std::net::IpAddr, host: &str) -> Result<(), String> {
        match ip {
            std::net::IpAddr::V4(v4) => {
                if v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
                {
                    return Err(format!("内网/保留地址不可转发: {host} ({ip})"));
                }
                // 云元数据 169.254.169.254 属 link-local，已覆盖
            }
            std::net::IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unspecified() {
                    return Err(format!("内网/保留地址不可转发: {host} ({ip})"));
                }
                // IPv6 私网（ULA fc00::/7）与链路本地 fe80::/10 也拒绝
                if (v6.segments()[0] & 0xfe00) == 0xfc00 {
                    return Err(format!("IPv6 私网地址不可转发: {host} ({ip})"));
                }
                if (v6.segments()[0] & 0xffc0) == 0xfe80 {
                    return Err(format!("IPv6 链路本地不可转发: {host} ({ip})"));
                }
            }
        }
        Ok(())
    }
}

/// 域名形态判断（粗判：含字母/连字符且非纯 IP）
fn is_domain_like(host: &str) -> bool {
    host.parse::<std::net::IpAddr>().is_err()
}

/// 简易 DNS 解析（to_socket_addrs 同步包装；SSRF 校验场景够用）
fn dns_lookup(host: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
    let port = 80u16;
    let addrs = (host, port).to_socket_addrs()?;
    Ok(addrs
        .into_iter()
        .map(|a| a.ip())
        .collect::<Vec<_>>())
}

impl Capability for HttpCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.http 需要 action 参数（request/ping）".to_string())?;

        match action {
            "ping" => Ok(serde_json::json!({ "pong": true })),
            "request" => {
                // 参数解析（在同步段做，失败立即返回；async 核只拿已校验的数据）
                let method = params
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("GET")
                    .to_ascii_uppercase();
                if !is_valid_method(&method) {
                    return Err(format!("cap.http 不支持方法: {method}"));
                }
                let url = params
                    .get("url")
                    .and_then(|u| u.as_str())
                    .ok_or_else(|| "cap.http request 缺少 url 参数".to_string())?
                    .to_string();
                Self::validate_target(&url)?;

                let headers = params
                    .get("headers")
                    .and_then(|h| h.as_object())
                    .map(|obj| {
                        obj.iter()
                            .filter_map(|(k, v)| {
                                let v = v.as_str().unwrap_or_default().to_string();
                                (!k.is_empty() && !v.is_empty()).then(|| (k.clone(), v))
                            })
                            .collect::<Vec<(String, String)>>()
                    })
                    .unwrap_or_default();

                let body = params.get("body").and_then(|b| b.as_str()).unwrap_or("");
                let body_type = params
                    .get("bodyType")
                    .and_then(|b| b.as_str())
                    .unwrap_or("text");
                let timeout_ms = params
                    .get("timeoutMs")
                    .and_then(|t| t.as_u64())
                    .unwrap_or(DEFAULT_TIMEOUT_MS);

                Self::block_on_async(async move {
                    Self::do_request(&method, &url, &headers, body, body_type, timeout_ms).await
                })
            }
            other => Err(format!("cap.http 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

fn is_valid_method(m: &str) -> bool {
    matches!(
        m,
        "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "TRACE"
    )
}

impl HttpCapability {
    /// 异步转发核（reqwest 不受浏览器禁发头/CORS/混合内容限制）
    async fn do_request(
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: &str,
        body_type: &str,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        // 单请求客户端：短连接 + 单用途，避免连接池跨目标串味；跟随重定向
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| format!("cap.http 客户端构建失败: {e}"))?;

        let mut builder = client.request(
            reqwest::Method::from_bytes(method.as_bytes())
                .map_err(|e| format!("方法解析失败: {e}"))?,
            url,
        );

        // 注入请求头（含浏览器禁发头——这正是宿主转发的价值）
        for (k, v) in headers {
            let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| format!("请求头名非法: {k}: {e}"))?;
            let value = reqwest::header::HeaderValue::from_str(v)
                .map_err(|e| format!("请求头值非法: {v}: {e}"))?;
            builder = builder.header(name, value);
        }

        // body 注入（按 bodyType 默认补 Content-Type）
        if !["GET", "HEAD"].contains(&method) && !body.is_empty() {
            let has_ct = headers
                .iter()
                .any(|(k, _)| k.to_ascii_lowercase() == "content-type");
            match body_type {
                "json" => {
                    if !has_ct {
                        builder = builder.header(
                            reqwest::header::CONTENT_TYPE,
                            "application/json",
                        );
                    }
                }
                "form" => {
                    if !has_ct {
                        builder = builder.header(
                            reqwest::header::CONTENT_TYPE,
                            "application/x-www-form-urlencoded",
                        );
                    }
                }
                _ => {}
            }
            builder = builder.body(body.to_string());
        }

        let t0 = std::time::Instant::now();
        let resp = builder
            .send()
            .await
            .map_err(|e| format!("cap.http 请求失败: {e}"))?;

        let status = resp.status();
        let status_text = status
            .canonical_reason()
            .unwrap_or("")
            .to_string();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // 响应头：过滤 hop-by-hop 与 Set-Cookie 数组（JSON 对象仅承载单值）
        let mut resp_headers = serde_json::Map::new();
        for (k, v) in resp.headers() {
            let name = k.as_str().to_ascii_lowercase();
            if name == "set-cookie" || name == "connection" || name == "transfer-encoding"
                || name == "keep-alive" || name == "content-length"
            {
                continue;
            }
            if let Ok(s) = v.to_str() {
                resp_headers.insert(name, Value::String(s.to_string()));
            }
        }

        // 响应体：文本直传，二进制 base64
        // 空 content-type 按文本处理（与 relay-devkit BINARY.test 行为一致）；
        // 明确命中二进制类型，或非文本/结构化类型时走 base64
        let is_bin = content_type.contains("application/octet-stream")
            || content_type.contains("image/")
            || content_type.contains("audio/")
            || content_type.contains("video/")
            || content_type.contains("font/")
            || (!content_type.contains("text/")
                && !content_type.contains("json")
                && !content_type.contains("xml")
                && !content_type.contains("javascript")
                && !content_type.contains("x-www-form-urlencoded")
                && !content_type.contains("graphql"));

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("cap.http 读取响应失败: {e}"))?;
        if bytes.len() > MAX_BINARY_BYTES {
            return Err(format!(
                "cap.http 响应过大（{} > {} bytes）",
                bytes.len(),
                MAX_BINARY_BYTES
            ));
        }

        let (body_out, is_base64) = if is_bin {
            (base64::engine::general_purpose::STANDARD.encode(&bytes), true)
        } else {
            (String::from_utf8_lossy(&bytes).to_string(), false)
        };

        Ok(serde_json::json!({
            "status": status.as_u16(),
            "statusText": status_text,
            "ok": status.is_success(),
            "contentType": content_type,
            "headers": resp_headers,
            "body": body_out,
            "isBase64": is_base64,
            "url": url,
            "timeMs": t0.elapsed().as_millis() as u64,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- SSRF 校验 ----------

    #[test]
    fn reject_loopback_hosts() {
        for url in [
            "http://localhost:9860/foo",
            "http://127.0.0.1:8080/",
            "http://127.8.8.8/",
            "http://[::1]:8080/",
            "http://0.0.0.0/",
        ] {
            assert!(HttpCapability::validate_target(url).is_err(), "应拒绝 {url}");
        }
    }

    #[test]
    fn reject_private_ranges() {
        for url in [
            "http://10.0.0.1/x",
            "http://172.16.0.1/x",
            "http://172.32.0.1/x", // 172.16/12 之外（合法，应放行）
            "http://192.168.1.1/x",
        ] {
            let expect_deny = url.contains("172.32") == false;
            assert_eq!(
                HttpCapability::validate_target(url).is_err(),
                expect_deny,
                "{} 判定与预期不符",
                url
            );
        }
    }

    #[test]
    fn reject_cloud_metadata() {
        // 169.254.169.254（AWS/GCP/Azure 元数据）属 link-local，必拒
        assert!(HttpCapability::validate_target("http://169.254.169.254/latest/meta-data/").is_err());
    }

    #[test]
    fn reject_internal_domains() {
        for url in ["http://db.internal/x", "http://svc.local/x", "http://foo.localhost/x"] {
            assert!(HttpCapability::validate_target(url).is_err(), "应拒绝 {url}");
        }
    }

    #[test]
    fn reject_non_http_schemes() {
        for url in ["file:///etc/passwd", "gopher://x", "ftp://example.com"] {
            assert!(HttpCapability::validate_target(url).is_err(), "应拒绝 {url}");
        }
    }

    #[test]
    fn allow_public_targets() {
        for url in [
            "https://jsonplaceholder.typicode.com/users",
            "https://api.github.com/repos/rust-lang/rust",
            "http://example.com/",
        ] {
            assert!(HttpCapability::validate_target(url).is_ok(), "应放行 {url}");
        }
    }

    #[test]
    fn missing_url_is_rejected() {
        let r = HttpCapability.invoke(
            serde_json::json!({ "action": "request", "method": "GET" }),
            &_null_ctx(),
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("缺少 url"));
    }

    // ---------- 方法校验 ----------

    #[test]
    fn rejects_bad_method() {
        let r = HttpCapability.invoke(
            serde_json::json!({ "action": "request", "method": "BANANA", "url": "https://example.com" }),
            &_null_ctx(),
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("不支持方法"));
    }

    #[test]
    fn ping_returns_pong() {
        let r = HttpCapability.invoke(serde_json::json!({ "action": "ping" }), &_null_ctx());
        assert!(r.is_ok());
        assert_eq!(r.unwrap()["pong"], true);
    }

    #[test]
    fn missing_action_is_rejected() {
        let r = HttpCapability.invoke(serde_json::json!({}), &_null_ctx());
        assert!(r.is_err());
    }

    // ---------- 真实转发（走 reqwest::blocking，单测脱离 tokio 运行时） ----------

    #[test]
    fn real_request_to_public_api() {
        // 网络单测：命中失败不 panic（环境离线时跳过）
        let url = "https://jsonplaceholder.typicode.com/todos/1";
        let r = HttpCapability::block_on_async(async move {
            HttpCapability::do_request("GET", url, &[], "", "text", 10_000).await
        });
        match r {
            Ok(v) => {
                assert_eq!(v["status"], 200);
                assert_eq!(v["ok"], true);
                assert!(v["body"].as_str().unwrap().contains("\"userId\""));
            }
            Err(e) => eprintln!("网络单测跳过（离线或目标不可达）: {e}"),
        }
    }

    #[test]
    fn real_post_with_json_body() {
        let url = "https://jsonplaceholder.typicode.com/posts";
        let headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        let body = r#"{"title":"cap-http","body":"test","userId":1}"#;
        let r = HttpCapability::block_on_async(async move {
            HttpCapability::do_request("POST", url, &headers, body, "json", 10_000).await
        });
        match r {
            Ok(v) => {
                assert_eq!(v["status"], 201);
                assert_eq!(v["body"].as_str().unwrap().contains("\"id\""), true);
            }
            Err(e) => eprintln!("网络单测跳过: {e}"),
        }
    }

    // ---------- 测试上下文（cap.http 不读 ctx，占位满足 trait） ----------

    struct NullCtx;
    impl Context for NullCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }
        fn check_permission(
            &self,
            _req: &crate::contracts::PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &crate::contracts::Source {
            static S: crate::contracts::Source = crate::contracts::Source::Bootstrap;
            &S
        }
        fn caller_id(&self) -> &crate::contracts::PluginId {
            use std::sync::LazyLock;
            static P: LazyLock<crate::contracts::PluginId> =
                LazyLock::new(|| crate::contracts::PluginId("cap.http".into()));
            &P
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }
    fn _null_ctx() -> NullCtx {
        NullCtx
    }
}
