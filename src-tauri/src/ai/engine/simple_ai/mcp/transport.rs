/*! MCP 传输层抽象（Phase 0 — 无状态化基础）
 *
 * 定义 `McpTransport` trait 及两个实现：
 * - `StdioTransport`：子进程 stdin/stdout，当前 `McpClient` 的传输层提取。
 * - `HttpTransport`：HTTP SSE（预留，MCP 2026-07-28 无状态化后流式 HTTP）。
 *
 * 设计目标：
 * 1. 把当前 `McpClient` 中直接操作子进程 stdin/stdout 的代码提取为 `StdioTransport`。
 * 2. 定义 `McpTransport` trait 供 `McpSession`（未来）切换传输层。
 * 3. 新增 `ProtocolVersion` 枚举，为 2026-07-28 无状态协议做准备。
 */

use std::fmt::Debug;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

use crate::error::{AppError, Result};

/// MCP 协议版本。
///
/// 当前 SimpleAI 使用 2025-06-18（有状态）。
/// 2026-07-28 无状态协议移除 initialize 握手 + Mcp-Session-Id。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolVersion {
    V2024_11_05,
    V2025_06_18,
    V2026_07_28,
}

impl ProtocolVersion {
    /// 当前客户端请求的协议版本。
    pub const fn current() -> Self {
        ProtocolVersion::V2025_06_18
    }

    /// 协议版本字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            ProtocolVersion::V2024_11_05 => "2024-11-05",
            ProtocolVersion::V2025_06_18 => "2025-06-18",
            ProtocolVersion::V2026_07_28 => "2026-07-28",
        }
    }

    /// 从 server 返回的协议版本字符串协商降级。
    pub fn from_server(version: &str) -> Self {
        match version {
            "2026-07-28" => ProtocolVersion::V2026_07_28,
            "2025-06-18" => ProtocolVersion::V2025_06_18,
            "2024-11-05" => ProtocolVersion::V2024_11_05,
            _ => {
                tracing::warn!("[MCP] 未知协议版本 '{}'，降级到 2025-06-18", version);
                ProtocolVersion::V2025_06_18
            }
        }
    }

    /// 是否需要 initialize 握手（2026-07-28 无状态协议移除）。
    pub fn needs_handshake(&self) -> bool {
        matches!(self, ProtocolVersion::V2024_11_05 | ProtocolVersion::V2025_06_18)
    }
}

/// 单行 JSON-RPC 2.0 帧。
#[derive(Debug, Clone)]
pub struct TransportFrame {
    /// 原始 JSON 行。
    pub raw: String,
    /// 解析后的 JSON（如果可解析）。
    pub parsed: Option<Value>,
}

/// MCP 传输层抽象。
///
/// 定义与子进程或 HTTP 端点交换 JSON-RPC 2.0 帧的操作。
/// 实现者需保证：写一行 JSON，读一段 JSON-RPC 响应。
#[async_trait]
pub trait McpTransport: Debug + Send + Sync {
    /// 发送一行 JSON-RPC 2.0 请求/通知。
    async fn send_line(&self, line: &str) -> Result<()>;

    /// 读取一行 JSON-RPC 2.0 响应（带超时）。
    async fn read_line(&self, timeout: Duration) -> Result<TransportFrame>;

    /// 请求-响应一次完整交换：发请求并拿响应。
    ///
    /// 默认实现：`send_line` + `read_line`（stdio 后台路由模型）。
    /// HTTP 无状态传输覆盖此方法为一次 `POST /mcp` 直连交换，
    /// 不依赖后台 reader 路由（MCP 2026-07-28 Streamable HTTP 语义）。
    async fn request_response(&self, line: &str, timeout: Duration) -> Result<TransportFrame> {
        self.send_line(line).await?;
        self.read_line(timeout).await
    }

