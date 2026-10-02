//! MCP Server 共享基础设施
//!
//! 提供所有内置 MCP server 共用的 JSON-RPC 2.0 类型定义、主循环和请求分发骨架。
//! 各 server 只需实现 `McpServerHandler` trait 的两个方法（tools_list / tools_call），
//! 通过 `run_mcp_server_loop` 启动，避免每个 server 重复 ~80 行样板代码。

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

use crate::error::{AppError, Result};

/// MCP 协议版本（所有内置 server 统一）。
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// JSON-RPC 2.0 请求。
#[derive(Debug, serde::Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// JSON-RPC 2.0 响应。
#[derive(Debug, serde::Serialize)]
pub struct JsonRpcResponse<'a> {
    pub jsonrpc: &'a str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC 2.0 错误。
#[derive(Debug, serde::Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

/// 构造错误响应。
pub fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

/// 构造成功响应。
pub fn ok_response(id: Value, result: Value) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(result),
        error: None,
    }
}

/// MCP 工具定义辅助。
pub fn tool_def(name: &str, description: &str, required: &[&str], properties: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "required": required,
            "properties": properties,
        }
    })
}

/// 将业务文本包装为 MCP tools/call 返回格式。
pub fn tool_text(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }]
    })
}

/// MCP server handler trait：各 server 只需实现这两个方法。
pub trait McpServerHandler {
    /// server 名称（用于 serverInfo）。
    fn server_name(&self) -> &str;
    /// server 版本（用于 serverInfo）。
    fn server_version(&self) -> &str;
    /// 返回 tools/list 结果。
    fn tools_list(&self) -> Value;
    /// 处理 tools/call，返回 MCP content 格式。
    fn tools_call(&self, name: &str, arguments: &Value) -> Result<Value>;
}

/// 运行 MCP server 主循环（stdio JSON-RPC）。
///
/// `handler` 实现 `McpServerHandler`，提供 tools_list / tools_call。
/// 主循环负责 stdin 逐行读取、JSON-RPC 分发、stdout 写回。
pub fn run_mcp_server_loop<H: McpServerHandler>(handler: H) -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = io::BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            // JSON-RPC 2.0 §4.1: a Notification is a Request without an `id`
            // field. The server MUST NOT reply to notifications.
            Ok(request) if request.id.is_none() => continue,
            Ok(request) => handle_request(&request, &handler),
            Err(error) => error_response(Value::Null, -32700, format!("Parse error: {error}")),
        };

        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    Ok(())
}

/// 分发 JSON-RPC 请求到 handler 方法。
fn handle_request<H: McpServerHandler>(request: &JsonRpcRequest, handler: &H) -> JsonRpcResponse<'static> {
    let id = request.id.clone().unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".into());
    }

    let result: Result<Value> = (|| {
        match request.method.as_str() {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": handler.server_name(), "version": handler.server_version() }
            })),
            "notifications/initialized" => Ok(json!({})),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(handler.tools_list()),
            "tools/call" => {
                let name = request
                    .params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".into()))?;
                let arguments = request.params.get("arguments").cloned().unwrap_or(Value::Null);
                handler.tools_call(name, &arguments)
            }
            _ => Err(AppError::ValidationError(format!(
                "Unsupported method: {}",
                request.method
            ))),
        }
    })();

    match result {
        Ok(result) => ok_response(id, result),
        Err(error) => error_response(id, -32000, error.to_message()),
    }
}
