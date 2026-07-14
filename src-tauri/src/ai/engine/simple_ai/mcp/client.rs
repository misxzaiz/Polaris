/*! stdio MCP 客户端（Phase 4b）
 *
 * spawn 子进程，通过 stdin/stdout 交换换行分隔的 JSON-RPC 2.0 消息。
 * 镜像 Polaris 现有 server（`todo_mcp_server.rs` 等）的帧格式：每行一条 JSON。
 *
 * 生命周期：`McpClient::spawn` 完成 initialize 握手 + tools/list 缓存；
 * `call_tool` 发 tools/call；`Drop` 时 kill 子进程。
 */

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::error::{AppError, Result};

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
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: AtomicU64,
    /// pending 请求的 response sender（按 id 路由）。
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
            // CREATE_NO_WINDOW：避免子进程弹窗（tokio Command 在 Windows 上原生支持 creation_flags）。
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

        let pending: Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<JsonRpcResponse>>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let pending_clone = Arc::clone(&pending);

        // stdout reader task：逐行读取，按 id 路由到 pending oneshot。
        tokio::spawn(reader_task(stdout, pending_clone));

        let client = Self {
            server_name: server_name.clone(),
            child,
            stdin: Arc::new(Mutex::new(stdin)),
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
        let params = serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "polaris-simple-ai", "version": "1.0" }
        });
        let result_value = self.call_method("initialize", Some(params)).await?;
        let init: InitializeResult = serde_json::from_value(result_value).map_err(|e| {
            AppError::ProcessError(format!(
                "parse initialize from '{}': {}",
                self.server_name, e
            ))
        })?;
        if let Some(pv) = init.protocol_version.as_deref() {
            tracing::info!(
                "[SimpleAI-MCP] '{}' 协商协议版本: {}（client 请求 2025-06-18）",
                self.server_name,
                pv
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
        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| AppError::ProcessError(format!("write to MCP stdin: {}", e)))?;
            stdin.write_all(b"\n").await.map_err(|e| {
                AppError::ProcessError(format!("write newline to MCP stdin: {}", e))
            })?;
            stdin
                .flush()
                .await
                .map_err(|e| AppError::ProcessError(format!("flush MCP stdin: {}", e)))?;
        }

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
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| AppError::ProcessError(format!("write notification: {}", e)))?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
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
        // 尽力 kill 子进程；忽略错误。
        let _ = self.child.start_kill();
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
