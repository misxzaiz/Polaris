/*! stdio MCP 客户端（Phase 4b）
 *
 * spawn 子进程，通过 stdin/stdout 交换换行分隔的 JSON-RPC 2.0 消息。
 * 镜像 Polaris 现有 server（`todo_mcp_server.rs` 等）的帧格式：每行一条 JSON。
 *
 * 生命周期：`McpClient::spawn` 完成 initialize 握手 + tools/list 缓存；
 * `call_tool` 发 tools/call；`Drop` 时 kill 子进程。
 *
 * 传输层已抽象：spawn 复用 `StdioTransport::spawn_with_reader`，stdin 写入经
 * `transport.send_line`，stdout 由后台 reader task 按 id 路由。
 */

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::ChildStdout;
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::error::{AppError, Result};

use super::transport::{McpTransport, ProtocolVersion, StdioTransport};
use super::types::{
    InitializeResult, JsonRpcRequest, JsonRpcResponse, McpCallResult, McpTool, ToolsListResult,
};

/// 单次 MCP 请求的默认超时（秒）。
///
/// 生成式工具（如 Agnes 文生图/视频）可能耗时数十秒到数分钟，
/// 30s 过紧；统一放宽到 10 分钟兜底。控制面方法（initialize/tools/list）
/// 实际秒回，不受影响。
const MCP_CALL_TIMEOUT_SECS: u64 = 600;

/// 单个 MCP server 的客户端连接。
pub(crate) struct McpClient {
    server_name: String,
    /// 传输层（Stdio 或 HTTP）。Stdio 经后台 reader 路由，HTTP 走直连请求-响应。
    transport: Arc<dyn McpTransport>,
    next_id: AtomicU64,
    /// pending 请求的 response sender（按 id 路由，仅 stdio 后台 reader 使用；
    /// HTTP 请求-响应直连不依赖）。
    pending: Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    tools: RwLock<Vec<McpTool>>,
}

impl McpClient {
    /// spawn 子进程并完成 initialize 握手 + tools/list。
    pub(crate) async fn spawn(
        server_name: String,
        command: &str,
        args: &[String],
        env: &std::collections::HashMap<String, String>,
    ) -> Result<Self> {
        // 复用 StdioTransport spawn 逻辑，避免重复的 Command 构造/CREATE_NO_WINDOW。
        let (transport, stdout) =
            StdioTransport::spawn_with_reader(server_name.clone(), command, args, env).await?;
        let transport = Arc::new(transport);

        let pending: Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<JsonRpcResponse>>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let pending_clone = Arc::clone(&pending);

        // stdout reader task：逐行读取，按 id 路由到 pending oneshot。
        tokio::spawn(reader_task(stdout, pending_clone));

        let client = Self {
            server_name: server_name.clone(),
            transport,
            next_id: AtomicU64::new(1),
            pending,
            tools: RwLock::new(Vec::new()),
        };

        // initialize 握手（协议 2025-06-18，读 server 返回的 protocolVersion 降级）。
        client.initialize().await?;
        // 拉 tools/list 缓存。
        let tools_list = client.call_method("tools/list", None).await?;
        let result: ToolsListResult = serde_json::from_value(tools_list).map_err(|e| {
            AppError::ProcessError(format!("parse tools/list from '{}': {}", server_name, e))
        })?;
        tracing::info!(
            "[SimpleAI-MCP] '{}' 提供 {} 个工具",
            server_name,
            result.tools.len()
        );
        *client.tools.write().await = result.tools;

        Ok(client)
    }

    async fn initialize(&self) -> Result<()> {
        // 协议版本单一来源：ProtocolVersion::current()。
        let version = ProtocolVersion::current();

        // 2026-07-28 无状态协议：移除 initialize 握手 + notifications/initialized。
        // needs_handshake() 控制是否握手——默认（2025-06-18）照旧握手，零行为变更；
        // 切换 current() 到 V2026_07_28 后自动走无状态路径（跳握手/通知）。
        if !version.needs_handshake() {
            tracing::info!(
                "[SimpleAI-MCP] '{}' 使用无状态协议 {}，跳过 initialize 握手",
                self.server_name,
                version.as_str()
            );
            return Ok(());
        }

        let params = serde_json::json!({
            "protocolVersion": version.as_str(),
            "capabilities": {},
            "clientInfo": { "name": "polaris-simple-ai", "version": "1.0" }
        });
        let result_value = self.call_method("initialize", Some(params)).await?;
        let init: InitializeResult = serde_json::from_value(result_value)
            .map_err(|e| AppError::ProcessError(format!("parse initialize from '{}': {}", self.server_name, e)))?;
        if let Some(pv) = init.protocol_version.as_deref() {
            tracing::info!(
                "[SimpleAI-MCP] '{}' 协商协议版本: {}（client 请求 {}）",
                self.server_name,
                pv,
                version.as_str()
            );
        }
        // 发 notifications/initialized（无 id，无响应）。
        self.send_notification("notifications/initialized", None)
            .await?;
        Ok(())
    }

