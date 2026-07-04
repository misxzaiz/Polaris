/*! MCP 类型定义（Phase 4b）
 *
 * 镜像 Polaris 现有 MCP server（todo_mcp_server.rs 等）的 JSON-RPC 2.0 帧格式。
 * 协议版本 2025-06-18（client 请求；握手时读 server 返回的 protocolVersion 降级兼容）。
 */

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC 2.0 请求（含 `id`）或通知（`id=None`，server 不应答）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct JsonRpcRequest<'a> {
    pub jsonrpc: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    pub method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// JSON-RPC 2.0 响应。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct JsonRpcResponse {
    /// id 可能是数字或字符串，统一用 Value 接收。
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct JsonRpcError {
    pub code: i64,
    pub message: String,
}

/// MCP 工具定义（`tools/list` 返回项）。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Option<Value>,
}

/// `tools/list` 结果。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ToolsListResult {
    pub tools: Vec<McpTool>,
}

/// `tools/call` 结果。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct McpCallResult {
    #[serde(default)]
    pub content: Vec<McpContentBlock>,
    #[serde(rename = "isError", default)]
    pub is_error: bool,
}

/// MCP content block（仅提取 text；其他类型忽略）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum McpContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    /// 其他类型（image/resource 等）忽略，SimpleAI 工具结果只回传文本。
    #[serde(other)]
    Other,
}

impl McpCallResult {
    /// 拼接所有 text block 为单个字符串。
    pub(crate) fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                McpContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// `initialize` 结果（提取 protocolVersion 协商降级）。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct InitializeResult {
    #[serde(rename = "protocolVersion", default)]
    pub protocol_version: Option<String>,
}