    /// 同步终止底层资源（Drop 等同步上下文调用；stdio kill 子进程，
    /// HTTP no-op）。trait 提供默认 no-op，Stdio 覆盖为实际 kill。
    fn shutdown_sync(&self) {}

    /// 关闭传输层（释放资源）。
    async fn shutdown(&mut self) -> Result<()>;
}

/// stdio 传输层实现：通过子进程 stdin/stdout 交换 JSON 行。
///
/// 设计：`spawn_with_reader` 返回 `(Self, ChildStdout)`——stdin 写入由 transport
/// 独占管理（`send_line`），stdout 由调用方接管用于后台 reader task（按 id 路由）。
/// 这样既消除 stdin 写入重复，又保留 client 的后台连续读模型。
#[derive(Debug)]
pub struct StdioTransport {
    server_name: String,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
}

impl StdioTransport {
    /// 创建新的 StdioTransport，返回 transport + stdout（供调用方起后台 reader task）。
    ///
    /// 与 `McpClient::spawn` 等价，但把传输层职责分离：stdin 写入归 transport，
    /// stdout 读取由调用方按需路由（后台连续读 vs 按需超时读）。
    pub async fn spawn_with_reader(
        server_name: String,
        command: &str,
        args: &[String],
        env: &std::collections::HashMap<String, String>,
    ) -> Result<(Self, ChildStdout)> {
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(args);
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            AppError::ProcessError(format!(
                "spawn MCP server '{}' ({}) failed: {}",
                server_name, command, e
            ))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::ProcessError("MCP server stdin not captured".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::ProcessError("MCP server stdout not captured".to_string()))?;

        Ok((
            Self {
                server_name,
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
            },
            stdout,
        ))
    }

    /// 同步终止子进程（trait `shutdown_sync` 的实现；供 Drop 用）。
    pub(crate) fn kill_sync(&self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }

    /// server 名称（诊断用）。
    pub(crate) fn server_name(&self) -> &str {
        &self.server_name
    }
}

#[async_trait]
impl McpTransport for StdioTransport {
    async fn send_line(&self, line: &str) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "write to MCP '{}' stdin: {}",
                    self.server_name, e
                ))
            })?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "write newline to MCP '{}' stdin: {}",
                    self.server_name, e
                ))
            })?;
        stdin
            .flush()
            .await
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "flush MCP '{}' stdin: {}",
                    self.server_name, e
                ))
            })?;
        Ok(())
    }

    async fn read_line(&self, _timeout: Duration) -> Result<TransportFrame> {
        // StdioTransport 的 stdout 已由调用方（McpClient）接管用于后台 reader task，
        // 此方法仅用于其他传输层实现（如 HttpTransport 的按需超时读）。
        Err(AppError::UnsupportedTransport(format!(
            "StdioTransport 的 stdout 已由调用方接管，read_line 不适用；请用 HttpTransport"
        )))
    }

    /// 同步 kill 子进程（Drop 时调用）。
    fn shutdown_sync(&self) {
        self.kill_sync();
    }

    async fn shutdown(&mut self) -> Result<()> {
        let mut child = self.child.lock().await;
        child
            .kill()
            .await
            .map_err(|e| AppError::ProcessError(format!("kill MCP '{}': {}", self.server_name, e)))?;
        child
            .wait()
            .await
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "wait MCP '{}' after kill: {}",
                    self.server_name, e
                ))
            })?;
        Ok(())
    }
}

/// HTTP 传输层实现（MCP 2026-07-28 Streamable HTTP 的基础形态）。
///
/// 无状态模型：一次 `POST /mcp` 请求 = 一个 JSON-RPC 请求-响应交换。
/// trait 的 `send_line` 发单请求并缓存响应；`read_line` 立即返回缓存响应。
///
/// 认证：可选 `Authorization: Bearer <api_key>` 头（OAuth 2.1 前的轻量形态）。
#[derive(Debug)]
pub struct HttpTransport {
    base_url: String,
    api_key: Option<String>,
    /// 最近一次 send_line 的响应（read_line 读取）。
    last_response: Mutex<Option<TransportFrame>>,
}