    /// 发请求并等响应（默认 10 分钟超时，见 `MCP_CALL_TIMEOUT_SECS`）。
    async fn call_method(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: Some(id),
            method,
            params,
        };
        let line = serde_json::to_string(&req)
            .map_err(|e| AppError::ProcessError(format!("serialize jsonrpc request: {}", e)))?;
        // 经由 transport 发送，统一 stdin 写入逻辑。
        self.transport.send_line(&line).await?;

        let response = tokio::time::timeout(Duration::from_secs(MCP_CALL_TIMEOUT_SECS), rx)
            .await
            .map_err(|_| {
                // 超时时清理 pending，避免 sender 泄漏。
                let pending = Arc::clone(&self.pending);
                let id = id;
                tokio::spawn(async move {
                    pending.lock().await.remove(&id);
                });
                AppError::ProcessError(format!(
                    "MCP '{}' method '{}' timeout ({}s)",
                    self.server_name, method, MCP_CALL_TIMEOUT_SECS
                ))
            })?
            .map_err(|_| {
                AppError::ProcessError(format!(
                    "MCP '{}' method '{}' response channel closed",
                    self.server_name, method
                ))
            })?;

        if let Some(err) = response.error {
            return Err(AppError::ProcessError(format!(
                "MCP '{}' method '{}' error ({}): {}",
                self.server_name, method, err.code, err.message
            )));
        }
        response.result.ok_or_else(|| {
            AppError::ProcessError(format!(
                "MCP '{}' method '{}' missing result",
                self.server_name, method
            ))
        })
    }

    async fn send_notification(&self, method: &str, params: Option<Value>) -> Result<()> {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: None,
            method,
            params,
        };
        let line = serde_json::to_string(&req)
            .map_err(|e| AppError::ProcessError(format!("serialize notification: {}", e)))?;
        self.transport.send_line(&line).await
    }

    /// 调用工具。
    pub(crate) async fn call_tool(&self, name: &str, args: &Value) -> Result<McpCallResult> {
        let params = serde_json::json!({ "name": name, "arguments": args });
        let result = self.call_method("tools/call", Some(params)).await?;
        serde_json::from_value(result).map_err(|e| {
            AppError::ProcessError(format!(
                "parse tools/call result from '{}': {}",
                self.server_name, e
            ))
        })
    }

    /// 工具列表快照。
    pub(crate) async fn tools(&self) -> Vec<McpTool> {
        self.tools.read().await.clone()
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // 尽力终止底层资源（stdio kill 子进程；HTTP no-op）。经 transport 同步终止。
        self.transport.shutdown_sync();
    }
}

/// stdout reader task：逐行读 JSON-RPC，按 id 路由到 pending oneshot。
async fn reader_task(
    stdout: ChildStdout,
    pending: Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("[SimpleAI-MCP] stdout read error: {}", e);
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response: JsonRpcResponse = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("[SimpleAI-MCP] 解析响应失败: {} (line: {:?})", e, trimmed);
                continue;
            }
        };
        // 按 id 路由（通知无 id 跳过）。
        let id = response.id.as_ref().and_then(|v| v.as_u64());
        if let Some(id) = id {
            let mut guard = pending.lock().await;
            if let Some(tx) = guard.remove(&id) {
                let _ = tx.send(response);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 无状态化决策：协议版本决定是否跳过 initialize 握手。
    /// 2026-07-28 无状态 → 跳；有状态版本 → 照常握手（零行为变更）。
    #[test]
    fn handshake_skipped_for_stateless_protocol() {
        assert!(ProtocolVersion::V2026_07_28.needs_handshake() == false);
        assert!(ProtocolVersion::V2025_06_18.needs_handshake() == true);
        assert!(ProtocolVersion::V2024_11_05.needs_handshake() == true);
    }

    #[test]
    fn stateless_version_maps_to_string() {
        assert_eq!(ProtocolVersion::V2026_07_28.as_str(), "2026-07-28");
        assert_eq!(
            ProtocolVersion::from_server("2026-07-28"),
            ProtocolVersion::V2026_07_28
        );
    }

    /// reader_task 的路由特征：响应帧按 id 分发到 pending oneshot。
    /// 无 id（通知）跳过。真实 worker 由 CI 集成测试覆盖。
    #[test]
    fn response_id_is_routable_number() {
        let resp: JsonRpcResponse =
            serde_json::from_value(json!({ "id": 42, "result": { "ok": true } })).unwrap();
        let id = resp.id.as_ref().and_then(|v| v.as_u64());
        assert_eq!(id, Some(42));
        assert!(resp.result.is_some());
    }

    #[test]
    fn notification_frame_has_no_id() {
        let notif: JsonRpcResponse = serde_json::from_value(json!({ "jsonrpc": "2.0" })).unwrap();
        assert!(notif.id.is_none());

        // 与 mock 适配器 engine.js 发送的帧一致：事件帧不带 id。
        let event_frame: Value = json!({
            "event": "ai_event", "type": "session_end", "session_id": "s1"
        });
        assert!(event_frame.get("id").is_none());
    }
}