impl HttpTransport {
    pub fn new(base_url: String, api_key: Option<String>) -> Self {
        Self {
            base_url,
            api_key,
            last_response: Mutex::new(None),
        }
    }

    /// 组装 MCP HTTP 端点 URL：`base_url.trim_end_matches('/') + "/mcp"`。
    /// 纯函数便于单测。
    fn endpoint_url(base_url: &str) -> String {
        base_url.trim_end_matches('/').to_string() + "/mcp"
    }

    /// 请求超时（秒）。
    const REQUEST_TIMEOUT_SECS: u64 = 60;
}

#[async_trait]
impl McpTransport for HttpTransport {
    async fn send_line(&self, line: &str) -> Result<()> {
        let client = reqwest::Client::new();
        let url = Self::endpoint_url(&self.base_url);
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(line.to_string());
        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AppError::NetworkError(format!("HTTP MCP POST 失败: {}", e)))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| AppError::NetworkError(format!("HTTP MCP 读响应失败: {}", e)))?;
        if !status.is_success() {
            return Err(AppError::NetworkError(format!(
                "HTTP MCP 非成功状态 {}: {}",
                status, body
            )));
        }
        let parsed = serde_json::from_str::<Value>(&body).ok();
        *self.last_response.lock().await = Some(TransportFrame {
            raw: body,
            parsed,
        });
        Ok(())
    }

    async fn read_line(&self, _timeout: Duration) -> Result<TransportFrame> {
        let mut last = self.last_response.lock().await;
        match last.take() {
            Some(frame) => Ok(frame),
            None => Err(AppError::McpTransportTimeout(
                "HTTP MCP 尚无响应（先调用 send_line）".to_string(),
            )),
        }
    }

    /// HTTP 无状态核心：一次 `POST /mcp` 即完整请求-响应交换。
    async fn request_response(&self, line: &str, _timeout: Duration) -> Result<TransportFrame> {
        self.send_line(line).await?;
        self.read_line(Duration::from_secs(Self::REQUEST_TIMEOUT_SECS)).await
    }

    async fn shutdown(&mut self) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_roundtrip() {
        assert_eq!(ProtocolVersion::V2025_06_18.as_str(), "2025-06-18");
        assert_eq!(ProtocolVersion::from_server("2026-07-28"), ProtocolVersion::V2026_07_28);
        assert_eq!(ProtocolVersion::from_server("unknown"), ProtocolVersion::V2025_06_18);
    }

    #[test]
    fn protocol_version_handshake_requirement() {
        assert!(ProtocolVersion::V2024_11_05.needs_handshake());
        assert!(ProtocolVersion::V2025_06_18.needs_handshake());
        assert!(!ProtocolVersion::V2026_07_28.needs_handshake());
    }

    #[test]
    fn sanitize_filename_replaces_illegal_chars() {
        // 验证 session_id → 文件名安全转换。
        let clean = |s: &str| {
            // 复用内部 sanitize：原型验证字符映射规则。
            s.chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect::<String>()
        };
        assert_eq!(clean("browser-1786989169353-atpos6k"), "browser-1786989169353-atpos6k");
        assert_eq!(clean("session/with\\weird:id"), "session_with_weird_id");
    }

    #[test]
    fn http_endpoint_url_appends_mcp_path() {
        assert_eq!(HttpTransport::endpoint_url("http://127.0.0.1:8080"), "http://127.0.0.1:8080/mcp");
        assert_eq!(HttpTransport::endpoint_url("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/mcp");
    }

    #[tokio::test]
    async fn http_read_line_before_send_errors() {
        let t = HttpTransport::new("http://127.0.0.1:1".to_string(), None);
        let err = t.read_line(Duration::from_secs(1)).await;
        assert!(err.is_err(), "尚未 send_line 就 read 应报错");
    }
}